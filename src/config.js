// Settings for spark-router and claude-agents, read from environment variables and from the
// settings file that `claude-agents --setup` writes. An environment variable wins over the file.
// Every setting has a default, so the only file you must create is the AI server's API key file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every request that is not for a local model goes here. It is fixed on purpose: no setting
 * can send your Claude login to a different address.
 */
export const ANTHROPIC_URL = 'https://api.anthropic.com';

/** spark-router answers this path itself, for the launcher. It never forwards it. */
export const HEALTH_PATH = '/__spark-router/health';

export const DEFAULT_PORT = 8799;
export const DEFAULT_LOCAL_MODEL = 'local-model';
export const DEFAULT_LOCAL_URL = 'http://your-ai-server.local:8000';
export const DEFAULT_MODEL_OPTION_NAME = 'Local Agents';

/**
 * A problem in the settings file that `claude-agents --setup` writes. Running the setup again
 * replaces the file.
 */
export class SettingsFileError extends Error {}

/**
 * Reads the settings from environment variables.
 *
 *   SPARK_ROUTER_PORT          port on 127.0.0.1 (default 8799)
 *   SPARK_ROUTER_LOCAL_MODELS  comma-separated model names that go to the AI server
 *     (default local-model)
 *   SPARK_ROUTER_LOCAL_URL     the AI server's address (default http://your-ai-server.local:8000)
 *   SPARK_ROUTER_KEY_FILE      file with the AI server's API key (default
 *     <home>/.config/local-model/api-key)
 *   SPARK_ROUTER_LOG_DIR       folder for the router's log files (default: see defaultLogDir)
 *
 * The local servers come from the first of these that applies:
 *   1. SPARK_ROUTER_LOCAL_URL or SPARK_ROUTER_LOCAL_MODELS is set: one server named "local".
 *      A value that is not set comes from the legacy keys of `settings`, then the default.
 *   2. `settings.servers` is set: one entry per server. The legacy keys are then ignored.
 *   3. `settings.localUrl` or `settings.localModels` is set: one server named "local".
 *   4. The defaults: one server named "local".
 * `localUrl`, `localModels` and `keyFile` in the result are the values of the first server, so
 * code that uses one server keeps working.
 *
 * `modelOptionName` is the label of the local model in the Claude Code /model menu. It comes
 * from `settings.modelOptionName` (settings file only), else "Local Agents".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {{localUrl?: string, localModels?: string[], servers?: object[],
 *   modelOptionName?: string}} [settings]
 * @returns {{port: number, localModels: string[], localUrl: string, keyFile: string,
 *   modelOptionName: string,
 *   servers: {name: string, url: string, models: string[], type: 'anthropic' | 'openai',
 *   keyFile: string}[], logDir: string, routerUrl: string}}
 * @throws {Error} when a variable holds a value that cannot be used
 * @throws {SettingsFileError} when a value from `settings` cannot be used
 */
export function readConfig(env = process.env, platform = process.platform, settings = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = homeDir(env, platform);
  const port = parsePort(env.SPARK_ROUTER_PORT);
  const defaultKeyFile = nonEmpty(env.SPARK_ROUTER_KEY_FILE)
    ?? paths.join(home, '.config', 'local-model', 'api-key');
  const modelsFromEnv = nonEmpty(env.SPARK_ROUTER_LOCAL_MODELS);
  const urlFromEnv = nonEmpty(env.SPARK_ROUTER_LOCAL_URL);
  let servers;
  if (modelsFromEnv === undefined && urlFromEnv === undefined && settings.servers !== undefined) {
    servers = normalizeServers(settings.servers, 'the settings file', defaultKeyFile);
  } else {
    servers = [{
      name: 'local',
      url: urlFromEnv !== undefined || settings.localUrl === undefined
        ? parseLocalUrl(env.SPARK_ROUTER_LOCAL_URL, 'SPARK_ROUTER_LOCAL_URL')
        : parseLocalUrl(settings.localUrl, '"localUrl" in the settings file', SettingsFileError),
      models: modelsFromEnv !== undefined || settings.localModels === undefined
        ? parseModelList(env.SPARK_ROUTER_LOCAL_MODELS, 'SPARK_ROUTER_LOCAL_MODELS')
        : parseModelList(
          settings.localModels.join(','), '"localModels" in the settings file', SettingsFileError,
        ),
      type: 'anthropic',
      keyFile: defaultKeyFile,
    }];
  }
  return {
    port,
    localModels: servers[0].models,
    localUrl: servers[0].url,
    keyFile: servers[0].keyFile,
    servers,
    modelOptionName: nonEmpty(settings.modelOptionName) ?? DEFAULT_MODEL_OPTION_NAME,
    logDir: nonEmpty(env.SPARK_ROUTER_LOG_DIR) ?? defaultLogDir(env, platform, home),
    routerUrl: `http://127.0.0.1:${port}`,
  };
}

