import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readConfig,
  isLocalModel,
  readKeyFile,
  packageVersion,
  ANTHROPIC_URL,
  HEALTH_PATH
} from '../src/config.js';

test('1. readConfig linux default', () => {
  const env = { HOME: '/home/u' };
  const platform = 'linux';
  const result = readConfig(env, platform);
  assert.deepStrictEqual(result, {
    port: 8799,
    localModels: ['local-model'],
    localUrl: 'http://your-box.local:8000',
    keyFile: '/home/u/.config/local-model/api-key',
    logDir: '/home/u/.local/state/spark-router',
    routerUrl: 'http://127.0.0.1:8799'
  });
});

test('2. linux with XDG_STATE_HOME', () => {
  const env = { HOME: '/home/u', XDG_STATE_HOME: '/x/state' };
  const platform = 'linux';
  const result = readConfig(env, platform);
  assert.strictEqual(result.logDir, '/x/state/spark-router');
});

test('3. darwin logDir', () => {
  const env = { HOME: '/Users/u' };
  const platform = 'darwin';
  const result = readConfig(env, platform);
  assert.strictEqual(result.logDir, '/Users/u/Library/Logs/spark-router');
});

test('4. win32 logDir and keyFile', () => {
  const env = {
    USERPROFILE: 'C:\\Users\\u',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
  };
  const platform = 'win32';
  const result = readConfig(env, platform);
  assert.strictEqual(result.keyFile, 'C:\\Users\\u\\.config\\local-model\\api-key');
  assert.strictEqual(result.logDir, 'C:\\Users\\u\\AppData\\Local\\spark-router');

  const envNoLocal = { USERPROFILE: 'C:\\Users\\u' };
  const resultNoLocal = readConfig(envNoLocal, platform);
  assert.strictEqual(resultNoLocal.logDir, 'C:\\Users\\u\\AppData\\Local\\spark-router');
});

test('5. SPARK_ROUTER_LOG_DIR and SPARK_ROUTER_KEY_FILE trimmed', () => {
  const env = {
    SPARK_ROUTER_LOG_DIR: ' /logs ',
    SPARK_ROUTER_KEY_FILE: ' /keys/k '
  };
  const result = readConfig(env, 'linux');
  assert.strictEqual(result.logDir, '/logs');
  assert.strictEqual(result.keyFile, '/keys/k');
});

test('6. SPARK_ROUTER_PORT parsing', () => {
  assert.strictEqual(readConfig({ SPARK_ROUTER_PORT: '9000' }, 'linux').port, 9000);
  assert.strictEqual(readConfig({ SPARK_ROUTER_PORT: ' 9000 ' }, 'linux').port, 9000);
  assert.strictEqual(readConfig({ SPARK_ROUTER_PORT: '' }, 'linux').port, 8799);
  assert.strictEqual(readConfig({}, 'linux').port, 8799);
});

test('7. SPARK_ROUTER_PORT error handling', () => {
  const invalidPorts = ['0', '65536', '80x', '-1', '1.5'];
  for (const port of invalidPorts) {
    assert.throws(() => {
      readConfig({ SPARK_ROUTER_PORT: port }, 'linux');
    }, {
      message: new RegExp(`^SPARK_ROUTER_PORT must be a whole number from 1 to 65535`)
    });
  }
});

test('8. SPARK_ROUTER_LOCAL_MODELS parsing', () => {
  const env = { SPARK_ROUTER_LOCAL_MODELS: ' A, b ,a,, ' };
  const result = readConfig(env, 'linux');
  // Note: 'a' is a duplicate of 'A' (case-insensitive) so it should be filtered out if isLocalModel is used.
  // Wait, isLocalModel is used in the filter.
  // 'A' -> localModels includes 'A'
  // 'b' -> localModels includes 'b'
  // 'a' -> isLocalModel(['A', 'b'], 'a') is true.
  // The filter: all.findIndex((other) => isLocalModel([other], name)) === index
  // For 'a': all.findIndex((other) => isLocalModel([other], 'a'))
  //   other='A': isLocalModel(['A'], 'a') is true. findIndex is 0.
  //   index is 1. 0 !== 1. So 'a' is filtered out.
  // Result should be ['A', 'b'].
  assert.deepStrictEqual(result.localModels, ['A', 'b']);

  assert.throws(() => {
    readConfig({ SPARK_ROUTER_LOCAL_MODELS: ' , ' }, 'linux');
  }, {
    message: new RegExp(`^SPARK_ROUTER_LOCAL_MODELS must name at least one model`)
  });
});

test('9. SPARK_ROUTER_LOCAL_URL parsing', () => {
  assert.strictEqual(readConfig({ SPARK_ROUTER_LOCAL_URL: 'https://box.example:8443' }, 'linux').localUrl, 'https://box.example:8443');

  assert.throws(() => {
    readConfig({ SPARK_ROUTER_LOCAL_URL: 'ftp://x' }, 'linux');
  }, {
    message: new RegExp(`^SPARK_ROUTER_LOCAL_URL must be an http:// or https:// address`)
  });

  assert.throws(() => {
    readConfig({ SPARK_ROUTER_LOCAL_URL: 'not a url' }, 'linux');
  }, {
    message: new RegExp(`^SPARK_ROUTER_LOCAL_URL must be an http:// or https:// address`)
  });
});

test('10. isLocalModel', () => {
  assert.strictEqual(isLocalModel(['Local-Model'], 'local-model'), true);
  assert.strictEqual(isLocalModel(['a'], 'b'), false);
});

test('11. readKeyFile', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-'));
  try {
    const keyFile = path.join(tmpDir, 'key.txt');
    fs.writeFileSync(keyFile, '  key-123\n');
    assert.strictEqual(readKeyFile(keyFile), 'key-123');

    assert.throws(() => {
      readKeyFile(path.join(tmpDir, 'missing.txt'));
    }, {
      message: `key file not found: ${path.join(tmpDir, 'missing.txt')}`
    });

    const emptyFile = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(emptyFile, ' \n ');
    assert.throws(() => {
      readKeyFile(emptyFile);
    }, {
      message: `key file is empty: ${emptyFile}`
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('12. packageVersion', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.strictEqual(packageVersion(), pkg.version);
});

test('13. Constants', () => {
  assert.strictEqual(ANTHROPIC_URL, 'https://api.anthropic.com');
  assert.strictEqual(HEALTH_PATH, '/__spark-router/health');
});
