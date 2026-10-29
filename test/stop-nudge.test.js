import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isAllLocalSession,
  nudgeLine,
  missedToolCallEvent,
  appendMissedEvent,
  runStopHook,
} from '../src/stop-nudge.js';

const ALL_LOCAL = { ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-model' };
const ANNOUNCE = 'I updated the parser.\nI will now write the tests.';
const NOW = new Date('2026-10-28T17:00:00.123Z');
const EVENT = {
  when: '2026-10-28T17:00:00.123000Z',
  session_id: 's-1',
  cwd: '/work/app-one',
  model: 'local-model',
  kind: 'missed-tool-call',
};
const INPUT = {
  session_id: 's-1',
  cwd: '/work/app-one',
  stop_hook_active: false,
  last_assistant_message: ANNOUNCE,
  background_tasks: [],
};
const SCRIPT = path.join(
  fileURLToPath(new URL('..', import.meta.url)),
  'plugin',
  'hooks',
  'stop-nudge.js',
);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-nudge-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function newDir() {
  return fs.mkdtempSync(path.join(tmpRoot, 'case-'));
}

function hook(input, env) {
  return runStopHook(JSON.stringify(input), {
    env,
    platform: process.platform,
    now: NOW,
  });
}

function runScript(stdinText, eventsFile) {
  const env = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-model',
    SPARK_MISSED_EVENTS_FILE: eventsFile,
  };
  if (process.env.SystemRoot !== undefined) {
    env.SystemRoot = process.env.SystemRoot;
  }
  return spawnSync(process.execPath, [SCRIPT], {
    input: stdinText,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('isAllLocalSession: a local model name -> true', () => {
  assert.strictEqual(isAllLocalSession({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-model' }), true);
});

test('isAllLocalSession: no model name, or only spaces -> false', () => {
  assert.strictEqual(isAllLocalSession({}), false);
  assert.strictEqual(isAllLocalSession({ ANTHROPIC_DEFAULT_OPUS_MODEL: '  ' }), false);
});

test('isAllLocalSession: a name that starts with "claude", in any case -> false', () => {
  assert.strictEqual(
    isAllLocalSession({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' }),
    false,
  );
  assert.strictEqual(
    isAllLocalSession({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'Claude-Sonnet' }),
    false,
  );
});

test('isAllLocalSession: LOCAL_MODEL_CONTINUE "OFF" -> false', () => {
  assert.strictEqual(
    isAllLocalSession({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'local-model',
      LOCAL_MODEL_CONTINUE: 'OFF',
    }),
    false,
  );
});

test('nudgeLine: a reply that announces a step -> its last line', () => {
  assert.strictEqual(
    nudgeLine({ last_assistant_message: ANNOUNCE }, ALL_LOCAL),
    'I will now write the tests.',
  );
});

test('nudgeLine: stop_hook_active true -> null', () => {
  assert.strictEqual(
    nudgeLine({ last_assistant_message: ANNOUNCE, stop_hook_active: true }, ALL_LOCAL),
    null,
  );
});

test('nudgeLine: a Claude model session -> null', () => {
  assert.strictEqual(
    nudgeLine(
      { last_assistant_message: ANNOUNCE },
      { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5' },
    ),
    null,
  );
});

test('nudgeLine: a question in the last line -> null', () => {
  assert.strictEqual(
    nudgeLine(
      { last_assistant_message: 'I will now write the tests.\nShould I also update the docs?' },
      ALL_LOCAL,
    ),
    null,
  );
});

test('nudgeLine: a question in the line before the last -> null', () => {
  assert.strictEqual(
    nudgeLine(
      { last_assistant_message: 'Should I also update the docs?\nI will now write the tests.' },
      ALL_LOCAL,
    ),
    null,
  );
});

test('nudgeLine: "Want more?" is not a question -> its last line', () => {
  assert.strictEqual(
    nudgeLine(
      { last_assistant_message: 'I will now write the tests.\nWant more?' },
      ALL_LOCAL,
    ),
    'Want more?',
  );
});

test('nudgeLine: a reply that announces nothing -> null', () => {
  assert.strictEqual(
    nudgeLine({ last_assistant_message: 'All tests pass. The work is done.' }, ALL_LOCAL),
    null,
  );
});

test('nudgeLine: "Next: Writing the file" -> its last line', () => {
  assert.strictEqual(
    nudgeLine({ last_assistant_message: 'Next: Writing the file' }, ALL_LOCAL),
    'Next: Writing the file',
  );
});

test('nudgeLine: "Next: nothing pending." -> null', () => {
  assert.strictEqual(
    nudgeLine({ last_assistant_message: 'Next: nothing pending.' }, ALL_LOCAL),
    null,
  );
});

test('nudgeLine: a curly apostrophe counts as a straight one', () => {
  assert.strictEqual(
    nudgeLine({ last_assistant_message: 'I\u2019ll now run the tests.' }, ALL_LOCAL),
    "I'll now run the tests.",
  );
});

test('nudgeLine: "Launching parallel agents ..." -> its last line', () => {
  assert.strictEqual(
    nudgeLine(
      { last_assistant_message: 'Launching parallel agents to fix the tests.' },
      ALL_LOCAL,
    ),
    'Launching parallel agents to fix the tests.',
  );
});

test('nudgeLine: waiting text while a background task runs -> null', () => {
  assert.strictEqual(
    nudgeLine(
      {
        last_assistant_message: 'I started it. I will now wait for the background agent.',
        background_tasks: [{ id: 'task-1' }],
      },
      ALL_LOCAL,
    ),
    null,
  );
});

test('nudgeLine: waiting text with no background task -> its last line', () => {
  assert.strictEqual(
    nudgeLine(
      {
        last_assistant_message: 'I started it. I will now wait for the background agent.',
        background_tasks: [],
      },
      ALL_LOCAL,
    ),
    'I started it. I will now wait for the background agent.',
  );
});

test('nudgeLine: no text, a number, or only blank lines -> null', () => {
  assert.strictEqual(nudgeLine({ background_tasks: [] }, ALL_LOCAL), null);
  assert.strictEqual(nudgeLine({ last_assistant_message: 42 }, ALL_LOCAL), null);
  assert.strictEqual(nudgeLine({ last_assistant_message: '\n  \n' }, ALL_LOCAL), null);
});

test('nudgeLine: CRLF line ends and spaces around the last line -> the trimmed line', () => {
  assert.strictEqual(
    nudgeLine(
      { last_assistant_message: 'I updated the parser.\r\n  I will now write the tests.  \r\n' },
      ALL_LOCAL,
    ),
    'I will now write the tests.',
  );
});

test('missedToolCallEvent: the 5 keys in order, and no reply text', () => {
  const input = {
    session_id: 's-1',
    cwd: '/work/app-one',
    last_assistant_message: 'secret reply',
  };
  const result = missedToolCallEvent(input, ALL_LOCAL, NOW);
  assert.deepEqual(result, EVENT);
  assert.deepEqual(Object.keys(result), ['when', 'session_id', 'cwd', 'model', 'kind']);
  assert.ok(!JSON.stringify(result).includes('secret reply'));
});

test('missedToolCallEvent: missing values -> empty strings', () => {
  const result = missedToolCallEvent({}, {}, NOW);
  assert.deepEqual(result, {
    when: '2026-10-28T17:00:00.123000Z',
    session_id: '',
    cwd: '',
    model: '',
    kind: 'missed-tool-call',
  });
});

test('appendMissedEvent: creates the folders and adds one line per call', () => {
  const dir = newDir();
  const file = path.join(dir, 'a', 'b', 'events.jsonl');
  const event = { foo: 'bar' };
  assert.strictEqual(appendMissedEvent(file, event), true);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(event) + '\n');

  const event2 = { baz: 'qux' };
  assert.strictEqual(appendMissedEvent(file, event2), true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], JSON.stringify(event));
  assert.strictEqual(lines[1], JSON.stringify(event2));
});

test('appendMissedEvent: a file in place of the folder -> false, no exception', () => {
  const dir = newDir();
  const notAFolder = path.join(dir, 'not-a-folder.txt');
  fs.writeFileSync(notAFolder, 'content');
  const file = path.join(notAFolder, 'events.jsonl');
  assert.strictEqual(appendMissedEvent(file, { foo: 'bar' }), false);
});

test('runStopHook: a reply that announces a step -> the nudge and one log line', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const env = { ...ALL_LOCAL, SPARK_MISSED_EVENTS_FILE: file };
  const output = hook(INPUT, env);

  assert.ok(output.endsWith('\n'));
  assert.strictEqual((output.match(/\n/g) || []).length, 1);
  const parsed = JSON.parse(output);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'Stop');
  assert.ok(
    parsed.hookSpecificOutput.additionalContext.includes('I will now write the tests.'),
  );

  const logLine = fs.readFileSync(file, 'utf8').trim();
  assert.deepEqual(JSON.parse(logLine), EVENT);
});

test('runStopHook: stop_hook_active true -> no output and no log file', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const env = { ...ALL_LOCAL, SPARK_MISSED_EVENTS_FILE: file };
  const input = { ...INPUT, stop_hook_active: true };

  const output = hook(input, env);
  assert.strictEqual(output, '');
  assert.strictEqual(fs.existsSync(file), false);
});

test('runStopHook: a Claude model session -> no output and no log file', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const env = {
    ...ALL_LOCAL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
    SPARK_MISSED_EVENTS_FILE: file,
  };
  const output = hook(INPUT, env);

  assert.strictEqual(output, '');
  assert.strictEqual(fs.existsSync(file), false);
});

test('runStopHook: a question at the end -> no output and no log file', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const env = { ...ALL_LOCAL, SPARK_MISSED_EVENTS_FILE: file };
  const input = {
    ...INPUT,
    last_assistant_message: 'I will now write the tests.\nShould I also update the docs?',
  };

  const output = hook(input, env);
  assert.strictEqual(output, '');
  assert.strictEqual(fs.existsSync(file), false);
});

test('runStopHook: input that is not a JSON object -> no output', () => {
  // Raw stdin text: hook() would turn each value into a valid JSON string first.
  const options = { env: ALL_LOCAL, platform: process.platform, now: NOW };
  assert.strictEqual(runStopHook('not json', options), '');
  assert.strictEqual(runStopHook('[]', options), '');
  assert.strictEqual(runStopHook('null', options), '');
});

test('runStopHook: a byte order mark (U+FEFF) before the JSON -> the nudge', () => {
  const dir = newDir();
  const env = { ...ALL_LOCAL, SPARK_MISSED_EVENTS_FILE: path.join(dir, 'events.jsonl') };
  const options = { env, platform: process.platform, now: NOW };
  const output = runStopHook(String.fromCharCode(0xfeff) + JSON.stringify(INPUT), options);
  assert.strictEqual(JSON.parse(output).hookSpecificOutput.hookEventName, 'Stop');
});

test('runStopHook: the log cannot be written -> the nudge still goes out', () => {
  const dir = newDir();
  const notAFolder = path.join(dir, 'not-a-folder.txt');
  fs.writeFileSync(notAFolder, 'content');
  const file = path.join(notAFolder, 'events.jsonl');
  const env = { ...ALL_LOCAL, SPARK_MISSED_EVENTS_FILE: file };

  const output = hook(INPUT, env);
  assert.ok(output.length > 0);
  assert.strictEqual(JSON.parse(output).hookSpecificOutput.hookEventName, 'Stop');
});

test('runStopHook: no SPARK_MISSED_EVENTS_FILE -> the log in SPARK_ROUTER_LOG_DIR', () => {
  const dir = newDir();
  const env = { ...ALL_LOCAL, SPARK_ROUTER_LOG_DIR: dir };
  const expectedFile = path.join(dir, 'missed-tool-events.jsonl');

  hook(INPUT, env);
  assert.strictEqual(fs.existsSync(expectedFile), true);
  const logLine = fs.readFileSync(expectedFile, 'utf8').trim();
  assert.deepEqual(JSON.parse(logLine), EVENT);
});

test('hook script: a reply that announces a step -> exit 0, the nudge, one log line', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const proc = runScript(JSON.stringify(INPUT), file);

  assert.strictEqual(proc.status, 0);
  const stdout = proc.stdout.trim();
  assert.strictEqual(JSON.parse(stdout).hookSpecificOutput.hookEventName, 'Stop');
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('hook script: stop_hook_active true -> exit 0 and no output', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const input = { ...INPUT, stop_hook_active: true };
  const proc = runScript(JSON.stringify(input), file);

  assert.strictEqual(proc.status, 0);
  assert.strictEqual(proc.stdout, '');
  assert.strictEqual(fs.existsSync(file), false);
});

test('hook script: input that is not JSON -> exit 0 and no output', () => {
  const dir = newDir();
  const file = path.join(dir, 'events.jsonl');
  const proc = runScript('not json', file);

  assert.strictEqual(proc.status, 0);
  assert.strictEqual(proc.stdout, '');
});
