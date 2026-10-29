// claude-agents: starts Claude Code pointed at spark-router, and starts the router first when
// it does not answer. Only the session's environment changes (see buildSession in session.js),
// so your claude.ai login, plan limits and billing stay the same.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { HEALTH_PATH, isLocalModel, missedEventsFile, readConfig } from './config.js';
import { formatMissedSummary, parseMissedEvents, summarizeMissedEvents } from './missed-events.js';
import { buildSession, helpText, parseArgs } from './session.js';
import { claudeSettingsPath, readSavedModel, restoreSavedModel } from './settings-guard.js';
import { resolveCommand, spawnCommand } from './spawn-command.js';

// While a new router starts, ask this often whether it answers yet.
const POLL_INTERVAL_MS = 250;

// The Claude Code plugin that --all-local sessions load. It holds the Stop hook that sends the
// local model back when a reply announces a step but makes no tool call.
const PLUGIN_DIR = fileURLToPath(new URL('../plugin', import.meta.url));

/**
 * Asks the router for its health. Never throws.
 * @param {string} routerUrl - for example http://127.0.0.1:8799
 * @param {number} [timeoutMs]
 * @returns {Promise<{ router: string, local_model_server: string } | null>} null when the
 *   router does not answer, answers with an error, or does not answer with the health JSON
 */