/**
 * Reads the settings from the environment variables and the settings file.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {ReturnType<typeof readConfig>}
 * @throws {Error} when a variable holds a value that cannot be used
 * @throws {SettingsFileError} when the settings file cannot be used
 */
export function loadConfig(env = process.env, platform = process.platform) {
  return readConfig(env, platform, readSettingsFile(settingsFile(env, platform)));
}

/**
 * The settings file that `claude-agents --setup` writes: <home>/.config/local-model/settings.json
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function settingsFile(env = process.env, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.join(homeDir(env, platform), '.config', 'local-model', 'settings.json');
}

/**
 * Reads the settings file. A file that does not exist gives {}. Other keys in the file are
 * kept, so a later version can add settings.
 * @param {string} file
 * @returns {{localUrl?: string, localModels?: string[], servers?: object[]}
 *   & Record<string, unknown>}
 * @throws {SettingsFileError} when the file cannot be read, is not JSON, or holds a value of
 *   the wrong type
 */
export function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw new SettingsFileError(
      `cannot read the settings file ${file} (${error.code ?? 'unknown error'})`,
    );
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new SettingsFileError(`the settings file ${file} is not valid JSON`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new SettingsFileError(`the settings file ${file} must hold a JSON object`);
  }
  if (settings.localUrl !== undefined && typeof settings.localUrl !== 'string') {
    throw new SettingsFileError(`"localUrl" in the settings file ${file} must be a string`);
  }
  if (settings.localModels !== undefined && (!Array.isArray(settings.localModels)
    || !settings.localModels.every((name) => typeof name === 'string'))) {
    throw new SettingsFileError(
      `"localModels" in the settings file ${file} must be a list of strings`,
    );
  }
  if (settings.localModels !== undefined
    && settings.localModels.every((name) => name.trim() === '')) {
    throw new SettingsFileError(
      `"localModels" in the settings file ${file} must name at least one model`,
    );
  }
  if (settings.modelOptionName !== undefined && nonEmpty(settings.modelOptionName) === undefined) {
    throw new SettingsFileError(
      `"modelOptionName" in the settings file ${file} must be a non-empty string`,
    );
  }
  if (settings.servers !== undefined) {
    normalizeServers(settings.servers, `the settings file ${file}`, '');
  }
  return settings;
}

/**
 * The file where the Stop hook of --all-local sessions records each missed tool call, one JSON
 * line per event (see stop-nudge.js). Never throws.
 *
 *   SPARK_MISSED_EVENTS_FILE   the whole path of the file
 *   SPARK_ROUTER_LOG_DIR       otherwise the file is missed-tool-events.jsonl in this folder
 *
 * With neither variable, the file is in the router's default log folder (see defaultLogDir).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function missedEventsFile(env = process.env, platform = process.platform) {
  const file = nonEmpty(env.SPARK_MISSED_EVENTS_FILE);
  if (file !== undefined) {
    return file;
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const logDir = nonEmpty(env.SPARK_ROUTER_LOG_DIR)
    ?? defaultLogDir(env, platform, homeDir(env, platform));
  return paths.join(logDir, 'missed-tool-events.jsonl');
}

/**
 * True when `model` is one of the local model names. The names are compared without regard
 * to upper or lower case.
 * @param {string[]} localModels
 * @param {string} model
 * @returns {boolean}
 */
export function isLocalModel(localModels, model) {
  const wanted = model.toLowerCase();
  return localModels.some((name) => name.toLowerCase() === wanted);
}

/**
 * Reads the AI server's API key: the text of the file, without spaces or line breaks at either end.
 * @param {string} keyFile
 * @returns {string}
 * @throws {Error} when the file is missing, cannot be read or is empty. The message names
 *   the file, never the key.
 */
export function readKeyFile(keyFile) {
  let text;
  try {
    text = fs.readFileSync(keyFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`key file not found: ${keyFile}`);
    }
    throw new Error(`cannot read key file ${keyFile} (${error.code ?? 'unknown error'})`);
  }
  const key = text.trim();
  if (key.length === 0) {
    throw new Error(`key file is empty: ${keyFile}`);
  }
  return key;
}

