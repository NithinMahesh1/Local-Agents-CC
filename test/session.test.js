import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpText, parseArgs, buildSession } from '../src/session.js';

test('parseArgs([]) -> all flags off, claudeArgs []', () => {
  const result = parseArgs([]);
  assert.deepEqual(result, {
    allLocal: false,
    claudeArgs: [],
    missedEventsFile: null,
    missedToolCalls: false,
    setup: false,
    benchmark: false,
    showHelp: false
  });
});

test('parseArgs(["--all-local"]) -> allLocal true, claudeArgs []', () => {
  const result = parseArgs(['--all-local']);
  assert.strictEqual(result.allLocal, true);
  assert.deepEqual(result.claudeArgs, []);
});

test('parseArgs(["-c", "--all-local", "-p", "x"]) -> allLocal, args ["-c", "-p", "x"]', () => {
  const result = parseArgs(['-c', '--all-local', '-p', 'x']);
  assert.strictEqual(result.allLocal, true);
  assert.deepEqual(result.claudeArgs, ['-c', '-p', 'x']);
});

test('parseArgs(["--all-local", "--all-local"]) -> allLocal true, claudeArgs []', () => {
  const result = parseArgs(['--all-local', '--all-local']);
  assert.strictEqual(result.allLocal, true);
  assert.deepEqual(result.claudeArgs, []);
});

test('showHelp true for ["--help"], ["-h"], ["--help", "-h"] and ["--all-local", "--help"]', () => {
  assert.strictEqual(parseArgs(['--help']).showHelp, true);
  assert.strictEqual(parseArgs(['-h']).showHelp, true);
  assert.strictEqual(parseArgs(['--help', '-h']).showHelp, true);
  assert.strictEqual(parseArgs(['--all-local', '--help']).showHelp, true);
});

test('parseArgs(["mcp", "--help"]) -> showHelp false, claudeArgs ["mcp", "--help"]', () => {
  const result = parseArgs(['mcp', '--help']);
  assert.strictEqual(result.showHelp, false);
  assert.deepEqual(result.claudeArgs, ['mcp', '--help']);
});

test('parseArgs does not change its input', () => {
  const input = Object.freeze(['--all-local', '--help']);
  assert.doesNotThrow(() => parseArgs(input));
});

