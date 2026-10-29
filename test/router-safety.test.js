// Tests the safety of the router against various attacks and edge cases.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  withRouter,
  send,
  sendRaw,
  startFake,
  closeServer,
  BOX_KEY,
} from '../test/router-helpers.js';
import { startRouter } from '../src/router.js';

describe('router safety', { timeout: 10000 }, () => {
  it('Wrong Host', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      const { status, body } = await send(url, {
        headers: { host: 'evil.example' },
        body: { model: 'local-model' },
      });
      assert.strictEqual(status, 403);
      const err = JSON.parse(body).error;
      assert.strictEqual(err.type, 'api_error');
      assert.match(err.message, /127.0.0.1 or localhost/);
      assert.strictEqual(box.requests.length, 0);
      assert.strictEqual(anthropic.requests.length, 0);
    });
  });

  it('Host localhost', async () => {
    await withRouter({}, async ({ url, port, box }) => {
      const { status } = await send(url, {
        headers: { host: `localhost:${port}` },
        body: { model: 'local-model' },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(box.requests.length, 1);
    });
  });

  it('Path trick, Anthropic', async () => {
    await withRouter({}, async ({ url, anthropic }) => {
      const { status } = await send(url, {
        path: '/a/..//evil.example/v1/messages',
        body: { model: 'claude-x' },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(anthropic.requests.length, 1);
      assert.strictEqual(anthropic.requests[0].url, '//evil.example/v1/messages');
    });
  });

  // After the path trick the path is no longer /v1/messages, so even a local model name goes
  // to the Anthropic side, and stays on it.
  it('Path trick, local model', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      const { status } = await send(url, {
        path: '/a/..//evil.example/v1/messages',
        body: { model: 'local-model' },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(box.requests.length, 0);
      assert.strictEqual(anthropic.requests.length, 1);
      assert.strictEqual(anthropic.requests[0].url, '//evil.example/v1/messages');
    });
  });

  // A parser that splits on "@" or checks a prefix would read these as localhost.
  it('Disguised and look-alike Host values', async () => {
    await withRouter({}, async ({ url, port, box, anthropic }) => {
      const hosts = [
        'evil.example#@localhost',
        'evil.example?x=@localhost',
        'evil.example@localhost',
        'localhost@evil.example',
        'localhost.evil.example',
        '127.0.0.1.evil.example',
        `localhost:${port}.evil.example`,
        `127.0.0.1:${port}@evil.example`,
      ];
      for (const host of hosts) {
        const { status } = await send(url, { headers: { host }, body: { model: 'claude-x' } });
        assert.strictEqual(status, 403, host);
      }
      assert.strictEqual(box.requests.length, 0);
      assert.strictEqual(anthropic.requests.length, 0);
    });
  });

  it('A request target that names another host keeps the destination', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      // [request target, model, the fake that must get the request, the path it must get]
      const cases = [
        ['http://evil.example/v1/messages', 'claude-x', anthropic, '/v1/messages'],
        ['http://evil.example/v1/messages', 'local-model', box, '/v1/messages'],
        ['/@evil.example/v1/messages', 'claude-x', anthropic, '/@evil.example/v1/messages'],
        ['/v1/messages#@evil.example', 'claude-x', anthropic, '/v1/messages'],
        ['/v1/messages?x=@evil.example', 'claude-x', anthropic, '/v1/messages?x=@evil.example'],
        ['/v1/messages?x=@evil.example', 'local-model', box, '/v1/messages?x=@evil.example'],
      ];
      for (const [path, model, fake, expectedUrl] of cases) {
        const before = fake.requests.length;
        const { status } = await send(url, { path, body: { model } });
        assert.strictEqual(status, 200, path);
        assert.strictEqual(fake.requests.length, before + 1, path);
        assert.strictEqual(fake.requests.at(-1).url, expectedUrl, path);
      }
      assert.strictEqual(box.requests.length + anthropic.requests.length, cases.length);
    });
  });

  it('Bad request line', async () => {
    await withRouter({}, async ({ url, port }) => {
      const raw = 'GET http://a:99999/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n';
      const answer = await sendRaw(port, raw);
      assert.match(answer, /^HTTP\/1\.1 400/);
      const { status } = await send(url, { method: 'GET', path: '/__spark-router/health' });
      assert.strictEqual(status, 200);
    });
  });

  it('Logs hold no secrets', async () => {
    await withRouter({}, async ({ url, box, anthropic, logLines }) => {
      await send(url, {
        path: '/v1/messages?token=query-secret',
        headers: {
          authorization: 'Bearer login-secret',
          'x-api-key': 'key-secret',
          cookie: 'cookie-secret',
        },
        body: { model: 'local-model' },
      });
      const all = logLines.join('\n');
      assert.match(all, /model=local-model -> BOX 200/);
      assert.strictEqual(all.includes('query-secret'), false);
      assert.strictEqual(all.includes('login-secret'), false);
      assert.strictEqual(all.includes('key-secret'), false);
      assert.strictEqual(all.includes('cookie-secret'), false);
      assert.strictEqual(all.includes(BOX_KEY), false);
    });
  });

  it('No new log lines from a model name', async () => {
    await withRouter({}, async ({ url, logLines }) => {
      await send(url, { body: { model: 'bad\nINJECTED' } });
      for (const line of logLines) {
        assert.strictEqual(line.includes('\n'), false);
      }
      const matched = logLines.some((line) => line.includes('model=bad?INJECTED'));
      assert.strictEqual(matched, true);
    });
  });

  it('Port in use', async () => {
    let taken;
    try {
      taken = await startFake();
      await assert.rejects(
        startRouter({
          port: taken.port,
          localModels: ['local-model'],
          localUrl: 'http://127.0.0.1:9',
          boxKey: 'k',
          log: { info() {}, warn() {} },
        }),
        { code: 'EADDRINUSE' },
      );
    } finally {
      if (taken) {
        await taken.close();
      }
    }
  });

  it('Body too large', async () => {
    await withRouter({ router: { maxBodyBytes: 1024 } }, async ({ url, box, anthropic }) => {
      const { status } = await send(url, {
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(2048),
      });
      assert.strictEqual(status, 413);
      assert.strictEqual(box.requests.length, 0);
      assert.strictEqual(anthropic.requests.length, 0);
    });
  });
});