/**
 * The version in this package's package.json.
 * @returns {string}
 */
export function packageVersion() {
  const file = new URL('../package.json', import.meta.url);
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

// The value without spaces at either end, or undefined when it is missing or blank.
function nonEmpty(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

function homeDir(env, platform) {
  const fromEnv = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return nonEmpty(fromEnv) ?? os.homedir();
}

// Windows: %LOCALAPPDATA%\spark-router. macOS: ~/Library/Logs/spark-router.
// Other systems: $XDG_STATE_HOME/spark-router, or ~/.local/state/spark-router.
function defaultLogDir(env, platform, home) {
  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(localAppData, 'spark-router');
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Logs', 'spark-router');
  }
  const stateHome = nonEmpty(env.XDG_STATE_HOME) ?? path.posix.join(home, '.local', 'state');
  return path.posix.join(stateHome, 'spark-router');
}

function parsePort(value) {
  const text = nonEmpty(value);
  if (text === undefined) {
    return DEFAULT_PORT;
  }
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SPARK_ROUTER_PORT must be a whole number from 1 to 65535 (got "${value}")`);
  }
  return port;
}

// Splits the comma-separated list. Blank names and repeated names (in any case) are left out.
function parseModelList(value, source, ErrorType = Error) {
  const text = nonEmpty(value);
  if (text === undefined) {
    return [DEFAULT_LOCAL_MODEL];
  }
  const names = text.split(',')
    .map((part) => part.trim())
    .filter((name) => name !== '')
    .filter((name, index, all) => all.findIndex((other) => isLocalModel([other], name)) === index);
  if (names.length === 0) {
    throw new ErrorType(`${source} must name at least one model (got "${value}")`);
  }
  return names;
}

// Checks the "servers" list of the settings file and returns it in one shape:
// [{ name, url, models, type, keyFile }]. `where` names the file in the messages.
function normalizeServers(list, where, defaultKeyFile) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new SettingsFileError(`"servers" in ${where} must be a list with at least one server`);
  }
  const names = new Set();
  const modelNames = new Set();
  return list.map((item, index) => {
    const label = `"servers[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SettingsFileError(`${label}" in ${where} must be an object`);
    }
    const name = nonEmpty(item.name);
    if (name === undefined) {
      throw new SettingsFileError(`${label}.name" in ${where} must be a non-empty string`);
    }
    if (names.has(name.toLowerCase())) {
      throw new SettingsFileError(`${label}.name" in ${where} repeats the server name "${name}"`);
    }
    names.add(name.toLowerCase());
    if (nonEmpty(item.url) === undefined) {
      throw new SettingsFileError(`${label}.url" in ${where} must be a non-empty string`);
    }
    const url = parseLocalUrl(item.url, `${label}.url" in ${where}`, SettingsFileError);
    const models = normalizeServerModels(item.models, `${label}.models" in ${where}`, modelNames);
    const type = item.type === undefined ? 'anthropic' : item.type;
    if (type !== 'anthropic' && type !== 'openai') {
      throw new SettingsFileError(
        `${label}.type" in ${where} must be "anthropic" or "openai" (got ${JSON.stringify(type)})`,
      );
    }
    if (item.keyFile !== undefined && nonEmpty(item.keyFile) === undefined) {
      throw new SettingsFileError(`${label}.keyFile" in ${where} must be a non-empty string`);
    }
    return { name, url, models, type, keyFile: nonEmpty(item.keyFile) ?? defaultKeyFile };
  });
}

// The model names of one server. A name must not appear twice in the whole list (any case).
function normalizeServerModels(list, source, seen) {
  if (!Array.isArray(list) || list.length === 0
    || !list.every((name) => nonEmpty(name) !== undefined)) {
    throw new SettingsFileError(`${source} must be a list of non-empty strings`);
  }
  return list.map((entry) => {
    const name = entry.trim();
    if (seen.has(name.toLowerCase())) {
      throw new SettingsFileError(`${source} repeats the model name "${name}"`);
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

function parseLocalUrl(value, source, ErrorType = Error) {
  const text = nonEmpty(value);
  if (text === undefined) {
    return DEFAULT_LOCAL_URL;
  }
  if (!URL.canParse(text) || !['http:', 'https:'].includes(new URL(text).protocol)) {
    throw new ErrorType(
      `${source} must be an http:// or https:// address (got "${value}")`
    );
  }
  return text;
}
