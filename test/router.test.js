// Tests for a router with more than one local server. Every server is a fake upstream on
// 127.0.0.1 with a free port (never 8799).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startRouter } from '../src/router.js';
import { closeServer, freePort, send, startFake } from './router-helpers.js';

const CLAUDE_HEADERS = {
  authorization: 'Bearer claude-login',
  'x-api-key': 'claude-api-key',
  cookie: 'session=claude-cookie',
};

// Runs fn with a router, two fake local servers (type options come from the arguments) and a
// fake Anthropic. Closes everything afterwards, also when fn throws.
async function withServers({ typeB = 'anthropic', spark, desktop } = {}, fn) {
  const fakeA = await startFake(spark);
  const fakeB = await startFake(desktop);
  const fakeAnthropic = await startFake();
  const logLines = [];
  const log = {
    info: (message) => logLines.push(`info: ${message}`),
    warn: (message) => logLines.push(`warn: ${message}`),
  };
  let router = null;
  try {
    router = await startRouter({
      port: 0,
      servers: [
        { name: 'spark', url: fakeA.url, models: ['spark-coder'], type: 'anthropic', key: 'key-A' },
        { name: 'desktop', url: fakeB.url, models: ['Desktop-Docs'], type: typeB, key: 'key-B' },
      ],
      anthropicUrl: fakeAnthropic.url,
      log,
    });
    const url = `http://127.0.0.1:${router.address().port}`;
    await fn({ url, port: router.address().port, a: fakeA, b: fakeB, anthropic: fakeAnthropic,
      logLines });
  } finally {
    if (router !== null) {
      await closeServer(router);
    }
    await fakeA.close();
    await fakeB.close();
    await fakeAnthropic.close();
  }
}

