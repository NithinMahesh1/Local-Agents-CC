// Tests the router's health check and streaming capabilities.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import { send, withRouter, freePort } from './router-helpers.js';

describe('router health and streaming', { timeout: 10000 }, async () => {
  it('Health ok', async () => {
    await withRouter({}, async ({ url, box }) => {
      const { status, headers, body } = await send(url, {
        method: 'GET',
        path: '/__spark-router/health',
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(JSON.parse(body), { router: 'ok', local_model_server: 'ok' });
      assert.strictEqual(box.requests[0].url, '/health');
      assert.strictEqual(box.requests[0].headers.authorization, undefined);
    });
  });

  it('Health with box error', async () => {
    await withRouter({
      box: (req, res) => {
        res.writeHead(503);
        res.end();
      },
    }, async ({ url }) => {
      const { status, body } = await send(url, {
        method: 'GET',
        path: '/__spark-router/health',
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(JSON.parse(body), { router: 'ok', local_model_server: 'unreachable' });
    });
  });

  it('Health with no box', async () => {
    const deadPort = await freePort();
    await withRouter(
      { router: { localUrl: `http://127.0.0.1:${deadPort}` } },
      async ({ url }) => {

      const { status, body } = await send(url, {
        method: 'GET',
        path: '/__spark-router/health',
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(JSON.parse(body), { router: 'ok', local_model_server: 'unreachable' });
    });
  });

  it('Box not reachable', async () => {
    const deadPort = await freePort();
    await withRouter(
      { router: { localUrl: `http://127.0.0.1:${deadPort}` } },
      async ({ url, logLines }) => {

      const { status, body } = await send(url, {
        method: 'POST',
        path: '/v1/messages',
        body: { model: 'local-model' },
      });
      assert.strictEqual(status, 502);
      const json = JSON.parse(body);
      assert.strictEqual(json.type, 'error');
      assert.strictEqual(json.error.type, 'api_error');
      assert.ok(json.error.message.includes('the local model server'));
      assert.ok(logLines.some((line) => line.startsWith('warn:') && line.includes('FAILED')));
    });
  });

  it('Streaming', async () => {
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });

    await withRouter({
      box: async (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        await released;
        res.end('data: two\n\n');
      },
    }, async ({ url, port }) => {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/messages',
            headers: { 'content-type': 'application/json' },
            agent: false,
          },
          (res) => {
            let all = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              all += chunk;
              if (all.includes('data: one') && !all.includes('data: two')) {
                release();
              }
            });
            res.on('end', () => resolve(all));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'local-model' }));
      });
      assert.strictEqual(result, 'data: one\n\ndata: two\n\n');
    });
  });

  it('Client goes away', async () => {
    let boxClosed;
    const closed = new Promise((resolve) => {
      boxClosed = resolve;
    });

    await withRouter({
      box: async (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        res.on('close', () => {
          boxClosed(res.writableFinished);
        });
      },
    }, async ({ url, port }) => {
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/messages',
            headers: { 'content-type': 'application/json' },
            agent: false,
          },
          (res) => {
            res.setEncoding('utf8');
            res.on('data', () => {
              req.destroy();
              resolve();
            });
            req.on('error', () => {});
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'local-model' }));
      });

      const result = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);
      assert.strictEqual(result, false);
    });
  });
});
