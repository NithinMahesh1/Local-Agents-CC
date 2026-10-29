// Checks the JSON files that ship in the npm package: the plugin manifest, the plugin's
// hooks.json, the "files" list of package.json and the guarded example settings.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

it('plugin.json names the plugin local-agents-cc and has a description', () => {
  const json = readJson('plugin/.claude-plugin/plugin.json');
  assert.strictEqual(json.name, 'local-agents-cc');
  assert.strictEqual(typeof json.description, 'string');
  assert.ok(json.description.length > 0);
});

it('hooks.json has one Stop hook that runs node with the hook script', () => {
  const json = readJson('plugin/hooks/hooks.json');
  assert.deepEqual(Object.keys(json.hooks), ['Stop']);
  assert.strictEqual(json.hooks.Stop.length, 1);
  const expectedHooks = [{
    type: 'command',
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/hooks/stop-nudge.js']
  }];
  assert.deepEqual(json.hooks.Stop[0].hooks, expectedHooks);
});

it('the hook script that hooks.json names exists', () => {
  assert.ok(fs.existsSync(path.join(root, 'plugin', 'hooks', 'stop-nudge.js')));
});

it('package.json ships the plugin/ and examples/ folders', () => {
  const json = readJson('package.json');
  assert.ok(json.files.includes('plugin/'));
  assert.ok(json.files.includes('examples/'));
});

it('the guarded example turns on the sandbox and allows only listed hosts', () => {
  const json = readJson('examples/settings/all-local-guarded.json');
  assert.strictEqual(json.sandbox.enabled, true);
  assert.strictEqual(json.sandbox.failIfUnavailable, true);
  assert.strictEqual(json.sandbox.allowUnsandboxedCommands, false);
  assert.strictEqual(json.sandbox.network.strictAllowlist, true);
  assert.ok(Array.isArray(json.sandbox.network.allowedDomains));
  assert.ok(json.sandbox.network.allowedDomains.length > 0);
  for (const domain of json.sandbox.network.allowedDomains) {
    assert.strictEqual(typeof domain, 'string');
    assert.ok(domain.length > 0);
  }
});

it('the guarded example denies Read of .env files and ~/.ssh, and WebFetch', () => {
  const json = readJson('examples/settings/all-local-guarded.json');
  assert.ok(json.permissions.deny.includes('Read(./.env)'));
  assert.ok(json.permissions.deny.includes('Read(./**/.env)'));
  assert.ok(json.permissions.deny.includes('Read(~/.ssh/**)'));
  // The sandbox limits shell commands only, so only this rule stops WebFetch.
  assert.ok(json.permissions.deny.includes('WebFetch'));
});

it('the guarded example hides credential files under ~/, ~/.ssh included', () => {
  const json = readJson('examples/settings/all-local-guarded.json');
  for (const entry of json.sandbox.credentials.files) {
    assert.strictEqual(typeof entry.path, 'string');
    assert.ok(entry.path.startsWith('~/'));
    assert.strictEqual(entry.mode, 'deny');
  }
  assert.ok(json.sandbox.credentials.files.some((entry) => entry.path === '~/.ssh'));
});

it('the guarded example hides token variables, GITHUB_TOKEN included', () => {
  const json = readJson('examples/settings/all-local-guarded.json');
  for (const entry of json.sandbox.credentials.envVars) {
    assert.strictEqual(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0);
    assert.strictEqual(entry.mode, 'deny');
  }
  assert.ok(json.sandbox.credentials.envVars.some((entry) => entry.name === 'GITHUB_TOKEN'));
});