test('buildSession normal mode', () => {
  const baseEnv = Object.freeze({
    PATH: 'x',
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_AUTH_TOKEN: 't',
    anthropic_api_key: 'lower',
  });
  const routerUrl = 'http://127.0.0.1:8799';
  const localModel = 'local-model';
  const claudeArgs = Object.freeze(['-c']);
  const options = Object.freeze({
    baseEnv,
    routerUrl,
    localModel,
    allLocal: false,
    claudeArgs,
  });

  const { env, args, notes } = buildSession(options);

  // no key of env matches /^anthropic_(api_key|auth_token)$/i
  for (const key of Object.keys(env)) {
    assert.strictEqual(
      /^anthropic_(api_key|auth_token)$/i.test(key),
      false,
      `Key ${key} should not match regex`,
    );
  }

  assert.strictEqual(env.PATH, 'x');
  assert.strictEqual(env.ANTHROPIC_BASE_URL, routerUrl);
  assert.strictEqual(env.ANTHROPIC_CUSTOM_MODEL_OPTION, localModel);
  assert.strictEqual(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Local Agents');
  assert.strictEqual(
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
    'Free local model on your AI server - exact, mechanical coding tasks',
  );
  assert.strictEqual(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '120000');

  // no key ANTHROPIC_DEFAULT_OPUS_MODEL and no key CLAUDE_CODE_SUBAGENT_MODEL
  assert.strictEqual(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.strictEqual(env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);

  assert.deepEqual(args, ['-c']);
  assert.deepEqual(notes, []);
});

test('buildSession CLAUDE_CODE_MAX_CONTEXT_TOKENS', () => {
  const baseEnv = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000' };
  const { env } = buildSession({
    baseEnv,
    routerUrl: 'http://localhost',
    localModel: 'm',
    allLocal: false,
    claudeArgs: [],
  });
  assert.strictEqual(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '200000');
});

test('buildSession allLocal true', () => {
  const localModel = 'local-model';
  const claudeArgs = ['-c'];
  const { env, args, notes } = buildSession({
    baseEnv: {},
    routerUrl: 'http://localhost',
    localModel,
    allLocal: true,
    claudeArgs,
  });

  assert.strictEqual(env.ANTHROPIC_DEFAULT_OPUS_MODEL, localModel);
  assert.strictEqual(env.ANTHROPIC_DEFAULT_SONNET_MODEL, localModel);
  assert.strictEqual(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, localModel);
  assert.strictEqual(env.ANTHROPIC_DEFAULT_FABLE_MODEL, localModel);
  assert.strictEqual(env.CLAUDE_CODE_SUBAGENT_MODEL, localModel);
  assert.strictEqual(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
  assert.strictEqual(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
  assert.strictEqual(env.BASH_DEFAULT_TIMEOUT_MS, '600000');

  assert.deepEqual(args, ['--model=' + localModel, '--disallowedTools=WebSearch', '-c']);
  assert.strictEqual(notes.length, 2);
  assert.ok(notes[0].startsWith('ALL-LOCAL: '));
  assert.ok(notes[1].startsWith('ALL-LOCAL: '));
});

test('buildSession case-insensitive env key matching', () => {
  const baseEnv = { anthropic_base_url: 'http://old' };
  const { env } = buildSession({
    baseEnv,
    routerUrl: 'http://new',
    localModel: 'm',
    allLocal: false,
    claudeArgs: [],
  });
  // exactly one key of env matches /^anthropic_base_url$/i; it is
  // ANTHROPIC_BASE_URL with the routerUrl.
  const matches = Object.keys(env).filter((k) => /^anthropic_base_url$/i.test(k));
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://new');
});

test('buildSession does not change its inputs', () => {
  const baseEnv = Object.freeze({ PATH: 'x' });
  const routerUrl = 'http://localhost';
  const localModel = 'm';
  const claudeArgs = Object.freeze(['-c']);
  const options = Object.freeze({
    baseEnv,
    routerUrl,
    localModel,
    allLocal: false,
    claudeArgs,
  });

  buildSession(options);

  assert.deepEqual(baseEnv, { PATH: 'x' });
  assert.strictEqual(routerUrl, 'http://localhost');
  assert.strictEqual(localModel, 'm');
  assert.deepEqual(claudeArgs, ['-c']);
  assert.deepEqual(options, {
    baseEnv,
    routerUrl,
    localModel,
    allLocal: false,
    claudeArgs,
  });
});

test('buildSession handles undefined env values', () => {
  const baseEnv = { A: undefined, B: 'b' };
  const { env } = buildSession({
    baseEnv,
    routerUrl: 'http://localhost',
    localModel: 'm',
    allLocal: false,
    claudeArgs: [],
  });
  assert.strictEqual(env.A, undefined);
  assert.strictEqual(env.B, 'b');
  assert.ok(!('A' in env));
});

test('parseArgs: --missed-tool-calls', () => {
  const result = parseArgs(['--missed-tool-calls']);
  assert.strictEqual(result.missedToolCalls, true);
  assert.strictEqual(result.missedEventsFile, null);
  assert.deepStrictEqual(result.claudeArgs, []);
  assert.strictEqual(result.showHelp, false);
});

test('parseArgs: --missed-tool-calls and --missed-events-file', () => {
  const result = parseArgs(['--missed-tool-calls', '--missed-events-file', 'a.jsonl']);
  assert.strictEqual(result.missedEventsFile, 'a.jsonl');
  assert.deepStrictEqual(result.claudeArgs, []);
});

test('parseArgs: --missed-events-file= and --missed-tool-calls', () => {
  const result = parseArgs(['--missed-events-file=b.jsonl', '--missed-tool-calls']);
  assert.strictEqual(result.missedEventsFile, 'b.jsonl');
  assert.strictEqual(result.missedToolCalls, true);
});

test('parseArgs: --missed-tool-calls and --missed-events-file (no value)', () => {
  const result = parseArgs(['--missed-tool-calls', '--missed-events-file']);
  assert.strictEqual(result.missedEventsFile, '');
  assert.strictEqual(result.missedToolCalls, true);
});

test('parseArgs: --missed-events-file= (empty)', () => {
  const result = parseArgs(['--missed-events-file=']);
  assert.strictEqual(result.missedEventsFile, '');
  assert.strictEqual(result.missedToolCalls, false);
});

test('parseArgs: mixed args', () => {
  const result = parseArgs(['-p', 'x', '--missed-events-file', 'c.jsonl', '--all-local']);
  assert.strictEqual(result.allLocal, true);
  assert.strictEqual(result.missedEventsFile, 'c.jsonl');
  assert.deepStrictEqual(result.claudeArgs, ['-p', 'x']);
});

test('parseArgs: --missed-tool-calls and --help', () => {
  const result = parseArgs(['--missed-tool-calls', '--help']);
  assert.strictEqual(result.showHelp, true);
  assert.deepStrictEqual(result.claudeArgs, ['--help']);
});

test('parseArgs: --missed-tool-calls=x', () => {
  const result = parseArgs(['-p', '--missed-tool-calls=x']);
  assert.strictEqual(result.missedToolCalls, false);
  assert.deepStrictEqual(result.claudeArgs, ['-p', '--missed-tool-calls=x']);
});

test('buildSession: pluginDir included', () => {
  const options = {
    baseEnv: {},
    routerUrl: 'http://127.0.0.1:18799',
    localModel: 'local-model',
    allLocal: true,
    claudeArgs: ['-c'],
    pluginDir: '/pkg/plugin',
  };
  const { args } = buildSession(options);
  const expected = [
    '--model=local-model',
    '--disallowedTools=WebSearch',
    '--plugin-dir=/pkg/plugin',
    '-c'
  ];
  assert.deepStrictEqual(args, expected);
});

test('buildSession: pluginDir null or missing', () => {
  const base = {
    baseEnv: {},
    routerUrl: 'http://127.0.0.1:18799',
    localModel: 'local-model',
    allLocal: true,
    claudeArgs: ['-c'],
  };
  const res1 = buildSession({ ...base, pluginDir: null }).args;
  const expected = ['--model=local-model', '--disallowedTools=WebSearch', '-c'];
  assert.deepStrictEqual(res1, expected);
  const res2 = buildSession(base).args;
  assert.deepStrictEqual(res2, expected);
});

test('buildSession: allLocal false and pluginDir included', () => {
  const options = {
    baseEnv: {},
    routerUrl: 'http://127.0.0.1:18799',
    localModel: 'local-model',
    allLocal: false,
    claudeArgs: ['-c'],
    pluginDir: '/pkg/plugin',
  };
  const { args } = buildSession(options);
  assert.deepStrictEqual(args, ['-c']);
});

test('helpText: missed tool calls and events', () => {
  const text = helpText({
    routerUrl: 'http://127.0.0.1:18799',
    logDir: '/logs',
    localModel: 'local-model'
  });
  assert.ok(text.includes('--missed-tool-calls'));
  assert.ok(text.includes('--missed-events-file <file>'));
  assert.ok(text.includes('Stop hook'));
});

test('parseArgs(["--setup"]) -> setup true, claudeArgs []', () => {
  const result = parseArgs(['--setup']);
  assert.strictEqual(result.setup, true);
  assert.deepStrictEqual(result.claudeArgs, []);
});

test('parseArgs(["--setup", "-c"]) -> setup true, claudeArgs ["-c"]', () => {
  const result = parseArgs(['--setup', '-c']);
  assert.strictEqual(result.setup, true);
  assert.deepStrictEqual(result.claudeArgs, ['-c']);
});

test('helpText contains --setup', () => {
  const text = helpText({
    routerUrl: 'http://127.0.0.1:1',
    logDir: '/l',
    localModel: 'm'
  });
  assert.ok(text.includes('--setup'));
});

test('parseArgs(["--benchmark"]) -> benchmark true, claudeArgs []', () => {
  const result = parseArgs(['--benchmark']);
  assert.strictEqual(result.benchmark, true);
  assert.deepStrictEqual(result.claudeArgs, []);
});

test('helpText mentions --benchmark', () => {
  const text = helpText({ routerUrl: 'http://127.0.0.1:1', logDir: '/l', localModel: 'm' });
  assert.ok(text.includes('--benchmark'));
});
