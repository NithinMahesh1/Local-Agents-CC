import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { runAddServer } from '../src/add-server.js';
import { settingsFile, readSettingsFile } from '../src/config.js';

describe('add-server.js', () => {
  const tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const setupTmp = () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-add-server-'));
    tmpDirs.push(tmpDir);
    return { tmpDir, env: { HOME: tmpDir, USERPROFILE: tmpDir } };
  };

  test('1. Migrate a legacy file and rename', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({
      localUrl: 'http://127.0.0.1:8',
      localModels: ['m1'],
      modelOptionName: 'Local Agents',
    }) + '\n');
    const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'k1\n');

    const input = new PassThrough();
    input.end('spark\ndesktop\nhttp://127.0.0.1:1234\n2\nk2\n1\n');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async (url, options) => {
      if (url.endsWith('/health')) {
        assert.strictEqual(url.includes('/health'), false, 'should not call /health for openai');
        throw new Error('should not call /health');
      }
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'm2' }] }),
        };
      }
      throw new Error('unexpected url');
    };

    const result = await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    assert.strictEqual(result, 0);
    const settings = readSettingsFile(sFile);
    const normalizedServers = settings.servers.map((s) => ({
      ...s,
      keyFile: path.normalize(s.keyFile),
    }));
    assert.deepStrictEqual(normalizedServers, [
      {
        name: 'spark',
        url: 'http://127.0.0.1:8',
        models: ['m1'],
        type: 'anthropic',
        keyFile: path.normalize(keyFile),
      },
      {
        name: 'desktop',
        url: 'http://127.0.0.1:1234',
        models: ['m2'],
        type: 'openai',
        keyFile: path.normalize(
          path.join(tmpDir, '.config', 'local-model', 'api-key-desktop'),
        ),
      },
    ]);
    assert.strictEqual(settings.modelOptionName, 'Local Agents');
    assert.strictEqual(
      fs.readFileSync(
        path.normalize(path.join(tmpDir, '.config', 'local-model', 'api-key-desktop')),
        'utf8',
      ),
      'k2\n',
    );
    assert.strictEqual(settings.localUrl, undefined);
    assert.strictEqual(settings.localModels, undefined);
  });

  test('2. Add to an existing servers list (no migration, anthropic)', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({
      servers: [{ name: 'spark', url: 'http://127.0.0.1:8', models: ['m1'], type: 'anthropic' }],
      modelOptionName: 'X',
    }) + '\n');
    const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'k1\n');

    const input = new PassThrough();
    input.end('desktop\nhttp://127.0.0.1:1234\n1\nk2\nm2\n');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async (url) => {
      if (url.endsWith('/health')) {
        return { ok: true, status: 200 };
      }
      if (url.endsWith('/v1/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm2' }] }) };
      }
      throw new Error('unexpected url');
    };

    const result = await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    assert.strictEqual(result, 0);
    const settings = readSettingsFile(sFile);
    assert.strictEqual(settings.servers.length, 2);
    assert.deepStrictEqual(settings.servers[1], {
      name: 'desktop',
      url: 'http://127.0.0.1:1234',
      models: ['m2'],
      type: 'anthropic',
      keyFile: path.join(tmpDir, '.config', 'local-model', 'api-key-desktop'),
    });
  });

  test('3. Reject a duplicate server name, then accept', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({
      servers: [{ name: 'spark', url: 'http://127.0.0.1:8', models: ['m1'], type: 'anthropic' }],
      modelOptionName: 'X',
    }) + '\n');
    const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'k1\n');

    const input = new PassThrough();
    input.end('spark\ndesktop\nhttp://127.0.0.1:1234\n1\nk2\nm2\n');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async (url) => {
      if (url.endsWith('/health')) {
        return { ok: true, status: 200 };
      }
      if (url.endsWith('/v1/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm2' }] }) };
      }
      throw new Error('unexpected url');
    };

    await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    assert.ok(output.text.includes('already exists'));
    const settings = readSettingsFile(sFile);
    assert.ok(settings.servers.some((s) => s.name === 'desktop'));
  });

  test('4. Reject a duplicate model name, then accept', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({
      servers: [{ name: 'spark', url: 'http://127.0.0.1:8', models: ['m1'], type: 'anthropic' }],
      modelOptionName: 'X',
    }) + '\n');
    const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'k1\n');

    const input = new PassThrough();
    input.end('desktop\nhttp://127.0.0.1:1234\n1\nk2\nm1\nm2\n');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async (url) => {
      if (url.endsWith('/health')) {
        return { ok: true, status: 200 };
      }
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }),
        };
      }
      throw new Error('unexpected url');
    };

    await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    const settings = readSettingsFile(sFile);
    assert.deepStrictEqual(settings.servers[1].models, ['m2']);
  });

  test('5. No existing setup', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    // Empty temp dir, no settings file written yet.

    const input = new PassThrough();
    input.end('x\n');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async () => ({ ok: true, status: 200 });

    const result = await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    assert.strictEqual(result, 1);
    assert.ok(output.text.includes('Run claude-agents --setup first'));
    assert.strictEqual(fs.existsSync(sFile), false);
  });

  test('6. Check fails, not saved', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({
      servers: [{ name: 'spark', url: 'http://127.0.0.1:8', models: ['m1'], type: 'anthropic' }],
      modelOptionName: 'X',
    }) + '\n');
    const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'k1\n');

    const input = new PassThrough();
    input.end('desktop\nhttp://127.0.0.1:1234\n1\nk2\nm2\nn\n');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async (url) => {
      if (url.endsWith('/v1/models')) {
        return { ok: false, status: 401 };
      }
      throw new Error('unexpected url');
    };

    const result = await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    assert.strictEqual(result, 1);
    const settings = readSettingsFile(sFile);
    assert.strictEqual(settings.servers.length, 1);
  });

  test('7. Input ends early (cancel)', async () => {
    const { tmpDir, env } = setupTmp();
    const sFile = settingsFile(env, 'linux');
    fs.mkdirSync(path.dirname(sFile), { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({
      servers: [{ name: 'spark', url: 'http://127.0.0.1:8', models: ['m1'], type: 'anthropic' }],
      modelOptionName: 'X',
    }) + '\n');
    const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, 'k1\n');

    const input = new PassThrough();
    input.end('');

    const output = { text: '', write(t) { this.text += t; return true; } };

    const fetchFn = async () => ({ ok: true, status: 200 });

    const result = await runAddServer({
      env,
      platform: 'linux',
      input,
      output,
      fetchFn,
      timeoutMs: 1000,
    });

    assert.strictEqual(result, 1);
    assert.ok(output.text.includes('Setup stopped. Nothing was saved.'));
  });
});
