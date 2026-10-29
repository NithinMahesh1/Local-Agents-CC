// spark-router: a small local router that lets ONE Claude Code session use both your Claude
// plan models and a local model on another machine (your "AI server").
//
// The one rule:
//   * A request whose JSON body names a LOCAL model goes to your local model server (for
//     example vLLM, or anything that serves the Anthropic Messages API), with the AI server's key.
//   * Every other request goes to https://api.anthropic.com UNCHANGED, so the claude.ai login
//     that Claude Code sends keeps working and your plan pays.
//
// Safety rules built in:
//   * Listens on 127.0.0.1 only, and answers only requests addressed to 127.0.0.1 or localhost.
//   * Your Claude login headers are removed before a request goes to the AI server.
//   * The AI server's API key is read from a file: never in this code, never logged.
//   * Each log line shows method, path, model, destination, status and time: never headers,
//     never query strings, never message text.
//
import http from 'node:http';
import https from 'node:https';
import { ANTHROPIC_URL, HEALTH_PATH, isLocalModel } from './config.js';
import { clampBoxEffort } from './effort.js';

/**
 * Starts the router on 127.0.0.1.
 * @param {object} options
 * @param {number} options.port - TCP port; 0 picks a free port (for tests)
 * @param {string[]} options.localModels - model names that go to the AI server (any case)
 * @param {string} options.localUrl - the AI server's base URL, for example
 *   http://your-ai-server.local:8000
 * @param {string} options.boxKey - the AI server's API key; sent only to the AI server, never
 *   logged
 * @param {string} [options.anthropicUrl] - default ANTHROPIC_URL; tests pass a local server
 * @param {(body: Buffer) => { body: Buffer, clamped: boolean }} [options.clampEffort]
 *   - default clampBoxEffort; called only for AI server requests
 * @param {{ info: (message: string) => void, warn: (message: string) => void }} [options.log]
 *   - default createLogger()
 * @param {number} [options.maxBodyBytes] - largest request body; default 256 MiB
 * @returns {Promise<import('node:http').Server>} resolves when the server listens; rejects
 *   on a listen error (for example EADDRINUSE)
 */
