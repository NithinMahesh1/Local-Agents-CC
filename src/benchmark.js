// claude-agents --benchmark: measures the speed of your AI server. It sends one fixed prompt a
// few times, straight to the AI server (not through the router), and prints the time to the
// first token and the output speed in tokens per second.

/** The prompt of every run. It asks for a long answer, so each run measures a steady output. */
export const BENCHMARK_PROMPT =
  'Write a story of about 400 words about a lighthouse keeper who finds a message in a bottle.';
export const BENCHMARK_RUNS = 3;
export const BENCHMARK_MAX_TOKENS = 512;

/**
 * Runs the benchmark and prints one line per run and a median line. Returns the exit code:
 * 0 when every run worked, 1 otherwise.
 * @param {object} options
 * @param {string} options.localUrl - the AI server's address
 * @param {string} options.model - the model name to measure
 * @param {string} options.key - the AI server's API key; never printed
 * @param {{ write: (text: string) => unknown }} options.output
 * @param {typeof fetch} [options.fetchFn]
 * @param {() => number} [options.now] - milliseconds; tests pass a fake clock
 * @param {number} [options.runs]
 * @param {number} [options.timeoutMs] - time limit of one run
 * @returns {Promise<number>}
 */
export async function runBenchmark({
  localUrl, model, key, output, fetchFn = fetch, now = () => performance.now(),
  runs = BENCHMARK_RUNS, timeoutMs = 180000,
}) {
  const say = (text) => output.write(`${text}\n`);
  say(`Benchmark: ${model} at ${new URL(localUrl).origin} `
    + `(${runs} runs, up to ${BENCHMARK_MAX_TOKENS} output tokens each)`);
  const results = [];
  for (let run = 1; run <= runs; run++) {
    let result;
    try {
      result = await measureRun({ localUrl, model, key, fetchFn, now, timeoutMs });
    } catch (error) {
      say(`Run ${run}: failed - ${error.message}`);
      return 1;
    }
    results.push(result);
    say(`Run ${run}: ${formatResult(result)}`);
  }
  say(`Median: first token ${seconds(median(results.map((r) => r.firstTokenMs)))}, `
    + `${median(results.map((r) => r.tokensPerSecond)).toFixed(1)} tok/s`);
  return 0;
}

/**
 * Sends one streamed request and measures it.
 * @returns {Promise<{firstTokenMs: number, outputTokens: number, generateMs: number,
 *   tokensPerSecond: number, counted: boolean}>} counted is true when the AI server did not
 *   report the token count, so the count is the number of text pieces it sent
 */
export async function measureRun({ localUrl, model, key, fetchFn, now, timeoutMs }) {
  const start = now();
  const response = await fetchFn(`${new URL(localUrl).origin}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: BENCHMARK_MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: BENCHMARK_PROMPT }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`the AI server answered HTTP ${response.status}`
      + (response.status === 401 || response.status === 403 ? ' (check the API key)' : ''));
  }

  let firstToken = null;
  let last = null;
  let pieces = 0;
  let reported = null;
  for await (const event of readEvents(response.body)) {
    // Thinking pieces count too: a reasoning model generates them before the answer text.
    if (event.type === 'content_block_delta') {
      const time = now();
      firstToken ??= time;
      last = time;
      pieces += 1;
    } else if (event.type === 'message_delta' && Number.isInteger(event.usage?.output_tokens)) {
      reported = event.usage.output_tokens;
    } else if (event.type === 'error') {
      throw new Error(`the AI server sent an error: ${event.error?.message ?? 'no message'}`);
    }
  }
  if (firstToken === null) {
    throw new Error('the AI server sent no text');
  }
  const outputTokens = reported ?? pieces;
  const generateMs = Math.max(last - firstToken, 1);
  return {
    firstTokenMs: firstToken - start,
    outputTokens,
    generateMs,
    tokensPerSecond: outputTokens <= 1 ? 0 : ((outputTokens - 1) * 1000) / generateMs,
    counted: reported === null,
  };
}

/**
 * Reads a server-sent event stream and yields the JSON of each `data:` line.
 * Lines that are not JSON (for example "[DONE]") are skipped.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<any>}
 */
export async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf('\n');
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      const event = parseDataLine(line);
      if (event !== undefined) {
        yield event;
      }
      end = buffer.indexOf('\n');
    }
  }
  const event = parseDataLine(buffer + decoder.decode());
  if (event !== undefined) {
    yield event;
  }
}

function parseDataLine(line) {
  if (!line.startsWith('data:')) {
    return undefined;
  }
  try {
    return JSON.parse(line.slice(5).trim());
  } catch {
    return undefined;
  }
}

function formatResult({ firstTokenMs, outputTokens, generateMs, tokensPerSecond, counted }) {
  const tokens = counted ? `about ${outputTokens} tokens (counted)` : `${outputTokens} tokens`;
  return `first token ${seconds(firstTokenMs)}, ${tokens} in ${seconds(generateMs)} = `
    + `${tokensPerSecond.toFixed(1)} tok/s`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
