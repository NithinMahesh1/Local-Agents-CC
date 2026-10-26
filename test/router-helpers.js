// Shared helpers for the router tests: fake upstream servers, a router on a free port, and
// plain HTTP requests. Everything listens on 127.0.0.1 with a free port (never 8799).
// withRouter() always closes the router and both fake servers, also when a test fails, so no
// test leaves a server or a connection open.

import http from 'node:http';
import net from 'node:net';

import { startRouter } from '../src/router.js';

export const BOX_KEY = 'test-box-key';
export const LOCAL_MODEL = 'local-model';

/**
 * @typedef {{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders,
 *   body: Buffer }} RecordedRequest
 * @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *   body: Buffer) => void | Promise<void>} Respond
 */

// The default answer of a fake server: 200 with {"ok":true}.
function defaultRespond(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
}

/**
 * Closes a server and every connection it still has.
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Starts a fake upstream server (a box or Anthropic). It records every request, with its full
 * body, before it calls respond.
 * @param {Respond} [respond]
 * @returns {Promise<{ url: string, port: number, requests: RecordedRequest[],
 *   close: () => Promise<void> }>}
 */
export async function startFake(respond = defaultRespond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    await respond(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => closeServer(server) };
}

/**
 * A port on 127.0.0.1 that nothing listens on right now.
 * @returns {Promise<number>}
 */
export async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await closeServer(server);
  return port;
}

/**
 * Runs fn with a router between two fake servers (box and Anthropic), then closes all three.
 * The router routes LOCAL_MODEL to the box with BOX_KEY. Its log lines are collected in
 * logLines as "info: <message>" or "warn: <message>".
 * @param {{ box?: Respond, anthropic?: Respond, router?: object }} options - router: options
 *   for startRouter that replace the defaults (for example localUrl or maxBodyBytes)
 * @param {(context: { url: string, port: number, box: Awaited<ReturnType<typeof startFake>>,
 *   anthropic: Awaited<ReturnType<typeof startFake>>, logLines: string[] }) => Promise<void>} fn
 * @returns {Promise<void>}
 */
export async function withRouter({ box, anthropic, router: routerOptions = {} }, fn) {
  const fakeBox = await startFake(box);
  const fakeAnthropic = await startFake(anthropic);
  const logLines = [];
  const log = {
    info: (message) => logLines.push(`info: ${message}`),
    warn: (message) => logLines.push(`warn: ${message}`),
  };
  let server = null;
  try {
    server = await startRouter({
      port: 0,
      localModels: [LOCAL_MODEL],
      localUrl: fakeBox.url,
      boxKey: BOX_KEY,
      anthropicUrl: fakeAnthropic.url,
      log,
      ...routerOptions,
    });
    const { port } = server.address();
    await fn({ url: `http://127.0.0.1:${port}`, port, box: fakeBox, anthropic: fakeAnthropic,
      logLines });
  } finally {
    if (server !== null) {
      await closeServer(server);
    }
    await fakeBox.close();
    await fakeAnthropic.close();
  }
}

/**
 * Sends one request on a new connection (no keep-alive) and reads the whole answer.
 * body: an object is sent as JSON with content-type application/json (unless headers set a
 * content-type); a string or Buffer is sent as it is.
 * @param {string} url - the router's base URL, for example http://127.0.0.1:12345
 * @param {{ method?: string, path?: string, headers?: Record<string, string>,
 *   body?: object | string | Buffer }} [options] - default: POST /v1/messages
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders,
 *   body: string }>}
 */
export function send(url, { method = 'POST', path = '/v1/messages', headers = {}, body } = {}) {
  let payload = null;
  const allHeaders = { ...headers };
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    if (!Object.keys(allHeaders).some((name) => name.toLowerCase() === 'content-type')) {
      allHeaders['content-type'] = 'application/json';
    }
  }
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    const req = http.request(
      { hostname, port, method, path, headers: allHeaders, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

/**
 * Sends raw bytes to 127.0.0.1:port and returns all text that comes back until the server
 * closes the connection, or 2 seconds pass.
 * @param {number} port
 * @param {string} text - for example 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'
 * @returns {Promise<string>}
 */
export function sendRaw(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let answer = '';
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      answer += chunk;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(answer);
    });
    socket.write(text);
  });
}
