// claude-agents --add-server: adds another AI server to the settings file. It asks for the new
// server's name, address, which software it runs (the API type), API key and model name, checks
// that the server answers, and saves it in the "servers" list in the settings file. The first
// time it runs on a single-server (localUrl/localModels) file, it moves that server into the
// list, and offers to rename it. It does not start the router or Claude Code.

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_LOCAL_MODEL, DEFAULT_LOCAL_URL, SettingsFileError, readConfig, readSettingsFile,
  settingsFile,
} from './config.js';
import {
  SetupCancelled, ask, askKey, askModel, askSoftware, checkServer, createLineReader,
  normalizeServerUrl, readSettingsOrEmpty, saveKeyFile, withoutRouterVars,
} from './setup.js';

/**
 * Runs the questions, checks the new server and adds it to the settings file. Returns the exit
 * code: 0 when the server is saved, 1 otherwise (cancelled, no existing setup, or the check
 * failed and the user did not save anyway).
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ReadableStream & {isTTY?: boolean, setRawMode?: Function}} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {typeof fetch} [options.fetchFn]
 * @param {number} [options.timeoutMs] - time limit of each check
 * @returns {Promise<number>}
 */
export async function runAddServer({
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
    let raw;
    try {
      raw = readSettingsFile(file);
    } catch (error) {
      if (error instanceof SettingsFileError) {
        say(`The settings file cannot be used: ${error.message}. Run claude-agents --setup first.`);
        return 1;
      }
      throw error;
    }

    if (!raw.servers && !raw.localUrl && !raw.localModels) {
      say('No AI server is set up yet. Run claude-agents --setup first.');
      return 1;
    }

    const cfg = readConfig(withoutRouterVars(env), platform, raw);
    let existingServers = cfg.servers;
    const migrating = raw.servers === undefined;
    const keyDir = path.dirname(cfg.keyFile);

    if (migrating) {
      const existingName = await ask(
        reader, 'Name for your existing server', existingServers[0].name,
      );
      existingServers = [{ ...existingServers[0], name: existingName }];
    }

    let name;
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await ask(reader, 'Name for the new server');
      if (answer && !existingServers.some((s) => s.name.toLowerCase() === answer.toLowerCase())) {
        name = answer;
        break;
      }
      if (attempt < 2) {
        say(answer ? `A server named "${answer}" already exists.` : 'Name cannot be empty.');
      }
    }
    if (!name) {
      throw new Error('no usable server name after 3 tries');
    }

    let url;
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await ask(
        reader, 'Address of the new server (for example http://127.0.0.1:1234)',
      );
      url = normalizeServerUrl(answer);
      if (url !== null) {
        break;
      }
      if (attempt < 2) {
        say('Type an address such as http://my-ai-server.local:8000 or http://<IP address>:8000.');
      }
    }
    if (!url) {
      throw new Error('no usable server address after 3 tries');
    }

    const type = await askSoftware(reader, 'anthropic', say);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
    const newKeyFile = path.join(keyDir, `api-key-${slug}`);
    const { key } = await askKey(reader, newKeyFile, say);

    say('');
    say('Checking the new server...');
    const check = await checkServer({ localUrl: url, key, type, fetchFn, timeoutMs, say });

    let model;
    for (let attempt = 0; attempt < 3; attempt++) {
      model = await askModel(reader, check.models, undefined, say);
      const lower = model.toLowerCase();
      if (model && !existingServers.some((s) => s.models.some((m) => m.toLowerCase() === lower))) {
        break;
      }
      if (attempt < 2) {
        say(`A server already uses model "${model}".`);
      }
    }
    if (!model) {
      throw new Error('no usable model name after 3 tries');
    }

    if (!check.ok) {
      const save = await ask(reader, 'The check failed. Add this server anyway? (y/n)', 'n');
      if (!/^y/i.test(save)) {
        say('Nothing was added.');
        return 1;
      }
    }

    saveKeyFile(newKeyFile, key, platform);
    const newServer = { name, url, models: [model], type, keyFile: newKeyFile };
    const updatedServers = [...existingServers, newServer];
    const { localUrl: _lUrl, localModels: _lModels, servers: _servers, ...rest } = raw;
    const settings = { ...rest, servers: updatedServers, modelOptionName: cfg.modelOptionName };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);

    say('');
    say(`Added the server "${name}": ${url}  Model: ${model}  (${
      type === 'openai' ? 'OpenAI API' : 'Anthropic API'
    })`);
    for (const envVar of ['SPARK_ROUTER_LOCAL_URL', 'SPARK_ROUTER_LOCAL_MODELS']) {
      if (typeof env[envVar] === 'string' && env[envVar].trim() !== '') {
        say(`Note: ${envVar} is set, so its value is used instead of the saved servers.`);
      }
    }
    say('If the router is running, stop it, then the next claude-agents starts it with the '
      + 'new server.');

    return check.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof SetupCancelled) {
      say('');
      say('Setup stopped. Nothing was saved.');
      return 1;
    }
    throw error;
  } finally {
    reader.close();
  }
}
