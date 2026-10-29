// The Stop hook of --all-local sessions. A small local model sometimes ends its reply by saying
// what it will do next ("I will now write the file") but makes no tool call. Claude Code then
// ends the turn, and the work stops. This hook finds such a reply, adds one line to the missed
// tool call log, and sends the model back once to make the call.
//
// The hook never stops a session: on any error it prints nothing, and the turn ends as usual.
// The log line holds no reply text, because a reply can hold task or file content.

import fs from 'node:fs';
import path from 'node:path';

import { missedEventsFile } from './config.js';

/** The `kind` of each line that this hook adds to the missed tool call log. */
export const MISSED_TOOL_CALL = 'missed-tool-call';

// Verbs that start a step, in "I will <verb>" and "let me <verb>".
const STEP_VERBS = 'start|begin|proceed|implement|create|write|update|add|run|fix|build|launch'
  + '|dispatch|spawn';

// Words after "Next:" that end in "ing" but do not name a step.
const NOT_A_STEP = 'nothing|anything|something|everything|pending';

/**
 * A reply that matches one of these announces the model's own next step. The patterns cover
 * Gemma wording ("I am now ...", "I will now ...", "Next: Writing ...") and gpt-oss wording
 * ("Launching parallel agents ...", "Next: await ...").
 */
export const ANNOUNCE_PATTERNS = Object.freeze([
  /\b(?:i am|i'm|i will|i'll) now\b/im,
  new RegExp(`\\b(?:i will|i'll) (?:${STEP_VERBS}|send|use)\\b`, 'im'),
  new RegExp(`\\blet me (?:now )?(?:${STEP_VERBS})\\b`, 'im'),
  new RegExp(`^\\W*next\\W*:\\W*(?:i\\b|await\\b|(?!(?:${NOT_A_STEP})\\b)[a-z]+ing\\b)`, 'im'),
  /\b(?:launch|dispatch|spawn|start)(?:ing|es|ed|s)?\b[^.\n]{0,40}\bagents?\b/im,
]);

/** A reply that matches this says it only waits for work that already runs. */
export const WAITING_PATTERN =
  /\b(?:await|awaiting|waiting|in the background|background (?:agent|task|job)s?)\b/i;

/** "Want more?" is a closing offer, not a question that needs the user's answer. */
export const WANT_MORE_PATTERN = /\bwant\s+more\s*\?/gi;

/**
 * True when the session runs on the local model only: ANTHROPIC_DEFAULT_OPUS_MODEL is set to a
 * name that does not start with "claude" (local-agents-cc --all-local sets it), and
 * LOCAL_MODEL_CONTINUE is not "off" (in any case).
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function isAllLocalSession(env) {
  if ((env.LOCAL_MODEL_CONTINUE ?? '').trim().toLowerCase() === 'off') {
    return false;
  }
  const model = (env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '').trim();
  return model !== '' && !model.toLowerCase().startsWith('claude');
}

/**
 * Decides whether to send the model back. Returns the last non-empty line of text (see 3),
 * trimmed, when ALL of these are true, and null otherwise:
 *   1. isAllLocalSession(env).
 *   2. input.stop_hook_active is not true. (Claude Code sets it when a stop hook already sent
 *      the model back. The hook never sends it back twice in a row.)
 *   3. input.last_assistant_message is a string. Call it text, with each curly apostrophe
 *      (U+2019) changed to a straight one (').
 *   4. NOT (input.background_tasks is an array with at least one entry AND WAITING_PATTERN
 *      matches text). A reply that waits for a task that really runs is a correct end of turn.
 *   5. text has at least one line that is not empty after trimming.
 *   6. Neither of the last 2 non-empty lines contains "?" after all matches of
 *      WANT_MORE_PATTERN are removed from it. A real question to the user is a correct end.
 *   7. At least one of ANNOUNCE_PATTERNS matches text.
 * @param {Record<string, unknown>} input - the Stop hook input from Claude Code
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function nudgeLine(input, env) {
  if (!isAllLocalSession(env)) {
    return null;
  }
  if (input.stop_hook_active) {
    return null;
  }
  let text = input.last_assistant_message;
  if (typeof text !== 'string') {
    return null;
  }
  text = text.replace(/\u2019/g, "'");

  if (Array.isArray(input.background_tasks) && input.background_tasks.length > 0) {
    if (WAITING_PATTERN.test(text)) {
      return null;
    }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) {
    return null;
  }

  for (let i = 1; i <= 2; i++) {
    const line = lines[lines.length - i];
    if (line !== undefined && line.replace(WANT_MORE_PATTERN, '').includes('?')) {
      return null;
    }
  }

  if (!ANNOUNCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return null;
  }

  return lines[lines.length - 1];
}

/**
 * The JSON object that the hook prints to send the model back. Claude Code continues the turn
 * and gives the model this text as "Stop hook feedback".
 * @param {string} lastLine - the reply's last non-empty line
 * @returns {{ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: string } }}
 */
