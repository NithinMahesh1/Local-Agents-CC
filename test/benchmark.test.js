import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readEvents,
  measureRun,
  runBenchmark,
  BENCHMARK_PROMPT,
  BENCHMARK_MAX_TOKENS,
} from '../src/benchmark.js';

function sse(events) {
  return events.map((obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`).join('');
}

function streamOf(text, chunkSize) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= bytes.length) {
        controller.close();
      } else {
        const chunk = bytes.slice(index, index + chunkSize);
        index += chunkSize;
        controller.enqueue(chunk);
      }
    },
  });
}

describe('benchmark.js', () => {
  describe('readEvents', () => {
    it('yields 3 events split into 7-byte chunks', async () => {
      const events = [
        { type: 'a', data: 1 },
        { type: 'b', data: 2 },
        { type: 'c', data: 3 },
      ];
      const text = sse(events);
      const body = streamOf(text, 7);
      const result = [];
      for await (const event of readEvents(body)) {
        result.push(event);
      }
      assert.deepEqual(result, events);
    });

    it('skips non-data lines and data: [DONE]', async () => {
      const text = 'event: message\ndata: {"type":"a"}\n\n\ndata: [DONE]\n\n';
      const body = streamOf(text, 7);
      const result = [];
      for await (const event of readEvents(body)) {
        result.push(event);
      }
      assert.deepEqual(result, [{ type: 'a' }]);
    });

    it('works with \\r\\n line ends', async () => {
      const text = 'data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\n';
      const body = streamOf(text, 7);
      const result = [];
      for await (const event of readEvents(body)) {
        result.push(event);
      }
      assert.deepEqual(result, [{ type: 'a' }, { type: 'b' }]);
    });

    it('yields last data line without line break', async () => {
      const text = 'data: {"type":"a"}\n\ndata: {"type":"b"}';
      const body = streamOf(text, 7);
      const result = [];
      for await (const event of readEvents(body)) {
        result.push(event);
      }
      assert.deepEqual(result, [{ type: 'a' }, { type: 'b' }]);
    });
  });

  describe('measureRun', () => {
    it('makes the correct request', async () => {
      const calls = [];
      const fetchFn = async (url, options) => {
        calls.push({ url, options });
        return new Response(streamOf('data: {"type":"content_block_delta"}\n\n', 7), {
          status: 200,
        });
      };
      const now = () => 0;
      await measureRun({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key: 'k',
        fetchFn,
        now,
        timeoutMs: 1000,
      });

      const { url, options } = calls[0];
      assert.equal(url, 'http://127.0.0.1:9/v1/messages');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer k');
      assert.equal(options.headers['content-type'], 'application/json');
      assert.equal(options.headers['anthropic-version'], '2023-06-01');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'm');
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, BENCHMARK_MAX_TOKENS);
      assert.equal(body.messages[0].content, BENCHMARK_PROMPT);
    });

    it('calculates correctly with message_delta usage', async () => {
      const calls = [];
      const text = sse([
        { type: 'message_start' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'message_delta', usage: { output_tokens: 101 } },
        { type: 'message_stop' },
      ]);
      const fetchFn = async (url, options) => {
        calls.push({ url, options });
        return new Response(streamOf(text, 7), { status: 200 });
      };
      const times = [0, 500, 600, 700, 800, 1500];
      const now = () => times.shift();

      const result = await measureRun({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key: 'k',
        fetchFn,
        now,
        timeoutMs: 1000,
      });

      assert.equal(result.firstTokenMs, 500);
      assert.equal(result.outputTokens, 101);
      assert.equal(result.generateMs, 1000);
      assert.equal(result.tokensPerSecond, 100);
      assert.equal(result.counted, false);
    });

    it('calculates correctly without message_delta usage', async () => {
      const calls = [];
      const text = sse([
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
      ]);
      const fetchFn = async (url, options) => {
        calls.push({ url, options });
        return new Response(streamOf(text, 7), { status: 200 });
      };
      const times = [0, 100, 200, 300, 400, 500];
      const now = () => times.shift();

      const result = await measureRun({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key: 'k',
        fetchFn,
        now,
        timeoutMs: 1000,
      });

      assert.equal(result.outputTokens, 5);
      assert.equal(result.counted, true);
      assert.equal(result.tokensPerSecond, 10);
    });

    it('rejects on 401', async () => {
      const fetchFn = async () => new Response(null, { status: 401 });
      const now = () => 0;
      await assert.rejects(
        measureRun({
          localUrl: 'http://127.0.0.1:9/',
          model: 'm',
          key: 'k',
          fetchFn,
          now,
          timeoutMs: 1000,
        }),
        /HTTP 401.*check the API key/,
      );
    });

    it('rejects on 500', async () => {
      const fetchFn = async () => new Response(null, { status: 500 });
      const now = () => 0;
      await assert.rejects(
        measureRun({
          localUrl: 'http://127.0.0.1:9/',
          model: 'm',
          key: 'k',
          fetchFn,
          now,
          timeoutMs: 1000,
        }),
        (error) => error.message.includes('HTTP 500') && !error.message.includes('API key'),
      );
    });

    it('rejects on error event', async () => {
      const text = sse([{ type: 'error', error: { message: 'overloaded' } }]);
      const fetchFn = async () => new Response(streamOf(text, 7), { status: 200 });
      const now = () => 0;
      await assert.rejects(
        measureRun({
          localUrl: 'http://127.0.0.1:9/',
          model: 'm',
          key: 'k',
          fetchFn,
          now,
          timeoutMs: 1000,
        }),
        /overloaded/,
      );
    });

    it('rejects if no content_block_delta', async () => {
      const text = sse([{ type: 'message_start' }, { type: 'message_stop' }]);
      const fetchFn = async () => new Response(streamOf(text, 7), { status: 200 });
      const now = () => 0;
      await assert.rejects(
        measureRun({
          localUrl: 'http://127.0.0.1:9/',
          model: 'm',
          key: 'k',
          fetchFn,
          now,
          timeoutMs: 1000,
        }),
        /sent no text/,
      );
    });
  });

  describe('runBenchmark', () => {
    it('performs 3 good runs', async () => {
      let text = '';
      const output = { write: (chunk) => { text += chunk; } };
      const eventText = sse([
        { type: 'message_start' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'content_block_delta' },
        { type: 'message_delta', usage: { output_tokens: 101 } },
        { type: 'message_stop' },
      ]);

      const clock = [0, 500, 600, 700, 800, 1500];
      const times = [...clock, ...clock, ...clock];
      const now = () => times.shift();

      const fetchFn = async () => {
        return new Response(streamOf(eventText, 7), { status: 200 });
      };

      const exitCode = await runBenchmark({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key: 'k',
        output,
        fetchFn,
        now,
      });

      assert.equal(exitCode, 0);
      const out = text;
      const lines = out.split('\n');
      assert.ok(lines[0].includes('m at http://127.0.0.1:9'));
      assert.ok(lines[0].includes('3 runs'));
      assert.ok(out.includes('Run 1:'));
      assert.ok(out.includes('Run 2:'));
      assert.ok(out.includes('Run 3:'));
      assert.ok(out.includes('Median: first token 0.50 s, 100.0 tok/s'));
    });

    it('never contains the key in output', async () => {
      const key = 'secret-key-123';
      let text = '';
      const output = { write: (chunk) => { text += chunk; } };
      const eventText = sse([
        { type: 'message_start' }, { type: 'content_block_delta' }, { type: 'message_stop' },
      ]);
      const fetchFn = async () => new Response(streamOf(eventText, 7), { status: 200 });

      await runBenchmark({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key,
        output,
        fetchFn,
      });

      assert.ok(!text.includes(key));
    });

    it('handles a failed run', async () => {
      let text = '';
      const output = { write: (chunk) => { text += chunk; } };
      let runCount = 0;
      const fetchFn = async () => {
        runCount++;
        if (runCount === 2) {
          return new Response(null, { status: 503 });
        }
        return new Response(
          streamOf(sse([
            { type: 'message_start' }, { type: 'content_block_delta' }, { type: 'message_stop' },
          ]), 7),
          { status: 200 },
        );
      };

      const exitCode = await runBenchmark({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key: 'k',
        output,
        fetchFn,
      });

      assert.equal(exitCode, 1);
      const out = text;
      assert.ok(out.includes('Run 2: failed'));
      assert.ok(!out.includes('Median:'));
    });

    it('works with 1 run', async () => {
      let text = '';
      const output = { write: (chunk) => { text += chunk; } };
      const eventText = sse([
        { type: 'message_start' }, { type: 'content_block_delta' }, { type: 'message_stop' },
      ]);
      const fetchFn = async () => new Response(streamOf(eventText, 7), { status: 200 });

      const exitCode = await runBenchmark({
        localUrl: 'http://127.0.0.1:9/',
        model: 'm',
        key: 'k',
        output,
        fetchFn,
        runs: 1,
      });

      assert.equal(exitCode, 0);
      const out = text;
      const runMatches = out.match(/Run 1:/g);
      const medianMatches = out.match(/Median:/g);
      assert.equal(runMatches?.length, 1);
      assert.equal(medianMatches?.length, 1);
    });
  });
});