describe('router with more than one server', () => {
  it('sends a model to its own server with that server key and no Claude login', async () => {
    await withServers({}, async ({ url, a, b, anthropic }) => {
      const first = await send(url, {
        headers: CLAUDE_HEADERS,
        body: { model: 'spark-coder', messages: [] },
      });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(a.requests.length, 1);
      assert.strictEqual(a.requests[0].headers.authorization, 'Bearer key-A');
      assert.strictEqual(a.requests[0].headers['x-api-key'], undefined);
      assert.strictEqual(a.requests[0].headers.cookie, undefined);

      const second = await send(url, {
        headers: CLAUDE_HEADERS,
        body: { model: 'DESKTOP-docs', messages: [] },
      });
      assert.strictEqual(second.status, 200);
      assert.strictEqual(b.requests.length, 1);
      assert.strictEqual(b.requests[0].headers.authorization, 'Bearer key-B');
      assert.strictEqual(b.requests[0].headers['x-api-key'], undefined);
      assert.strictEqual(b.requests[0].headers.cookie, undefined);

      assert.strictEqual(a.requests.length, 1);
      assert.strictEqual(anthropic.requests.length, 0);
    });
  });

  it('sends an unknown model and a missing model to Anthropic with the login kept', async () => {
    await withServers({}, async ({ url, a, b, anthropic }) => {
      await send(url, { headers: CLAUDE_HEADERS, body: { model: 'claude-x' } });
      await send(url, { headers: CLAUDE_HEADERS, body: { messages: [] } });
      await send(url, { headers: CLAUDE_HEADERS, body: 'not json' });
      assert.strictEqual(anthropic.requests.length, 3);
      for (const request of anthropic.requests) {
        assert.strictEqual(request.headers.authorization, CLAUDE_HEADERS.authorization);
        assert.strictEqual(request.headers['x-api-key'], CLAUDE_HEADERS['x-api-key']);
        assert.strictEqual(request.headers.cookie, CLAUDE_HEADERS.cookie);
      }
      assert.strictEqual(a.requests.length + b.requests.length, 0);
    });
  });

  it('answers 502 for an openai server and does not forward the request', async () => {
    await withServers({ typeB: 'openai' }, async ({ url, a, b, anthropic, logLines }) => {
      const { status, body } = await send(url, {
        headers: CLAUDE_HEADERS,
        body: { model: 'desktop-docs', messages: [{ role: 'user', content: 'secret text' }] },
      });
      assert.strictEqual(status, 502);
      assert.strictEqual(
        JSON.parse(body).error.message,
        "the local server 'desktop' uses the OpenAI API; spark-router cannot translate to it yet",
      );
      assert.strictEqual(a.requests.length + b.requests.length + anthropic.requests.length, 0);
      const warns = logLines.filter((line) => line.startsWith('warn:'));
      assert.strictEqual(warns.length, 1);
      const all = logLines.join('\n');
      for (const secret of ['secret text', 'key-A', 'key-B', 'claude-login', 'claude-cookie']) {
        assert.strictEqual(all.includes(secret), false, secret);
      }
    });
  });

  it('still forwards to the anthropic server when another server is openai', async () => {
    await withServers({ typeB: 'openai' }, async ({ url, a }) => {
      const { status } = await send(url, { body: { model: 'spark-coder' } });
      assert.strictEqual(status, 200);
      assert.strictEqual(a.requests.length, 1);
    });
  });

  it('logs the server name as the destination, without secrets', async () => {
    await withServers({}, async ({ url, logLines }) => {
      await send(url, {
        path: '/v1/messages?token=query-secret',
        headers: CLAUDE_HEADERS,
        body: { model: 'desktop-docs' },
      });
      await send(url, { body: { model: 'claude-x' } });
      const all = logLines.join('\n');
      assert.match(all, /model=desktop-docs -> desktop 200 \d+ ms/);
      assert.match(all, /model=claude-x -> anthropic 200 \d+ ms/);
      assert.match(all, /spark: spark-coder -> http:\/\/127\.0\.0\.1:\d+/);
      for (const secret of ['query-secret', 'key-A', 'key-B', 'claude-login', 'claude-cookie']) {
        assert.strictEqual(all.includes(secret), false, secret);
      }
    });
  });

  it('blocks a request with a foreign Host header', async () => {
    await withServers({}, async ({ url, a, b, anthropic }) => {
      const { status } = await send(url, {
        headers: { host: 'evil.example' },
        body: { model: 'spark-coder' },
      });
      assert.strictEqual(status, 403);
      assert.strictEqual(a.requests.length + b.requests.length + anthropic.requests.length, 0);
    });
  });

  it('keeps the destination host for a path that tries to change it', async () => {
    await withServers({}, async ({ url, a, b, anthropic }) => {
      const path = '/a/..//evil.example/x';
      await send(url, { path, body: { model: 'spark-coder' } });
      await send(url, { path, body: { model: 'desktop-docs' } });
      await send(url, { path, body: { model: 'claude-x' } });
      // The model is read only on /v1/messages, so all three go to Anthropic: and the request
      // reaches the fixed Anthropic address, not the host named in the path.
      assert.strictEqual(a.requests.length + b.requests.length, 0);
      assert.strictEqual(anthropic.requests.length, 3);
      for (const request of anthropic.requests) {
        assert.strictEqual(request.url, '//evil.example/x');
        assert.strictEqual(request.headers.host.startsWith('127.0.0.1:'), true);
      }
    });
  });

  it('reads the model only from a JSON body on /v1/messages', async () => {
    await withServers({}, async ({ url, a, anthropic }) => {
      await send(url, {
        path: '/v1/other',
        body: { model: 'spark-coder' },
      });
      await send(url, {
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ model: 'spark-coder' }),
      });
      assert.strictEqual(a.requests.length, 0);
      assert.strictEqual(anthropic.requests.length, 2);
    });
  });

  it('reports the health of every server and of the first one as local_model_server', async () => {
    await withServers({}, async ({ url }) => {
      const { status, body } = await send(url, { method: 'GET', path: '/__spark-router/health' });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(JSON.parse(body), {
        router: 'ok',
        local_model_server: 'ok',
        servers: { spark: 'ok', desktop: 'ok' },
      });
    });
  });

  it('reports a server that is down as unreachable', async () => {
    await withServers({
      desktop: (req, res) => {
        res.writeHead(500);
        res.end();
      },
    }, async ({ url }) => {
      const { body } = await send(url, { method: 'GET', path: '/__spark-router/health' });
      assert.deepStrictEqual(JSON.parse(body), {
        router: 'ok',
        local_model_server: 'ok',
        servers: { spark: 'ok', desktop: 'unreachable' },
      });
    });
  });

  it('reports local_model_server unreachable when the first server is down', async () => {
    const deadPort = await freePort();
    const fakeB = await startFake();
    let router = null;
    try {
      router = await startRouter({
        port: 0,
        servers: [
          { name: 'one', url: `http://127.0.0.1:${deadPort}`, models: ['m1'], type: 'anthropic',
            key: 'k1' },
          { name: 'two', url: fakeB.url, models: ['m2'], type: 'anthropic', key: 'k2' },
        ],
        log: { info() {}, warn() {} },
      });
      const url = `http://127.0.0.1:${router.address().port}`;
      const { body } = await send(url, { method: 'GET', path: '/__spark-router/health' });
      assert.deepStrictEqual(JSON.parse(body), {
        router: 'ok',
        local_model_server: 'unreachable',
        servers: { one: 'unreachable', two: 'ok' },
      });
    } finally {
      if (router !== null) {
        await closeServer(router);
      }
      await fakeB.close();
    }
  });
});
