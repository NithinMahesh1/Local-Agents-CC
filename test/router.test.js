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

  // The answer of a fake OpenAI server: JSON, or an SSE stream written in odd pieces so that a
  // "data:" line is split across two writes.
  const openAIJson = (body) => (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const openAIStream = (records) => async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = records.map((record) => `data: ${record}\n\n`).join('');
    const cut = Math.floor(text.length / 3);
    res.write(text.slice(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.write(text.slice(cut, 2 * cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.end(text.slice(2 * cut));
  };
  const SECRETS = ['secret text', 'key-A', 'key-B', 'claude-login', 'claude-cookie',
    'query-secret'];
  const sseTypes = (text) => [...text.matchAll(/^event: (\S+)$/gm)].map((match) => match[1]);

  it('translates a request for an openai server and its non-streaming answer', async () => {
    const answer = {
      id: 'chatcmpl-1',
      model: 'desktop-docs',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there' },
        finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    };
    await withServers({ typeB: 'openai', desktop: openAIJson(answer) },
      async ({ url, a, b, anthropic, logLines }) => {
        const { status, headers, body } = await send(url, {
          path: '/v1/messages?token=query-secret',
          headers: { ...CLAUDE_HEADERS, 'anthropic-version': '2023-06-01' },
          body: {
            model: 'desktop-docs',
            max_tokens: 50,
            system: 'Be brief.',
            messages: [{ role: 'user', content: 'secret text' }],
          },
        });
        assert.strictEqual(status, 200);
        assert.match(headers['content-type'], /^application\/json/);
        assert.deepStrictEqual(JSON.parse(body), {
          id: 'chatcmpl-1',
          type: 'message',
          role: 'assistant',
          model: 'desktop-docs',
          content: [{ type: 'text', text: 'Hi there' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 2 },
        });

        assert.strictEqual(b.requests.length, 1);
        const upstream = b.requests[0];
        assert.strictEqual(upstream.method, 'POST');
        assert.strictEqual(upstream.url, '/v1/chat/completions');
        assert.strictEqual(upstream.headers.authorization, 'Bearer key-B');
        assert.strictEqual(upstream.headers['x-api-key'], undefined);
        assert.strictEqual(upstream.headers.cookie, undefined);
        assert.strictEqual(upstream.headers['content-type'], 'application/json');
        assert.strictEqual(upstream.headers['content-length'], String(upstream.body.length));
        assert.deepStrictEqual(JSON.parse(upstream.body.toString('utf8')), {
          model: 'desktop-docs',
          max_tokens: 50,
          messages: [
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: 'secret text' },
          ],
        });
        assert.strictEqual(a.requests.length + anthropic.requests.length, 0);

        const all = logLines.join('\n');
        assert.match(all, /POST \/v1\/messages model=desktop-docs -> desktop 200 \d+ ms/);
        for (const secret of SECRETS) {
          assert.strictEqual(all.includes(secret), false, secret);
        }
      });
  });

  it('translates tool calls in a non-streaming answer', async () => {
    const answer = {
      id: 'c',
      model: 'm',
      choices: [{
        message: { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function',
            function: { name: 'ls', arguments: '{"path":"/tmp"}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    await withServers({ typeB: 'openai', desktop: openAIJson(answer) }, async ({ url, b }) => {
      const { status, body } = await send(url, {
        body: {
          model: 'desktop-docs',
          messages: [{ role: 'user', content: 'list' }],
          tools: [{ name: 'ls', description: 'List', input_schema: { type: 'object' } }],
          tool_choice: { type: 'any' },
        },
      });
      assert.strictEqual(status, 200);
      const json = JSON.parse(body);
      assert.strictEqual(json.stop_reason, 'tool_use');
      assert.deepStrictEqual(json.content, [
        { type: 'tool_use', id: 'call_1', name: 'ls', input: { path: '/tmp' } },
      ]);
      const sent = JSON.parse(b.requests[0].body.toString('utf8'));
      assert.deepStrictEqual(sent.tools, [{
        type: 'function',
        function: { name: 'ls', description: 'List', parameters: { type: 'object' } },
      }]);
      assert.strictEqual(sent.tool_choice, 'required');
    });
  });

  it('translates a streaming text answer and asks for token counts', async () => {
    const records = [
      JSON.stringify({ id: 'c1', model: 'm',
        choices: [{ delta: { role: 'assistant', content: '' } }] }),
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ delta: { content: 'lo' } }] }),
      JSON.stringify({ id: 'c1', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] }),
      JSON.stringify({ id: 'c1', model: 'm', choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 2 } }),
      '[DONE]',
    ];
    await withServers({ typeB: 'openai', desktop: openAIStream(records) },
      async ({ url, a, b, logLines }) => {
        const { status, headers, body } = await send(url, {
          headers: CLAUDE_HEADERS,
          body: { model: 'desktop-docs', stream: true,
            messages: [{ role: 'user', content: 'secret text' }] },
        });
        assert.strictEqual(status, 200);
        assert.match(headers['content-type'], /^text\/event-stream/);
        assert.deepStrictEqual(sseTypes(body), [
          'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
          'content_block_stop', 'message_delta', 'message_stop',
        ]);
        assert.ok(body.includes('"text":"Hel"'));
        assert.ok(body.includes('"text":"lo"'));
        assert.ok(body.includes('"stop_reason":"end_turn"'));
        assert.ok(body.includes('"output_tokens":2'));

        const sent = JSON.parse(b.requests[0].body.toString('utf8'));
        assert.strictEqual(sent.stream, true);
        assert.deepStrictEqual(sent.stream_options, { include_usage: true });
        assert.strictEqual(b.requests[0].headers.authorization, 'Bearer key-B');
        assert.strictEqual(b.requests[0].headers['x-api-key'], undefined);
        assert.strictEqual(b.requests[0].headers.cookie, undefined);
        assert.strictEqual(a.requests.length, 0);
        const all = logLines.join('\n');
        assert.match(all, /model=desktop-docs -> desktop 200/);
        for (const secret of SECRETS) {
          assert.strictEqual(all.includes(secret), false, secret);
        }
      });
  });

  it('translates a streaming tool call', async () => {
    const chunk = (delta, finish) => JSON.stringify({
      id: 'c2', model: 'm', choices: [{ delta, finish_reason: finish ?? null }],
    });
    const records = [
      chunk({ tool_calls: [{ index: 0, id: 'call_7', type: 'function',
        function: { name: 'ls', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"/"}' } }] }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ];
    await withServers({ typeB: 'openai', desktop: openAIStream(records) }, async ({ url }) => {
      const { status, body } = await send(url, {
        body: { model: 'desktop-docs', stream: true, messages: [] },
      });
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(sseTypes(body), [
        'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop',
      ]);
      assert.ok(body.includes('"type":"tool_use","id":"call_7","name":"ls"'));
      assert.ok(body.includes('"type":"input_json_delta","partial_json":"{\\"pa"'));
      assert.ok(body.includes('"stop_reason":"tool_use"'));
    });
  });

  it('ends a stream with an error event when a chunk is not JSON', async () => {
    await withServers({ typeB: 'openai', desktop: openAIStream(['{not json', '[DONE]']) },
      async ({ url, logLines }) => {
        const { status, body } = await send(url, {
          body: { model: 'desktop-docs', stream: true, messages: [] },
        });
        assert.strictEqual(status, 200);
        assert.ok(sseTypes(body).includes('error'));
        assert.strictEqual(sseTypes(body).includes('message_stop'), false);
        assert.ok(logLines.some((line) => line.startsWith('warn:')));
      });
  });

  it('passes an error status of an openai server on, without its body', async () => {
    const failing = (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"upstream secret text"}}');
    };
    await withServers({ typeB: 'openai', desktop: failing }, async ({ url, logLines }) => {
      const { status, body } = await send(url, {
        body: { model: 'desktop-docs', messages: [{ role: 'user', content: 'secret text' }] },
      });
      assert.strictEqual(status, 429);
      assert.strictEqual(
        JSON.parse(body).error.message, "the local server 'desktop' answered HTTP 429",
      );
      assert.strictEqual(logLines.join('\n').includes('secret text'), false);
    });
  });

  it('answers 502 when the answer of an openai server cannot be translated', async () => {
    const odd = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[]}');
    };
    await withServers({ typeB: 'openai', desktop: odd }, async ({ url }) => {
      const { status, body } = await send(url, {
        body: { model: 'desktop-docs', messages: [] },
      });
      assert.strictEqual(status, 502);
      assert.match(JSON.parse(body).error.message, /could not translate the answer/);
    });
  });

  it('answers 502 when the request cannot be translated, without forwarding', async () => {
    await withServers({ typeB: 'openai' }, async ({ url, b }) => {
      const { status, body } = await send(url, {
        body: { model: 'desktop-docs', messages: [{ role: 'robot', content: 'secret text' }] },
      });
      assert.strictEqual(status, 502);
      assert.match(JSON.parse(body).error.message, /could not translate the request/);
      assert.strictEqual(body.includes('secret text'), false);
      assert.strictEqual(b.requests.length, 0);
    });
  });

  it('answers 502 when an openai server is down', async () => {
    const deadPort = await freePort();
    let router = null;
    try {
      router = await startRouter({
        port: 0,
        servers: [{ name: 'gone', url: `http://127.0.0.1:${deadPort}`, models: ['m1'],
          type: 'openai', key: 'k' }],
        log: { info() {}, warn() {} },
      });
      const url = `http://127.0.0.1:${router.address().port}`;
      const { status, body } = await send(url, { body: { model: 'm1', messages: [] } });
      assert.strictEqual(status, 502);
      assert.match(JSON.parse(body).error.message, /could not reach the local model server/);
    } finally {
      if (router !== null) {
        await closeServer(router);
      }
    }
  });

  it('does not translate other /v1/messages paths for an openai server', async () => {
    await withServers({ typeB: 'openai' }, async ({ url, a, b, anthropic }) => {
      const { status } = await send(url, {
        path: '/v1/messages/count_tokens',
        body: { model: 'desktop-docs', messages: [] },
      });
      assert.strictEqual(status, 501);
      assert.strictEqual(a.requests.length + b.requests.length + anthropic.requests.length, 0);
    });
  });

  it('always uses the fixed chat completions path on an openai server origin', async () => {
    await withServers({ typeB: 'openai' }, async ({ url, b }) => {
      await send(url, {
        path: '/v1/messages?x=@evil.example',
        body: { model: 'desktop-docs', messages: [] },
      });
      await send(url, {
        path: '/v1/messages?y=//evil.example/z',
        body: { model: 'desktop-docs', messages: [] },
      });
      assert.deepStrictEqual(b.requests.map((request) => request.url),
        ['/v1/chat/completions', '/v1/chat/completions']);
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