export async function startRouter(options) {
  const {
    port,
    localModels,
    localUrl,
    boxKey,
    anthropicUrl = ANTHROPIC_URL,
    clampEffort = clampBoxEffort,
    log = createLogger(),
    maxBodyBytes = 256 * 1024 * 1024,
  } = options;

  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te',
    'trailer', 'upgrade', 'host', 'content-length', 'expect'
  ]);
  const CLAUDE_CREDENTIALS = new Set(['authorization', 'x-api-key', 'cookie']);

  const handler = async (req, res) => {
    const start = Date.now();
    try {
      // 1. The request path. A request line with a URL that cannot be parsed gets 400.
      let url;
      try {
        url = new URL(req.url, 'http://127.0.0.1');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(errorJson('the request URL is not valid'));
        return;
      }
      const pathname = url.pathname;
      const pathAndQuery = url.pathname + url.search;

      // 2. Host check
      const host = (req.headers.host ?? '').toLowerCase();
      const listenPort = server.address().port;
      const allowedHosts = [
        '127.0.0.1', 'localhost', `127.0.0.1:${listenPort}`, `localhost:${listenPort}`
      ];
      if (!allowedHosts.includes(host)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(errorJson(
          'spark-router accepts only requests addressed to 127.0.0.1 or localhost'
        ));
        return;
      }

      // 3. Health
      if (pathname === HEALTH_PATH) {
        const healthUrl = new URL('/health', localUrl);
        const probeReq = (healthUrl.protocol === 'https:' ? https : http).request(
          healthUrl,
          { method: 'GET', headers: {} }
        );

        let boxOk = false;
        const probePromise = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            probeReq.destroy();
          }, 3000);

          probeReq.on('response', (upstreamRes) => {
            clearTimeout(timeout);
            if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300) {
              boxOk = true;
            }
            upstreamRes.resume();
            resolve();
          });
          probeReq.on('error', () => {
            clearTimeout(timeout);
            boxOk = false;
            resolve();
          });
          probeReq.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        probeReq.end();
        await probePromise;

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          router: 'ok',
          local_model_server: boxOk ? 'ok' : 'unreachable'
        }));
        return;
      }

      // 4. Read body
      const chunks = [];
      let bodyLength = 0;
      let bodyTooLarge = false;
      for await (const chunk of req) {
        if (bodyLength + chunk.length > maxBodyBytes) {
          bodyTooLarge = true;
        } else {
          chunks.push(chunk);
          bodyLength += chunk.length;
        }
      }
      const body = Buffer.concat(chunks);

      if (bodyTooLarge) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(errorJson(`request body is larger than ${maxBodyBytes} bytes`));
        return;
      }

      // 5. Model
      let model = null;
      const isMessagesPath = pathname.toLowerCase() === '/v1/messages' ||
        pathname.toLowerCase().startsWith('/v1/messages/');
      const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const isJson = mediaType === 'application/json' || mediaType.endsWith('+json');

      if (req.method === 'POST' && isMessagesPath && isJson && body.length > 0) {
        try {
          const json = JSON.parse(body.toString('utf8'));
          if (json !== null && typeof json === 'object' &&
            !Array.isArray(json) && typeof json.model === 'string') {
            model = json.model;
          }
        } catch {
          // model remains null
        }
      }

      // 6. Dest. The target is the origin plus the path, never new URL(path, base): a path
      // that starts with "//" (for example from "/a/..//other.host/") would name another host.
      const toBox = model !== null && isLocalModel(localModels, model);
      const dest = toBox ? 'LOCAL' : 'anthropic';
      const modelLog = model === null ? '-' : logSafe(model);
      const target = new URL(new URL(toBox ? localUrl : anthropicUrl).origin + pathAndQuery);

      // 7. Clamp
      let outBody = body;
      let clamped = false;
      if (toBox && body.length > 0) {
        const result = clampEffort(body);
        outBody = result.body;
        clamped = result.clamped;
      }

      // 8. Outgoing headers
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (!HOP_BY_HOP.has(lowerKey)) {
          headers[lowerKey] = value;
        }
      }
      if (toBox) {
        for (const cred of CLAUDE_CREDENTIALS) {
          delete headers[cred];
        }
        headers['authorization'] = `Bearer ${boxKey}`;
      }
      if (outBody.length > 0) {
        headers['content-length'] = String(outBody.length);
      }

      // 9. Send
      const agent = (target.protocol === 'https:' ? httpsAgent : httpAgent);
      const upstreamReq = (target.protocol === 'https:' ? https : http).request(
        target,
        { method: req.method, headers, agent }
      );

      let requestAborted = false;
      upstreamReq.on('socket', (socket) => {
        if (socket.connecting) {
          const timeout = setTimeout(() => {
            upstreamReq.destroy(new Error('could not connect within 15 s'));
          }, 15000);
          socket.once('connect', () => {
            clearTimeout(timeout);
          });
        }
      });

      res.on('close', () => {
        if (!res.writableFinished) {
          requestAborted = true;
          upstreamReq.destroy();
        }
      });

      upstreamReq.on('error', (error) => {
        if (requestAborted) {
          return;
        }
        const errMsg = `${req.method} ${pathname} model=${modelLog} -> ${dest} FAILED ` +
          `(${error.message}) ${Date.now() - start} ms`;
        log.warn(errMsg);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          const targetName = toBox ? 'the local model server' : 'api.anthropic.com';
          res.end(errorJson(`spark-router could not reach ${targetName}: ${error.message}`));
        } else {
          res.destroy();
        }
      });

      upstreamReq.on('response', (upstreamRes) => {
        if (requestAborted) {
          return;
        }

        const resHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lowerKey = key.toLowerCase();
          if (!HOP_BY_HOP.has(lowerKey)) {
            resHeaders[lowerKey] = value;
          }
        }

        res.writeHead(upstreamRes.statusCode, resHeaders);
        res.flushHeaders();
        upstreamRes.pipe(res);

        upstreamRes.on('end', () => {
          if (requestAborted) {
            return;
          }
          const clampedStr = clamped ? ' effort=high(clamped)' : '';
          const infoMsg = `${req.method} ${pathname} model=${modelLog}${clampedStr} -> ` +
            `${dest} ${upstreamRes.statusCode} ${Date.now() - start} ms`;
          log.info(infoMsg);
        });

        const handleError = (err) => {
          if (requestAborted) {
            return;
          }
          res.destroy();
          const errMsg = `${req.method} ${pathname} model=${modelLog} -> ${dest} FAILED ` +
            `(${err.message || 'aborted'}) ${Date.now() - start} ms`;
          log.warn(errMsg);
        };

        upstreamRes.on('error', handleError);
      });

      if (outBody.length > 0) {
        upstreamReq.write(outBody);
      }
      upstreamReq.end();
    } catch (err) {
      log.warn(err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(errorJson('spark-router internal error'));
      } else {
        res.destroy();
      }
    }
  };

  const server = http.createServer(handler);
  server.on('clientError', (error, socket) => socket.destroy());
  // Close the kept-alive upstream connections when the router stops.
  server.on('close', () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  });

  return new Promise((resolve, reject) => {
    const onListening = () => {
      const actualPort = server.address().port;
      const origin = new URL(localUrl).origin;
      const logMsg = `spark-router on http://127.0.0.1:${actualPort} | ` +
        `${localModels.join(',')} -> ${origin} | everything else -> ${anthropicUrl}`;
      log.info(logMsg);
      resolve(server);
    };
    const onError = (error) => {
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, '127.0.0.1');
  });
}

// Text from a request (the model name) with its control characters replaced by "?", so it
// cannot add lines to the log.
function logSafe(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, '?');
}

/**
 * An error body in the same shape as Anthropic's errors, so Claude Code shows the message:
 * {"type":"error","error":{"type":"api_error","message":"<message>"}}
 * @param {string} message
 * @returns {string}
 */
export function errorJson(message) {
  return JSON.stringify({ type: 'error', error: { type: 'api_error', message } });
}

/**
 * A logger that writes one line per call: "HH:MM:SS info: <message>" or
 * "HH:MM:SS warn: <message>" (local time, 24-hour clock).
 * @param {{ write: (text: string) => unknown }} [stream] - default process.stdout
 * @returns {{ info: (message: string) => void, warn: (message: string) => void }}
 */
export function createLogger(stream = process.stdout) {
  const log = (level, message) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    stream.write(`${hh}:${mm}:${ss} ${level}: ${message}\n`);
  };
  return {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
  };
}
