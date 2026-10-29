import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import {
  runSetup,
  normalizeServerUrl,
  checkServer,
  createLineReader,
  SetupCancelled,
} from '../src/setup.js';
import { settingsFile, readSettingsFile } from '../src/config.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

describe('setup.js', () => {
  const tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const setupTmp = () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-setup-'));
    tmpDirs.push(tmpDir);
    return { tmpDir, env: { HOME: tmpDir, USERPROFILE: tmpDir } };
  };

  describe('normalizeServerUrl', () => {
    test('1. my-ai-server.local:8000 -> http://my-ai-server.local:8000', () => {
      assert.strictEqual(
        normalizeServerUrl('my-ai-server.local:8000'),
        'http://my-ai-server.local:8000'
      );
    });

    test('2. https://x.example:8443/ -> https://x.example:8443', () => {
      assert.strictEqual(normalizeServerUrl('https://x.example:8443/'), 'https://x.example:8443');
    });

    test('3.   http://127.0.0.1:8000   -> http://127.0.0.1:8000', () => {
      assert.strictEqual(normalizeServerUrl('  http://127.0.0.1:8000  '), 'http://127.0.0.1:8000');
    });

    test('4. edge cases', () => {
      assert.strictEqual(normalizeServerUrl(''), null);
      assert.strictEqual(normalizeServerUrl('ftp://x.example'), null);
      assert.strictEqual(normalizeServerUrl('http://'), null);
    });
  });

  describe('checkServer', () => {
    test('5. /health ok and /v1/models ok with data', async () => {
      const say = (t) => { say.text += t; return true; };
      say.text = '';
      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          assert.strictEqual(options.headers.authorization, 'Bearer k');
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'a' }, { id: 'b' }] }),
          };
        }
        throw new Error('unexpected url');
      };

      const result = await checkServer({
        localUrl: 'http://127.0.0.1:9',
        key: 'k',
        fetchFn,
        timeoutMs: 1000,
        say,
      });

      assert.deepStrictEqual(result, { ok: true, models: ['a', 'b'] });
      assert.ok(say.text.includes('The AI server answers.'));
      assert.ok(say.text.includes('The AI server accepts the API key.'));
    });

    test('6. /v1/models answers 401', async () => {
      const say = (t) => { say.text += t; return true; };
      say.text = '';
      const fetchFn = async (url) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          return { ok: false, status: 401 };
        }
        throw new Error('unexpected url');
      };

      const result = await checkServer({
        localUrl: 'http://127.0.0.1:9',
        key: 'k',
        fetchFn,
        timeoutMs: 1000,
        say,
      });

      assert.deepStrictEqual(result, { ok: false, models: [] });
      assert.ok(say.text.includes('refused the API key'));
    });

    test('7. /health answers 503', async () => {
      const say = (t) => { say.text += t; return true; };
      say.text = '';
      let calls = 0;
      const fetchFn = async (url) => {
        calls++;
        if (url.endsWith('/health')) {
          return { ok: false, status: 503 };
        }
        throw new Error('unexpected url');
      };

      const result = await checkServer({
        localUrl: 'http://127.0.0.1:9',
        key: 'k',
        fetchFn,
        timeoutMs: 1000,
        say,
      });

      assert.deepStrictEqual(result, { ok: false, models: [] });
      assert.strictEqual(calls, 1);
    });

    test('8. fetch throws ECONNREFUSED', async () => {
      const say = (t) => { say.text += t; return true; };
      say.text = '';
      const fetchFn = async () => {
        const err = new Error('connection refused');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      };

      const result = await checkServer({
        localUrl: 'http://127.0.0.1:9',
        key: 'k',
        fetchFn,
        timeoutMs: 1000,
        say,
      });

      assert.deepStrictEqual(result, { ok: false, models: [] });
      assert.ok(say.text.includes('ECONNREFUSED'));
    });

    test('9. /v1/models body without data', async () => {
      const say = (t) => { say.text += t; return true; };
      say.text = '';
      const fetchFn = async (url) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        throw new Error('unexpected url');
      };

      const result = await checkServer({
        localUrl: 'http://127.0.0.1:9',
        key: 'k',
        fetchFn,
        timeoutMs: 1000,
        say,
      });

      assert.deepStrictEqual(result, { ok: true, models: [] });
    });
  });

  describe('runSetup', () => {
    test('10. successful run', async () => {
      const { tmpDir, env } = setupTmp();
      const input = new PassThrough();
      input.end('http://127.0.0.1:9\ngood-key\n2\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          if (options.headers.authorization !== 'Bearer good-key') {
            return { ok: false, status: 401 };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
          };
        }
        throw new Error('unexpected url');
      };

      const result = await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.strictEqual(result, 0);
      const sFile = settingsFile(env, 'linux');
      const settings = readSettingsFile(sFile);
      assert.strictEqual(settings.localUrl, 'http://127.0.0.1:9');
      assert.deepStrictEqual(settings.localModels, ['model-b']);

      const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
      assert.strictEqual(fs.readFileSync(keyFile, 'utf8'), 'good-key\n');
      assert.ok(!output.text.includes('good-key'));
    });

    test('11. key file permissions (non-Windows)', {
      skip: process.platform === 'win32',
    }, async () => {
      const { tmpDir, env } = setupTmp();
      const input = new PassThrough();
      input.end('http://127.0.0.1:9\ngood-key\n2\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          if (options.headers.authorization !== 'Bearer good-key') {
            return { ok: false, status: 401 };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
          };
        }
        throw new Error('unexpected url');
      };

      await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
      assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
    });

    test('12. second run preserves settings', async () => {
      const { tmpDir, env } = setupTmp();
      const sFile = settingsFile(env, 'linux');
      fs.mkdirSync(path.dirname(sFile), { recursive: true });
      fs.writeFileSync(
        sFile,
        JSON.stringify({ localUrl: 'http://127.0.0.1:8', localModels: ['m1'] }) + '\n'
      );

      const input = new PassThrough();
      input.end('\n\n\n'); // Keep address, keep key, default model

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
          const key = fs.readFileSync(keyFile, 'utf8').trim();
          if (options.headers.authorization !== `Bearer ${key}`) {
            return { ok: false, status: 401 };
          }
          return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) };
        }
        throw new Error('unexpected url');
      };

      const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, 'old-key\n');

      const result = await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.strictEqual(result, 0);
      const settings = readSettingsFile(sFile);
      assert.strictEqual(settings.localUrl, 'http://127.0.0.1:8');
      assert.deepStrictEqual(settings.localModels, ['m1']);
      assert.ok(output.text.includes('Keep it?'));
    });

    test('13. preserve extra settings', async () => {
      const { tmpDir, env } = setupTmp();
      const sFile = settingsFile(env, 'linux');
      fs.mkdirSync(path.dirname(sFile), { recursive: true });
      fs.writeFileSync(
        sFile,
        JSON.stringify({ localUrl: 'http://old', localModels: ['m'], other: 1 }) + '\n'
      );

      const input = new PassThrough();
      input.end('http://127.0.0.1:9\n\n1\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) };
        }
        throw new Error('unexpected url');
      };

      const keyFile = path.join(tmpDir, '.config', 'local-model', 'api-key');
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, 'good-key\n');

      await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      const settings = readSettingsFile(sFile);
      assert.strictEqual(settings.other, 1);
    });

    test('13b. a broken settings file or variable does not stop the setup', async () => {
      const { tmpDir, env } = setupTmp();
      const sFile = settingsFile(env, 'linux');
      fs.mkdirSync(path.dirname(sFile), { recursive: true });
      fs.writeFileSync(sFile, 'not json');
      const input = new PassThrough();
      input.end('http://127.0.0.1:9\nk\n\n');
      const output = { write(t) { this.text += t; return true; } };
      output.text = '';
      const fetchFn = async (url) => (url.endsWith('/health')
        ? { ok: true, status: 200 }
        : { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) });

      const code = await runSetup({
        env: { ...env, SPARK_ROUTER_PORT: 'not-a-port' },
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.strictEqual(code, 0);
      assert.match(output.text, /saved settings cannot be used/);
      assert.match(output.text, /SPARK_ROUTER_PORT must be a whole number/);
      assert.match(output.text, /Setup cannot change environment variables/);
      assert.match(output.text, /this terminal shows what you type/);
      assert.deepStrictEqual(readSettingsFile(sFile), {
        localUrl: 'http://127.0.0.1:9',
        localModels: ['m'],
      });
      assert.ok(fs.existsSync(path.join(tmpDir, '.config', 'local-model', 'api-key')));
    });

    test('14. wrong key (no save)', async () => {
      const { tmpDir, env } = setupTmp();
      const input = new PassThrough();
      input.end('http://127.0.0.1:9\nbad-key\nmy-model\n\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          return { ok: false, status: 401 };
        }
        throw new Error('unexpected url');
      };

      const result = await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.strictEqual(result, 1);
      assert.ok(output.text.includes('Nothing was saved'));
      assert.strictEqual(fs.existsSync(settingsFile(env, 'linux')), false);
      assert.strictEqual(
        fs.existsSync(path.join(tmpDir, '.config', 'local-model', 'api-key')),
        false
      );
    });

    test('15. wrong key, saved anyway', async () => {
      const { tmpDir, env } = setupTmp();
      const input = new PassThrough();
      input.end('http://127.0.0.1:9\nbad-key\nmy-model\ny\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          return { ok: false, status: 401 };
        }
        throw new Error('unexpected url');
      };

      const result = await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.strictEqual(result, 1);
      const settings = readSettingsFile(settingsFile(env, 'linux'));
      assert.deepStrictEqual(settings.localModels, ['my-model']);
      assert.ok(output.text.includes('The checks above failed'));
    });

    test('16. input ends early', async () => {
      const { tmpDir, env } = setupTmp();
      const input = new PassThrough();
      input.end('');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async () => ({ ok: true, status: 200 });

      const result = await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.strictEqual(result, 1);
      assert.ok(output.text.includes('Setup stopped'));
      assert.strictEqual(fs.existsSync(settingsFile(env, 'linux')), false);
    });

    test('17. 3 bad addresses', async () => {
      const { tmpDir, env } = setupTmp();
      const input = new PassThrough();
      input.end('ftp://a\nftp://b\nftp://c\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async () => ({ ok: true, status: 200 });

      await assert.rejects(
        runSetup({
          env,
          platform: 'linux',
          input,
          output,
          fetchFn,
          timeoutMs: 1000,
        }),
        {
          message: /no usable AI server address/,
        },
      );
    });

    test('18. SPARK_ROUTER_LOCAL_URL in env', async () => {
      const { tmpDir, env } = setupTmp();
      env.SPARK_ROUTER_LOCAL_URL = 'http://127.0.0.1:7';
      const input = new PassThrough();
      input.end('http://127.0.0.1:9\ngood-key\n2\n');

      const output = { write(t) { this.text += t; return true; } };
      output.text = '';

      const fetchFn = async (url, options) => {
        if (url.endsWith('/health')) {
          return { ok: true, status: 200 };
        }
        if (url.endsWith('/v1/models')) {
          return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) };
        }
        throw new Error('unexpected url');
      };

      await runSetup({
        env,
        platform: 'linux',
        input,
        output,
        fetchFn,
        timeoutMs: 1000,
      });

      assert.ok(output.text.includes('SPARK_ROUTER_LOCAL_URL is set'));
    });
  });

  describe('createLineReader', () => {
    test('19. question with hidden and backspace', async () => {
      const input = new PassThrough();
      const output = { write(t) { this.text += t; return true; } };
      output.text = '';
      input.isTTY = true;
      input.setRawMode = (val) => { output.setRawModeCalledWith = val; };

      const reader = createLineReader(input, output);
      const promise = reader.question('Key: ', { hidden: true });
      input.write('ab\x7fc\r');
      input.end();

      const answer = await promise;
      assert.strictEqual(answer, 'ac');
      assert.strictEqual(output.text, 'Key: \n');
      assert.strictEqual(output.setRawModeCalledWith, false);
    });

    test('20. question normal', async () => {
      const input = new PassThrough();
      const output = { write(t) { this.text += t; return true; } };
      output.text = '';
      input.isTTY = true;
      input.setRawMode = () => {};

      const reader = createLineReader(input, output);
      const promise = reader.question('Name: ');
      input.write('xy\r');
      input.end();

      const answer = await promise;
      assert.strictEqual(answer, 'xy');
      assert.strictEqual(output.text, 'Name: xy\n');
    });

    test('21. Ctrl+C', async () => {
      const input = new PassThrough();
      const output = { write(t) { this.text += t; return true; } };
      output.text = '';
      input.isTTY = true;
      input.setRawMode = () => {};

      const reader = createLineReader(input, output);
      const promise = reader.question('Q: ');
      input.write(String.fromCharCode(3));

      await assert.rejects(promise, (error) => error instanceof SetupCancelled);
      reader.close();
    });

    test('22. two questions in a terminal: the line feed after Enter is skipped', async () => {
      const input = new PassThrough();
      const output = { write(t) { this.text += t; return true; } };
      output.text = '';
      input.isTTY = true;
      input.setRawMode = () => {};

      const reader = createLineReader(input, output);
      input.write(`a${CR}${LF}b${CR}`);
      assert.strictEqual(await reader.question('Q1: '), 'a');
      assert.strictEqual(await reader.question('Q2: '), 'b');
      reader.close();
    });

    test('23. arrow key', async () => {
      const input = new PassThrough();
      const output = { write(t) { this.text += t; return true; } };
      output.text = '';
      input.isTTY = true;
      input.setRawMode = () => {};

      const reader = createLineReader(input, output);
      const promise = reader.question('Q: ');
      input.write('a\x1b[Db\r');
      input.end();

      const answer = await promise;
      assert.strictEqual(answer, 'ab');
    });

    const fakeTerminal = () => {
      const input = new PassThrough();
      input.isTTY = true;
      input.setRawMode = () => {};
      return input;
    };
    const sink = () => ({ text: '', write(t) { this.text += t; return true; } });

    test('24. arrow key in application mode (ESC O A)', async () => {
      const input = fakeTerminal();
      const reader = createLineReader(input, sink());
      const promise = reader.question('Q: ');
      input.write('a\x1bOAb\r');
      assert.strictEqual(await promise, 'ab');
      reader.close();
    });

    test('25. arrow key split over two reads', async () => {
      const input = fakeTerminal();
      const reader = createLineReader(input, sink());
      const promise = reader.question('Q: ');
      input.write('a\x1b[');
      await new Promise((resolve) => setImmediate(resolve));
      input.write('Db\r');
      assert.strictEqual(await promise, 'ab');
      reader.close();
    });

    test('26. Ctrl+C right after a lone ESC still stops the setup', async () => {
      const input = fakeTerminal();
      const reader = createLineReader(input, sink());
      const promise = reader.question('Q: ');
      input.write('\x1b\x03');
      await assert.rejects(promise, (error) => error instanceof SetupCancelled);
      reader.close();
    });

    test('27. hidesTyping is true only for a terminal', () => {
      const terminalReader = createLineReader(fakeTerminal(), sink());
      const pipeReader = createLineReader(new PassThrough(), sink());
      assert.strictEqual(terminalReader.hidesTyping, true);
      assert.strictEqual(pipeReader.hidesTyping, false);
      terminalReader.close();
      pipeReader.close();
    });
  });
});
