// spark-router: a small local router that lets ONE Claude Code session use both your Claude
// plan models and a local model on another machine (your "AI server").
//
// The one rule:
//   * A request whose JSON body names a LOCAL model goes to the local model server that serves
//     that model (for example vLLM, or anything that serves the Anthropic Messages API), with
//     that server's key. You can name more than one server; each model belongs to one server.
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
import { StringDecoder } from 'node:string_decoder';
import { ANTHROPIC_URL, HEALTH_PATH } from './config.js';
import { clampBoxEffort } from './effort.js';
import {
  anthropicToOpenAIRequest, createStreamTranslator, openAIToAnthropicResponse,
} from './openai-translate.js';

/**
 * Starts the router on 127.0.0.1.
 * @param {object} options
 * @param {number} options.port - TCP port; 0 picks a free port (for tests)
 * @param {{name: string, url: string, models: string[], type: 'anthropic' | 'openai',
 *   key: string}[]} options.servers - the local servers. A request for one of a server's models
 *   (any case) goes to that server, with its key (never logged). For a server of type 'openai'
 *   the request is translated to POST /v1/chat/completions and the answer is translated back
 *   (see openai-translate.js). Each model name must belong to one server.
 *   The first server is the one the health answer reports as local_model_server.
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
    anthropicUrl = ANTHROPIC_URL,
    clampEffort = clampBoxEffort,
    log = createLogger(),
    maxBodyBytes = 256 * 1024 * 1024,
  } = options;
  const { servers } = options;
  // Lower-case model name -> the server that serves it.
  const serverByModel = new Map();
  for (const entry of servers) {
    for (const modelName of entry.models) {
      serverByModel.set(modelName.toLowerCase(), entry);
    }
  }

  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te',
    'trailer', 'upgrade', 'host', 'content-length', 'expect'
  ]);
  const CLAUDE_CREDENTIALS = new Set(['authorization', 'x-api-key', 'cookie']);

  // The openai path: translate the Anthropic request to POST /v1/chat/completions, send it,
  // and translate the answer back. The target is the server's origin plus a FIXED path: the
  // path of the request is never used. Nothing from the message is written to the log.
  const forwardOpenAI = ({ req, res, body, localServer, pathname, modelLog, dest, start }) => {
    const elapsed = () => `${Date.now() - start} ms`;
    const logDone = () => {
      log.info(`${req.method} ${pathname} model=${modelLog} -> ${dest} 200 ${elapsed()}`);
    };
    const fail = (status, message, note) => {
      log.warn(`${req.method} ${pathname} model=${modelLog} -> ${dest} FAILED (${note}) ` +
        elapsed());
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(errorJson(message));
      } else {
        res.destroy();
      }
    };
    const serverLabel = `the local server '${localServer.name}'`;

    if (pathname.toLowerCase() !== '/v1/messages') {
      fail(501, `spark-router cannot translate ${pathname} for ${serverLabel}, which uses the ` +
        'OpenAI API', 'path not translated');
      return;
    }
    let openAIBody;
    try {
      openAIBody = anthropicToOpenAIRequest(JSON.parse(body.toString('utf8')));
    } catch {
      fail(502, `spark-router could not translate the request for ${serverLabel}`,
        'request not translated');
      return;
    }
    const wantStream = openAIBody.stream === true;
    if (wantStream) {
      // Ask for the token counts: OpenAI servers send them in the last chunk only on request.
      openAIBody.stream_options = { include_usage: true };
    }
    const outBody = Buffer.from(JSON.stringify(openAIBody), 'utf8');

    const target = new URL(new URL(localServer.url).origin + '/v1/chat/completions');
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (!HOP_BY_HOP.has(lowerKey) && !CLAUDE_CREDENTIALS.has(lowerKey)) {
        headers[lowerKey] = value;
      }
    }
    headers['content-type'] = 'application/json';
    headers['accept'] = wantStream ? 'text/event-stream' : 'application/json';
    headers['accept-encoding'] = 'identity';
    headers['authorization'] = `Bearer ${localServer.key}`;
    headers['content-length'] = String(outBody.length);

    const agent = (target.protocol === 'https:' ? httpsAgent : httpAgent);
    const upstreamReq = (target.protocol === 'https:' ? https : http).request(
      target,
      { method: 'POST', headers, agent }
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
      fail(502, `spark-router could not reach the local model server '${localServer.name}': ` +
        error.message, error.message);
    });

    // Not a stream: read the whole JSON answer, then send it as an Anthropic message.
    const relayJson = (upstreamRes) => {
      const parts = [];
      upstreamRes.on('data', (chunk) => parts.push(chunk));
      upstreamRes.on('error', (err) => {
        if (!requestAborted) {
          fail(502, `${serverLabel} stopped answering`, err.message || 'aborted');
        }
      });
      upstreamRes.on('end', () => {
        if (requestAborted) {
          return;
        }
        let answer;
        try {
          answer = JSON.stringify(
            openAIToAnthropicResponse(JSON.parse(Buffer.concat(parts).toString('utf8')))
          );
        } catch {
          fail(502, `spark-router could not translate the answer of ${serverLabel}`,
            'answer not translated');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(answer);
        logDone();
      });
    };

    // A stream: split the upstream into "data:" lines, translate each, write the events.
    const relayStream = (upstreamRes) => {
      const translator = createStreamTranslator();
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let finished = false;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();

      // Ends the stream with an Anthropic error event. The message holds no message text.
      const stop = (message, note) => {
        if (finished) {
          return;
        }
        finished = true;
        log.warn(`${req.method} ${pathname} model=${modelLog} -> ${dest} FAILED (${note}) ` +
          elapsed());
        res.write(`event: error\ndata: ${errorJson(message)}\n\n`);
        res.end();
        upstreamReq.destroy();
      };
      const handleLine = (line) => {
        const text = line.trim();
        if (!text.startsWith('data:')) {
          return;
        }
        const payload = text.slice(5).trim();
        if (payload === '' || payload === '[DONE]') {
          return;
        }
        for (const event of translator.push(JSON.parse(payload))) {
          res.write(event);
        }
      };

      upstreamRes.on('data', (chunk) => {
        if (finished || requestAborted) {
          return;
        }
        try {
          pending += decoder.write(chunk);
          let newline = pending.indexOf('\n');
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            handleLine(line);
            newline = pending.indexOf('\n');
          }
        } catch {
          stop(`spark-router could not translate the answer of ${serverLabel}`,
            'answer not translated');
        }
      });
      upstreamRes.on('error', (err) => {
        if (!requestAborted) {
          stop(`${serverLabel} stopped answering`, err.message || 'aborted');
        }
      });
      upstreamRes.on('end', () => {
        if (finished || requestAborted) {
          return;
        }
        try {
          pending += decoder.end();
          handleLine(pending);
        } catch {
          stop(`spark-router could not translate the answer of ${serverLabel}`,
            'answer not translated');
          return;
        }
        finished = true;
        for (const event of translator.end()) {
          res.write(event);
        }
        res.end();
        logDone();
      });
    };

    upstreamReq.on('response', (upstreamRes) => {
      if (requestAborted) {
        return;
      }
      const status = upstreamRes.statusCode;
      if (status < 200 || status >= 300) {
        upstreamRes.resume();
        const outStatus = status >= 400 && status <= 599 ? status : 502;
        fail(outStatus, `${serverLabel} answered HTTP ${status}`, `HTTP ${status}`);
        return;
      }
      if (wantStream) {
        relayStream(upstreamRes);
      } else {
        relayJson(upstreamRes);
      }
    });

    upstreamReq.write(outBody);
    upstreamReq.end();
  };

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
        const results = await Promise.all(servers.map((entry) => probeServer(entry.url)));
        const serverHealth = Object.fromEntries(servers.map((entry, index) => {
          return [entry.name, results[index] ? 'ok' : 'unreachable'];
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          router: 'ok',
          local_model_server: results[0] ? 'ok' : 'unreachable',
          servers: serverHealth
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
      const localServer = model === null ? undefined : serverByModel.get(model.toLowerCase());
      const toBox = localServer !== undefined;
      const dest = toBox ? logSafe(localServer.name) : 'anthropic';
      const modelLog = model === null ? '-' : logSafe(model);
      if (toBox && localServer.type === 'openai') {
        forwardOpenAI({ req, res, body, localServer, pathname, modelLog, dest, start });
        return;
      }
      const target = new URL(
        new URL(toBox ? localServer.url : anthropicUrl).origin + pathAndQuery
      );

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
        headers['authorization'] = `Bearer ${localServer.key}`;
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
          const targetName = toBox
            ? `the local model server '${dest}'`
            : 'api.anthropic.com';
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
      const routes = servers.map((entry) => {
        return `${entry.name}: ${entry.models.join(',')} -> ${new URL(entry.url).origin}`;
      }).join(' | ');
      const logMsg = `spark-router on http://127.0.0.1:${actualPort} | ${routes} | ` +
        `everything else -> ${anthropicUrl}`;
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

// True when the server answers GET /health with a 2xx status within 3 seconds. Never throws.
function probeServer(baseUrl) {
  return new Promise((resolve) => {
    let ok = false;
    let probeReq;
    try {
      const healthUrl = new URL('/health', baseUrl);
      probeReq = (healthUrl.protocol === 'https:' ? https : http).request(
        healthUrl,
        { method: 'GET', headers: {} }
      );
    } catch {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      probeReq.destroy();
    }, 3000);
    probeReq.on('response', (upstreamRes) => {
      ok = upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300;
      upstreamRes.resume();
      clearTimeout(timeout);
      resolve(ok);
    });
    probeReq.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
    probeReq.on('close', () => {
      clearTimeout(timeout);
      resolve(ok);
    });
    probeReq.end();
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
