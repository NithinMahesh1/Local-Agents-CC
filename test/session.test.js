import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpText, parseArgs, buildSession } from '../src/session.js';

test('parseArgs([]) -> { allLocal: false, showHelp: false, claudeArgs: [] }', () => {
  const result = parseArgs([]);
  assert.deepEqual(result, { allLocal: false, showHelp: false, claudeArgs: [] });
});

test('parseArgs(["--all-local"]) -> allLocal true, claudeArgs []', () => {
  const result = parseArgs(['--all-local']);
  assert.strictEqual(result.allLocal, true);
  assert.deepEqual(result.claudeArgs, []);
});

test('parseArgs(["-c", "--all-local", "-p", "x"]) -> allLocal true, claudeArgs ["-c", "-p", "x"]', () => {
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
  assert.strictEqual(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Spark Agents');
  assert.strictEqual(
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
    'Free local model on your box - exact, mechanical coding tasks',
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
  // exactly one key of env matches /^anthropic_base_url$/i; it is ANTHROPIC_BASE_URL with the routerUrl.
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

test('helpText content and formatting', () => {
  const routerUrl = 'http://127.0.0.1:8799';
  const logDir = '/tmp/logs';
  const localModel = 'local-model';
  const text = helpText({ routerUrl, logDir, localModel });

  assert.ok(text.includes(routerUrl));
  assert.ok(text.includes(logDir));
  assert.ok(text.includes('Spark Agents (local-model)'));
  assert.ok(text.includes('--all-local'));
  assert.strictEqual(text.endsWith('\n'), true);

  const lines = text.split('\n');
  for (const line of lines) {
    assert.ok(line.length <= 100, `Line too long: ${line}`);
  }
});
