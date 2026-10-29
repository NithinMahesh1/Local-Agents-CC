// claude-agents --setup: asks for the AI server's address, its API key and the model name,
// saves them, and checks that the AI server answers. It does not start the router or Claude Code.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  DEFAULT_LOCAL_URL, SettingsFileError, loadConfig, readConfig, readKeyFile, readSettingsFile,
  settingsFile,
} from './config.js';

/** Thrown when the user presses Ctrl+C or the input ends before an answer. */
export class SetupCancelled extends Error {
  constructor() {
    super('setup stopped');
  }
}

/**
 * Runs the questions, saves the answers and checks the AI server. Returns the exit code:
 * 0 when everything is saved and both checks pass, 1 otherwise.
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ReadableStream & {isTTY?: boolean, setRawMode?: Function}} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {typeof fetch} [options.fetchFn]
 * @param {number} [options.timeoutMs] - time limit of each check
 * @returns {Promise<number>}
 */
export async function runSetup({
  env = process.env,
  platform = process.platform,
  input = process.stdin,
  output = process.stdout,
  fetchFn = fetch,
  timeoutMs = 5000,
} = {}) {
  const say = (text = '') => output.write(`${text}\n`);
  const file = settingsFile(env, platform);
  const reader = createLineReader(input, output);
  try {
    // A broken settings file or environment variable must not stop the setup that repairs it.
    let current;
    try {
      current = loadConfig(env, platform);
    } catch (error) {
      if (error instanceof SettingsFileError) {
        say(`Note: the saved settings cannot be used: ${error.message}.`);
        say('Setup replaces them.');
      }
      const variableProblem = envProblem(env, platform);
      if (variableProblem !== null) {
        say(`Note: ${variableProblem}.`);
        say('Setup cannot change environment variables. Fix or remove this one, or');
        say('claude-agents does not start.');
      }
      say();
      current = readConfig(withoutRouterVars(env), platform, {});
    }
    say('This saves the details of your AI server: the computer that runs your local model.');
    say(`The address and the model name go in ${file}`);
    say(`The API key goes in ${current.keyFile}`);
    say('Press Enter to keep a value in [brackets].');
    say();

    const oldUrl = current.localUrl === DEFAULT_LOCAL_URL ? undefined : current.localUrl;
    const localUrl = await askUrl(reader, oldUrl, say);
    const { key, isNew } = await askKey(reader, current.keyFile, say);

    say();
    say('Checking the AI server...');
    const check = await checkServer({ localUrl, key, fetchFn, timeoutMs, say });
    const localModel = await askModel(reader, check.models, current.localModels[0], say);
    if (!check.ok) {
      const save = await ask(reader, 'The checks failed. Save these settings anyway? (y/n)', 'n');
      if (!/^y/i.test(save)) {
        say('Nothing was saved. Fix the problem, then run claude-agents --setup again.');
        return 1;
      }
    }

    if (isNew) {
      saveKeyFile(current.keyFile, key, platform);
    }
    const settings = { ...readSettingsOrEmpty(file), localUrl, localModels: [localModel] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);

    say();
    say(`Saved. AI server: ${localUrl}  Model: ${localModel}`);
    for (const name of ['SPARK_ROUTER_LOCAL_URL', 'SPARK_ROUTER_LOCAL_MODELS']) {
      if (typeof env[name] === 'string' && env[name].trim() !== '') {
        say(`Note: ${name} is set, so its value is used instead of the saved one.`);
      }
    }
    say('If the router is running, stop it (README FAQ: "How do I stop or restart the router?").');
    say('The next claude-agents starts it again with these settings.');
    if (!check.ok) {
      say('The checks above failed. Fix the problem, then run claude-agents --setup again.');
      return 1;
    }
    say('Start a session with: claude-agents');
    return 0;
  } catch (error) {
    if (error instanceof SetupCancelled) {
      say();
      say('Setup stopped. Nothing was saved.');
      return 1;
    }
    throw error;
  } finally {
    reader.close();
  }
}

/**
 * Reads one answer at a time. In a terminal, the typing of a hidden answer is not shown.
 * When the input is not a terminal (a pipe or a test), it reads plain lines.
 * @param {NodeJS.ReadableStream & {isTTY?: boolean, setRawMode?: Function}} input
 * @param {NodeJS.WritableStream} output
 * @returns {{hidesTyping: boolean,
 *   question: (prompt: string, options?: {hidden?: boolean}) => Promise<string>,
 *   close: () => void}}
 */
