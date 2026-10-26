// Tests for the router routing logic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withRouter, send, BOX_KEY, LOCAL_MODEL } from './router-helpers.js';

describe('router routing', { timeout: 10000 }, () => {
  it('routes box requests with correct headers and path', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      const res = await send(url, {
        path: '/v1/messages?beta=true',
        headers: {
          authorization: 'Bearer login',
          'x-api-key': 'claude-key',
          cookie: 'c=1',
          'anthropic-version': '2023-06-01',
        },
        body: { model: LOCAL_MODEL, messages: [] },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, '{"ok":true}');
      assert.strictEqual(box.requests.length, 1);
      assert.strictEqual(box.requests[0].url, '/v1/messages?beta=true');
      assert.strictEqual(box.requests[0].headers.authorization, `Bearer ${BOX_KEY}`);
      assert.strictEqual(box.requests[0].headers['x-api-key'], undefined);
      assert.strictEqual(box.requests[0].headers.cookie, undefined);
      assert.strictEqual(box.requests[0].headers['anthropic-version'], '2023-06-01');
      assert.strictEqual(anthropic.requests.length, 0);
    });
  });

  it('routes anthropic requests when model is not local', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      const res = await send(url, {
        path: '/v1/messages?beta=true',
        headers: {
          authorization: 'Bearer login',
          'x-api-key': 'claude-key',
          cookie: 'c=1',
          'anthropic-version': '2023-06-01',
        },
        body: { model: 'claude-sonnet-5-5', messages: [] },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(anthropic.requests.length, 1);
      assert.strictEqual(anthropic.requests[0].headers.authorization, 'Bearer login');
      assert.strictEqual(anthropic.requests[0].headers['x-api-key'], 'claude-key');
      assert.strictEqual(anthropic.requests[0].headers.cookie, 'c=1');
      assert.strictEqual(box.requests.length, 0);
    });
  });

  it('handles case-insensitive local model names', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      await send(url, {
        body: { model: 'LOCAL-Model', messages: [] },
      });
      assert.strictEqual(box.requests.length, 1);
    });
  });

  it('routes text/plain requests to anthropic', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      await send(url, {
        headers: { 'content-type': 'text/plain' },
        body: '{"model":"local-model"}',
      });
      assert.strictEqual(anthropic.requests.length, 1);
      assert.strictEqual(box.requests.length, 0);
    });
  });

  it('routes +json media types to the box', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      await send(url, {
        headers: { 'content-type': 'application/vnd.test+json; charset=utf-8' },
        body: '{"model":"local-model"}',
      });
      assert.strictEqual(box.requests.length, 1);
      assert.strictEqual(anthropic.requests.length, 0);
    });
  });

  it('routes GET requests to anthropic', async () => {
    await withRouter({}, async ({ url, box, anthropic }) => {
      await send(url, { method: 'GET', path: '/v1/models' });
      assert.strictEqual(anthropic.requests[0].method, 'GET');
      assert.strictEqual(anthropic.requests[0].url, '/v1/models');
      assert.strictEqual(box.requests.length, 0);
    });
  });

  it('clamps effort for box requests and logs it', async () => {
    await withRouter({}, async ({ url, box, logLines }) => {
      const body = '{"model":"local-model","output_config":{"effort":"max"},"messages":[]}';
      await send(url, {
        headers: { 'content-type': 'application/json' },
        body,
      });
      const parsed = JSON.parse(box.requests[0].body.toString());
      assert.strictEqual(parsed.output_config.effort, 'high');
      const logMatch = logLines.some((line) => line.includes('effort=high(clamped)'));
      assert.strictEqual(logMatch, true);
    });
  });

  it('keeps max effort for anthropic requests', async () => {
    await withRouter({}, async ({ url, anthropic }) => {
      const body = '{"model":"claude-opus-5-5","output_config":{"effort":"max"},"messages":[]}';
      await send(url, {
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.strictEqual(anthropic.requests[0].body.toString(), body);
    });
  });

  it('does not change bytes for box requests', async () => {
    await withRouter({}, async ({ url, box }) => {
      const body = '{"model":"local-model",  "max_tokens":12345678901234567890,"messages":[]}';
      await send(url, {
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.strictEqual(box.requests[0].body.toString(), body);
    });
  });

  it('passes through box status and body', async () => {
    const boxRespond = (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    };
    await withRouter({ box: boxRespond }, async ({ url }) => {
      const res = await send(url, {
        body: { model: LOCAL_MODEL, messages: [] },
      });
      assert.strictEqual(res.status, 429);
      assert.strictEqual(
        res.body,
        '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'
      );
    });
  });

  it('logs correct info message after box request', async () => {
    await withRouter({}, async ({ url, logLines }) => {
      await send(url, {
        body: { model: LOCAL_MODEL, messages: [] },
      });
      const logMatch = logLines.some((line) =>
        /^info: POST \/v1\/messages model=local-model -> BOX 200 \d+ ms$/.test(line)
      );
      assert.strictEqual(logMatch, true);
    });
  });
});