export function nudgeOutput(lastLine) {
  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `[local-agents-cc] Your reply says what you will do next ("${
        lastLine.slice(0, 200)}"), but it has no tool call, so nothing happened and the work `
        + 'stopped. Do that step now: make the tool call in your next reply. If you started a '
        + 'background agent and only wait for it, you do not need to reply - its result will '
        + "arrive as a new message. If you need the user's decision instead, ask one clear "
        + 'question.',
    },
  };
}

/**
 * The log line for one missed tool call. It holds no reply text. The keys are in this order:
 *   when: `now` in UTC with 6 digits after the seconds, for example
 *     2026-10-28T17:00:00.123000Z (the toISOString() value with "000" added before the "Z")
 *   session_id: input.session_id when it is a string, else ''
 *   cwd: input.cwd when it is a string, else ''
 *   model: env.ANTHROPIC_DEFAULT_OPUS_MODEL when it is set, else ''
 *   kind: MISSED_TOOL_CALL
 * @param {Record<string, unknown>} input - the Stop hook input from Claude Code
 * @param {NodeJS.ProcessEnv} env
 * @param {Date} now
 * @returns {{ when: string, session_id: string, cwd: string, model: string, kind: string }}
 */
export function missedToolCallEvent(input, env, now) {
  return {
    when: now.toISOString().replace(/Z$/, '000Z'),
    session_id: typeof input.session_id === 'string' ? input.session_id : '',
    cwd: typeof input.cwd === 'string' ? input.cwd : '',
    model: (env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '').toString(),
    kind: MISSED_TOOL_CALL,
  };
}

/**
 * Adds one line to the log: JSON.stringify(event) and '\n', in UTF-8. Creates the log folder
 * when it is missing. Never throws: on any error (no rights, no disk space, a folder in the
 * way) it returns false.
 * @param {string} file
 * @param {object} event
 * @returns {boolean} true when the line was written
 */
export function appendMissedEvent(file, event) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole hook: the Stop hook input (JSON text) in, the text to print out. Never throws.
 *   1. Parse stdinText as JSON, without a byte order mark (U+FEFF) at the start. Not valid
 *      JSON, or not a plain object: return ''.
 *   2. line = nudgeLine(input, env). null: return ''.
 *   3. appendMissedEvent(missedEventsFile(env, platform), missedToolCallEvent(input, env, now)).
 *      The nudge goes out even when the line could not be written.
 *   4. Return JSON.stringify(nudgeOutput(line)) + '\n'.
 *   Any error in these steps: return ''.
 * @param {string} stdinText
 * @param {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, now: Date }} options
 * @returns {string}
 */
export function runStopHook(stdinText, { env, platform, now }) {
  try {
    // Some shells start piped text with a byte order mark, for example Windows PowerShell 5.1
    // when its output encoding is UTF-8. JSON.parse does not accept it.
    const text = stdinText.charCodeAt(0) === 0xfeff ? stdinText.slice(1) : stdinText;
    const input = JSON.parse(text);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return '';
    }
    const line = nudgeLine(input, env);
    if (line === null) {
      return '';
    }
    appendMissedEvent(missedEventsFile(env, platform), missedToolCallEvent(input, env, now));
    return JSON.stringify(nudgeOutput(line)) + '\n';
  } catch {
    return '';
  }
}