export function createLineReader(input, output) {
  const terminal = Boolean(input.isTTY) && typeof input.setRawMode === 'function';
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let ended = false;
  let skipLineFeed = false;
  let waiting = null;

  const onData = (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    pump();
  };
  const onEnd = () => {
    ended = true;
    pump();
  };
  input.on('data', onData);
  input.on('end', onEnd);
  input.pause();

  function finish(answer, error) {
    const { resolve, reject } = waiting;
    waiting = null;
    if (terminal) {
      input.setRawMode(false);
    }
    input.pause();
    if (error) {
      reject(error);
    } else {
      resolve(answer);
    }
  }

  function pump() {
    if (waiting === null) {
      return;
    }
    if (terminal) {
      pumpTerminal();
      return;
    }
    const end = buffer.indexOf('\n');
    if (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      finish(line);
    } else if (ended) {
      const rest = buffer;
      buffer = '';
      finish(rest, rest === '' ? new SetupCancelled() : undefined);
    }
  }

  // Raw mode: each key arrives as typed. Enter ends the answer, Ctrl+C stops the setup.
  function pumpTerminal() {
    while (buffer.length > 0 && waiting !== null) {
      // An arrow key sends ESC [ A or ESC O A. Wait when the rest has not arrived yet. A lone
      // ESC is dropped at once, so that a Ctrl+C after it still stops the setup.
      if (/^\x1b(\[[0-9;]*|O)$/.test(buffer)) {
        break;
      }
      const escape = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|[\x20-\x7e])?/.exec(buffer);
      if (escape !== null) {
        buffer = buffer.slice(escape[0].length);
        continue;
      }
      const char = buffer[0];
      buffer = buffer.slice(1);
      if (char === '\n' && skipLineFeed) {
        skipLineFeed = false;
        continue;
      }
      skipLineFeed = false;
      if (char === '\r' || char === '\n') {
        skipLineFeed = char === '\r';
        output.write('\n');
        finish(waiting.answer);
      } else if (char === '\x03' || char === '\x04') {
        output.write('\n');
        finish('', new SetupCancelled());
      } else if (char === '\x7f' || char === '\b') {
        if (waiting.answer.length > 0) {
          waiting.answer = waiting.answer.slice(0, -1);
          if (!waiting.hidden) {
            output.write('\b \b');
          }
        }
      } else if (char >= ' ') {
        waiting.answer += char;
        if (!waiting.hidden) {
          output.write(char);
        }
      }
    }
    if (ended && waiting !== null) {
      finish('', new SetupCancelled());
    }
  }

  return {
    /** True when the typing of a hidden answer is not shown (the input is a terminal). */
    hidesTyping: terminal,
    question(prompt, { hidden = false } = {}) {
      if (waiting !== null) {
        return Promise.reject(new Error('one question at a time'));
      }
      output.write(prompt);
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject, hidden, answer: '' };
        if (terminal) {
          input.setRawMode(true);
        }
        input.resume();
        pump();
      });
    },
    close() {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.pause();
    },
  };
}

/**
 * The address as the router uses it: an http:// or https:// URL without a slash at the end.
 * "my-ai-server.local:8000" becomes "http://my-ai-server.local:8000". Returns null when the
 * text is not usable.
 * @param {string} text
 * @returns {string | null}
 */
export function normalizeServerUrl(text) {
  let value = text.trim();
  if (value === '') {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '') {
    return null;
  }
  return value.replace(/\/+$/, '');
}

/**
 * Checks the AI server: GET /health (no key needed) and GET /v1/models (with the key).
 * @returns {Promise<{ok: boolean, models: string[]}>} ok is true when both checks pass
 */