export async function getRouterHealth(routerUrl, timeoutMs = 4000) {
  try {
    const response = await fetch(routerUrl + HEALTH_PATH, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    const body = await response.json();
    if (body?.router !== 'ok' || typeof body.local_model_server !== 'string') {
      return null;
    }
    return { router: body.router, local_model_server: body.local_model_server };
  } catch {
    return null;
  }
}

/**
 * Starts `spark-router` in the background with no window. It keeps running after this
 * process ends. Its output goes to router.log and router-errors.log in logDir; the logs of
 * the run before are kept as router.previous.log and router-errors.previous.log.
 * @param {{ logDir: string, env?: NodeJS.ProcessEnv }} options
 * @returns {import('node:child_process').ChildProcess}
 */
export function startRouterProcess({ logDir, env }) {
  fs.mkdirSync(logDir, { recursive: true });
  keepPreviousLog(logDir, 'router');
  keepPreviousLog(logDir, 'router-errors');
  const outFd = fs.openSync(path.join(logDir, 'router.log'), 'a');
  let errFd = null;
  try {
    errFd = fs.openSync(path.join(logDir, 'router-errors.log'), 'a');
    const routerBin = fileURLToPath(new URL('../bin/spark-router.js', import.meta.url));
    const child = spawn(process.execPath, [routerBin], {
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      env: env ?? process.env,
      cwd: path.dirname(routerBin),
    });
    // The router must keep running after this process ends, for the sessions that come later.
    child.unref();
    return child;
  } finally {
    // The router has its own copy of the log files. This process does not need them open.
    fs.closeSync(outFd);
    if (errFd !== null) {
      fs.closeSync(errFd);
    }
  }
}

/**
 * Returns the router's health, and starts the router first when it does not answer.
 * @param {{ routerUrl: string, logDir: string, note: (message: string) => void,
 *   env?: NodeJS.ProcessEnv, startTimeoutMs?: number,
 *   start?: (options: { logDir: string, env?: NodeJS.ProcessEnv }) =>
 *     import('node:child_process').ChildProcess }} options
 * @returns {Promise<{ router: string, local_model_server: string }>}
 * @throws {Error} when the router does not answer in time
 */
export async function ensureRouter({
  routerUrl,
  logDir,
  note,
  env,
  startTimeoutMs = 15000,
  start = startRouterProcess,
}) {
  const health = await getRouterHealth(routerUrl);
  if (health !== null) {
    return health;
  }
  note(`starting spark-router (log: ${path.join(logDir, 'router.log')}) ...`);
  const child = start({ logDir, env });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  child.on('error', () => {
    exited = true;
  });
  // The health check comes first in each round: when the router just exited, another launcher
  // may have started a router that answers now.
  const deadline = Date.now() + startTimeoutMs;
  while (!exited && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    const answer = await getRouterHealth(routerUrl, 1000);
    if (answer !== null) {
      return answer;
    }
  }
  throw new Error(`spark-router did not start - see ${path.join(logDir, 'router-errors.log')}`);
}

/**
 * Runs claude-agents and returns the exit code (claude's exit code after a session).
 * @param {string[]} argv - the arguments after the command name
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
 *   stdout?: { write: (text: string) => unknown },
 *   stderr?: { write: (text: string) => unknown } }} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, {
  env = process.env,
  platform = process.platform,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const note = (message) => stderr.write(`claude-agents: ${message}\n`);
  const { allLocal, showHelp, missedToolCalls, missedEventsFile: eventsFileArg, claudeArgs } =
    parseArgs(argv);

  if (eventsFileArg !== null && !missedToolCalls) {
    note('--missed-events-file works only together with --missed-tool-calls.');
    return 1;
  }
  if (missedToolCalls) {
    if (eventsFileArg === '') {
      note('--missed-events-file needs a file path.');
      return 1;
    }
    return printMissedToolCalls(eventsFileArg ?? missedEventsFile(env, platform), stdout, note);
  }

  let config;
  try {
    config = readConfig(env, platform);
  } catch (error) {
    note(error.message);
    return 1;
  }
  const localModel = config.localModels[0];

  if (showHelp) {
    stdout.write(helpText({ routerUrl: config.routerUrl, logDir: config.logDir, localModel }));
    return 0;
  }

  let health;
  try {
    health = await ensureRouter({ routerUrl: config.routerUrl, logDir: config.logDir, note, env });
  } catch (error) {
    note(error.message);
    return 1;
  }
  if (health.local_model_server !== 'ok') {
    if (allLocal) {
      note('the local model server is not answering, and --all-local needs it. '
        + 'Try again when the box is up.');
      return 1;
    }
    note('warning - the local model server is not answering. Claude models still work.');
  }

  const session = buildSession({
    baseEnv: env,
    routerUrl: config.routerUrl,
    localModel,
    allLocal,
    claudeArgs,
    pluginDir: allLocal ? hookPluginDir(env, platform, note) : null,
  });
  for (const message of session.notes) {
    note(message);
  }

  const claudePath = resolveCommand('claude', { env, platform });
  if (claudePath === null) {
    note('claude was not found on PATH. '
      + 'Install Claude Code first: https://github.com/anthropics/claude-code');
    return 1;
  }

  // If the saved default model already is a local model (an earlier session did not clean
  // up), there is no Claude model to put back. The guard then removes the line, so Claude Code
  // uses the default model for your plan.
  const settingsPath = claudeSettingsPath(env);
  let modelBefore = readSavedModel(settingsPath);
  if (isLocalModel(config.localModels, modelBefore)) {
    modelBefore = '';
  }

  try {
    return await runClaude(claudePath, session, platform, note);
  } finally {
    restoreSavedModel({ settingsPath, localModel, modelBefore, note });
  }
}

// Prints the counts of the missed tool call log for --missed-tool-calls. A log that does not
// exist yet counts as empty. Returns the exit code.
function printMissedToolCalls(file, stdout, note) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      note(`cannot read ${file} (${error.code ?? 'unknown error'})`);
      return 1;
    }
  }
  const { events, skipped } = parseMissedEvents(text);
  stdout.write(formatMissedSummary(summarizeMissedEvents(events), { file, skipped }));
  return 0;
}

// The plugin folder for an --all-local session. Claude Code starts the plugin's hook with the
// `node` command, so without node on PATH the session runs without the plugin.
function hookPluginDir(env, platform, note) {
  if (resolveCommand('node', { env, platform }) === null) {
    note('node is not on PATH, so the check for missed tool calls is off for this session.');
    return null;
  }
  return PLUGIN_DIR;
}

// Moves <name>.log to <name>.previous.log (it replaces an older one), so each run of the router
// starts a fresh log and the run before it can still be read. When the log cannot move (there
// is none yet, or on Windows another program such as a log viewer holds it open), the new run
// adds to the same log. The router must still start.
function keepPreviousLog(logDir, name) {
  try {
    fs.renameSync(path.join(logDir, `${name}.log`), path.join(logDir, `${name}.previous.log`));
  } catch {
    // Not moved. The log is opened for append next.
  }
}

// Starts claude and waits until it ends. Returns claude's exit code, or 1 when claude cannot
// start. While claude runs, this process keeps its own signal handling out of the way.
async function runClaude(claudePath, session, platform, note) {
  let child;
  try {
    child = spawnCommand(
      claudePath,
      session.args,
      { stdio: 'inherit', env: session.env },
      platform,
    );
  } catch (error) {
    note(`could not start claude: ${error.message}`);
    return 1;
  }

  // Claude Code handles Ctrl+C itself, so this process ignores it. A request to stop this
  // process (SIGTERM, SIGHUP) goes on to claude.
  const handlers = {
    SIGINT: () => {},
    SIGTERM: () => forwardSignal(child, 'SIGTERM'),
    SIGHUP: () => forwardSignal(child, 'SIGHUP'),
  };
  for (const [signal, handler] of Object.entries(handlers)) {
    process.on(signal, handler);
  }
  try {
    return await new Promise((resolve) => {
      child.once('error', (error) => {
        note(`could not start claude: ${error.message}`);
        resolve(1);
      });
      child.once('exit', (code, signal) => {
        resolve(exitCodeOf(code, signal));
      });
    });
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) {
      process.off(signal, handler);
    }
  }
}

// Sends a signal to claude. Some systems cannot send some signals (for example SIGHUP on
// Windows); there is nothing else to do then.
function forwardSignal(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // Not supported here.
  }
}

// claude's exit code. When a signal ended claude, use the shell rule: 128 + the signal number.
function exitCodeOf(code, signal) {
  return code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
}