export async function checkServer({ localUrl, key, fetchFn, timeoutMs, say }) {
  const origin = new URL(localUrl).origin;
  try {
    const health = await fetchFn(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!health.ok) {
      say(`- The AI server answered /health with HTTP ${health.status}. Is the model still `
        + 'starting?');
      return { ok: false, models: [] };
    }
    say('- The AI server answers.');
  } catch (error) {
    say(`- No answer from ${origin}/health (${reasonOf(error)}). Check the address, and that `
      + 'the AI server is on.');
    return { ok: false, models: [] };
  }

  try {
    const response = await fetchFn(`${origin}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      say(`- The AI server refused the API key (HTTP ${response.status}). Check the key.`);
      return { ok: false, models: [] };
    }
    if (!response.ok) {
      say(`- The AI server answered /v1/models with HTTP ${response.status}.`);
      return { ok: false, models: [] };
    }
    const body = await response.json();
    const models = Array.isArray(body?.data)
      ? body.data.map((model) => model?.id).filter((id) => typeof id === 'string' && id !== '')
      : [];
    say('- The AI server accepts the API key.');
    return { ok: true, models };
  } catch (error) {
    say(`- The check of /v1/models failed (${reasonOf(error)}).`);
    return { ok: false, models: [] };
  }
}

async function askUrl(reader, oldUrl, say) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const hint = oldUrl === undefined ? ' (for example http://my-ai-server.local:8000)' : '';
    const answer = await ask(reader, `AI server address${hint}`, oldUrl);
    const url = normalizeServerUrl(answer);
    if (url !== null) {
      return url;
    }
    say('Type an address such as http://my-ai-server.local:8000 or http://<IP address>:8000.');
  }
  throw new Error('no usable AI server address after 3 tries');
}

async function askKey(reader, keyFile, say) {
  let savedKey = null;
  try {
    savedKey = readKeyFile(keyFile);
  } catch {
    savedKey = null;
  }
  if (savedKey !== null) {
    const keep = await ask(reader, 'An API key is saved already. Keep it? (y/n)', 'y');
    if (!/^n/i.test(keep)) {
      return { key: savedKey, isNew: false };
    }
  }
  say('The API key is the key that your AI server checks (for vLLM: VLLM_API_KEY or --api-key).');
  // Some terminals (for example Git Bash in its own window) do not let a program hide the typing.
  const prompt = reader.hidesTyping
    ? 'API key (the typing is not shown): '
    : 'API key (this terminal shows what you type): ';
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = (await reader.question(prompt, { hidden: true })).trim();
    if (key !== '') {
      return { key, isNew: true };
    }
    say('The key cannot be empty.');
  }
  throw new Error('no API key after 3 tries');
}

async function askModel(reader, models, oldModel, say) {
  if (models.length === 0) {
    return ask(reader, 'Model name (the name your AI server serves)', oldModel);
  }
  say('Models on the AI server:');
  models.forEach((model, index) => say(`  ${index + 1}. ${model}`));
  const fallback = models.includes(oldModel) ? oldModel : models[0];
  const answer = await ask(reader, 'Model name or number', fallback);
  const number = /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
  return number >= 1 && number <= models.length ? models[number - 1] : answer;
}

async function ask(reader, prompt, fallback) {
  const suffix = fallback === undefined || fallback === '' ? ': ' : ` [${fallback}]: `;
  const answer = (await reader.question(`${prompt}${suffix}`)).trim();
  return answer === '' ? (fallback ?? '') : answer;
}

// The message of a SPARK_ROUTER_* environment variable that cannot be used, or null.
function envProblem(env, platform) {
  try {
    readConfig(env, platform, {});
    return null;
  } catch (error) {
    return error.message;
  }
}

// The environment without the variables that readConfig checks, for a start from the defaults.
function withoutRouterVars(env) {
  const {
    SPARK_ROUTER_LOCAL_URL: _url, SPARK_ROUTER_LOCAL_MODELS: _models, SPARK_ROUTER_PORT: _port,
    ...rest
  } = env;
  return rest;
}

// The settings file, or {} when it cannot be read: setup replaces a broken file.
function readSettingsOrEmpty(file) {
  try {
    return readSettingsFile(file);
  } catch {
    return {};
  }
}

// Writes the key with a line break. Only the owner can read the file (on macOS and Linux).
function saveKeyFile(keyFile, key, platform) {
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  if (platform !== 'win32') {
    fs.chmodSync(keyFile, 0o600);
  }
}

function reasonOf(error) {
  if (error?.name === 'TimeoutError') {
    return 'no answer in time';
  }
  return error?.cause?.code ?? error?.message ?? 'unknown error';
}
