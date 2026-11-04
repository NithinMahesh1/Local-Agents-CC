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
  missedEventsFile,
  ANTHROPIC_URL,
  HEALTH_PATH,
  settingsFile,
  readSettingsFile,
  loadConfig,
  SettingsFileError
} from '../src/config.js';

test('1. readConfig linux default', () => {
  const env = { HOME: '/home/u' };
  const platform = 'linux';
  const result = readConfig(env, platform);
  assert.deepStrictEqual(result, {
    port: 8799,
    localModels: ['local-model'],
    localUrl: 'http://your-ai-server.local:8000',
    keyFile: '/home/u/.config/local-model/api-key',
    modelOptionName: 'Local Agents',
    servers: [{
      name: 'local',
      url: 'http://your-ai-server.local:8000',
      models: ['local-model'],
      type: 'anthropic',
      keyFile: '/home/u/.config/local-model/api-key'
    }],
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
  // 'a' repeats 'A' (names are compared without regard to case), so it is left out.
  assert.deepStrictEqual(result.localModels, ['A', 'b']);

  assert.throws(() => {
    readConfig({ SPARK_ROUTER_LOCAL_MODELS: ' , ' }, 'linux');
  }, {
    message: new RegExp(`^SPARK_ROUTER_LOCAL_MODELS must name at least one model`)
  });
});

test('9. SPARK_ROUTER_LOCAL_URL parsing', () => {
  assert.strictEqual(
    readConfig({ SPARK_ROUTER_LOCAL_URL: 'https://ai-server.example:8443' }, 'linux').localUrl,
    'https://ai-server.example:8443',
  );

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

test('missedEventsFile: SPARK_MISSED_EVENTS_FILE is the whole path', () => {
  const env = { SPARK_MISSED_EVENTS_FILE: '/x/events.jsonl' };
  assert.strictEqual(missedEventsFile(env, 'linux'), '/x/events.jsonl');
});

test('missedEventsFile: a blank SPARK_MISSED_EVENTS_FILE is ignored', () => {
  const env = {
    SPARK_MISSED_EVENTS_FILE: '  ',
    SPARK_ROUTER_LOG_DIR: '/logs',
    HOME: '/home/u'
  };
  assert.strictEqual(missedEventsFile(env, 'linux'), '/logs/missed-tool-events.jsonl');
});

test('missedEventsFile: SPARK_ROUTER_LOG_DIR on Windows', () => {
  const env = { SPARK_ROUTER_LOG_DIR: 'D:\\logs', USERPROFILE: 'C:\\Users\\u' };
  assert.strictEqual(missedEventsFile(env, 'win32'), 'D:\\logs\\missed-tool-events.jsonl');
});

test('missedEventsFile: default folder on Windows', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\u'
  };
  const res = 'C:\\Users\\u\\AppData\\Local\\spark-router\\missed-tool-events.jsonl';
  assert.strictEqual(missedEventsFile(env, 'win32'), res);
});

test('missedEventsFile: default folder on macOS', () => {
  assert.strictEqual(missedEventsFile({ HOME: '/home/u' }, 'darwin'),
    '/home/u/Library/Logs/spark-router/missed-tool-events.jsonl');
});

test('missedEventsFile: Linux with XDG_STATE_HOME', () => {
  const env = { HOME: '/home/u', XDG_STATE_HOME: '/state' };
  assert.strictEqual(missedEventsFile(env, 'linux'),
    '/state/spark-router/missed-tool-events.jsonl');
});

test('missedEventsFile: Linux without XDG_STATE_HOME', () => {
  assert.strictEqual(missedEventsFile({ HOME: '/home/u' }, 'linux'),
    '/home/u/.local/state/spark-router/missed-tool-events.jsonl');
});

test('missedEventsFile: a bad router setting does not matter', () => {
  assert.doesNotThrow(() => {
    missedEventsFile({ HOME: '/home/u', SPARK_ROUTER_PORT: 'abc' }, 'linux');
  });
});

test('24. settingsFile', () => {
  assert.strictEqual(settingsFile({ HOME: '/home/u' }, 'linux'),
    '/home/u/.config/local-model/settings.json');
  assert.strictEqual(settingsFile({ USERPROFILE: 'C:\\Users\\u' }, 'win32'),
    'C:\\Users\\u\\.config\\local-model\\settings.json');
});

test('25. readConfig with settings', () => {
  const settings = { localUrl: 'http://127.0.0.1:5', localModels: ['m1', 'm2'] };
  const result = readConfig({ HOME: '/home/u' }, 'linux', settings);
  assert.strictEqual(result.localUrl, 'http://127.0.0.1:5');
  assert.deepStrictEqual(result.localModels, ['m1', 'm2']);
});

test('26. environment variables win over settings', () => {
  const settings = { localUrl: 'http://127.0.0.1:5', localModels: ['m1', 'm2'] };
  const env = {
    SPARK_ROUTER_LOCAL_URL: 'http://127.0.0.1:6',
    SPARK_ROUTER_LOCAL_MODELS: 'e1'
  };
  const result = readConfig(env, 'linux', settings);
  assert.strictEqual(result.localUrl, 'http://127.0.0.1:6');
  assert.deepStrictEqual(result.localModels, ['e1']);
});

test('27. readConfig with invalid settings.localUrl', () => {
  const settings = { localUrl: 'ftp://x' };
  assert.throws(() => {
    readConfig({}, 'linux', settings);
  }, {
    message: new RegExp(`"localUrl" in the settings file`)
  });
});

test('28. readSettingsFile: non-existent file', () => {
  assert.deepStrictEqual(readSettingsFile('non-existent.json'), {});
});

test('29. readSettingsFile: invalid JSON and schema', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-settings-'));
  try {
    const f1 = path.join(tmpDir, 'not-json.json');
    fs.writeFileSync(f1, 'not json');
    assert.throws(() => readSettingsFile(f1), /not valid JSON/);

    const f2 = path.join(tmpDir, 'array.json');
    fs.writeFileSync(f2, '[1]');
    assert.throws(() => readSettingsFile(f2), /must hold a JSON object/);

    const f3 = path.join(tmpDir, 'bad-url.json');
    fs.writeFileSync(f3, '{"localUrl": 5}');
    assert.throws(() => readSettingsFile(f3), /"localUrl" in the settings file/);

    const f4 = path.join(tmpDir, 'bad-models.json');
    fs.writeFileSync(f4, '{"localModels": "m"}');
    assert.throws(() => readSettingsFile(f4), /"localModels" in the settings file/);

    for (const models of ['[]', '[""]', '["  "]']) {
      const f5 = path.join(tmpDir, 'empty-models.json');
      fs.writeFileSync(f5, `{"localModels": ${models}}`);
      assert.throws(() => readSettingsFile(f5), /must name at least one model/);
    }

    for (const file of [f1, f2, f3, f4]) {
      assert.throws(() => readSettingsFile(file), SettingsFileError);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('30. loadConfig uses settings.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-load-'));
  try {
    const configDir = path.join(tmpDir, '.config', 'local-model');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ localUrl: 'http://127.0.0.1:5' }),
    );

    const result = loadConfig({ HOME: tmpDir, USERPROFILE: tmpDir }, 'linux');
    assert.strictEqual(result.localUrl, 'http://127.0.0.1:5');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('31. a bad value from the settings file is a SettingsFileError; a bad variable is not', () => {
  assert.throws(
    () => readConfig({ HOME: '/home/u' }, 'linux', { localUrl: 'ftp://x' }),
    SettingsFileError,
  );
  assert.throws(
    () => readConfig({ HOME: '/home/u', SPARK_ROUTER_LOCAL_URL: 'ftp://x' }, 'linux', {}),
    (error) => !(error instanceof SettingsFileError)
      && /SPARK_ROUTER_LOCAL_URL/.test(error.message),
  );
});

// ---- servers (more than one local server) ----------------------------------------------------

const ENV = { HOME: '/home/u' };
const KEY = '/home/u/.config/local-model/api-key';

function twoServers() {
  return [
    { name: 'spark', url: 'http://127.0.0.1:1', models: ['spark-coder'] },
    {
      name: 'desktop',
      url: 'http://127.0.0.1:2',
      models: ['desktop-docs', 'Desktop-Fast'],
      type: 'openai',
      keyFile: '/k/desktop'
    }
  ];
}

test('32. servers: shape B parses, with defaults for type and keyFile', () => {
  const result = readConfig(ENV, 'linux', { servers: twoServers() });
  assert.deepStrictEqual(result.servers, [
    { name: 'spark', url: 'http://127.0.0.1:1', models: ['spark-coder'], type: 'anthropic',
      keyFile: KEY },
    { name: 'desktop', url: 'http://127.0.0.1:2', models: ['desktop-docs', 'Desktop-Fast'],
      type: 'openai', keyFile: '/k/desktop' }
  ]);
  assert.strictEqual(result.localUrl, 'http://127.0.0.1:1');
  assert.deepStrictEqual(result.localModels, ['spark-coder']);
  assert.strictEqual(result.keyFile, KEY);
});

test('33. servers: the default keyFile follows SPARK_ROUTER_KEY_FILE', () => {
  const env = { ...ENV, SPARK_ROUTER_KEY_FILE: '/env/key' };
  const result = readConfig(env, 'linux', { servers: twoServers() });
  assert.strictEqual(result.servers[0].keyFile, '/env/key');
  assert.strictEqual(result.servers[1].keyFile, '/k/desktop');
});

test('34. servers win over the legacy keys in the same file', () => {
  const settings = { servers: twoServers(), localUrl: 'http://127.0.0.1:9', localModels: ['x'] };
  const result = readConfig(ENV, 'linux', settings);
  assert.strictEqual(result.servers.length, 2);
  assert.strictEqual(result.localUrl, 'http://127.0.0.1:1');
  assert.deepStrictEqual(result.localModels, ['spark-coder']);
});

test('35. a legacy file gives one server named local', () => {
  const settings = { localUrl: 'http://127.0.0.1:5', localModels: ['m1', 'm2'] };
  const result = readConfig(ENV, 'linux', settings);
  assert.deepStrictEqual(result.servers, [{
    name: 'local', url: 'http://127.0.0.1:5', models: ['m1', 'm2'], type: 'anthropic',
    keyFile: KEY
  }]);
});

test('36. environment variables win over servers', () => {
  const env = { ...ENV, SPARK_ROUTER_LOCAL_URL: 'http://127.0.0.1:6' };
  const result = readConfig(env, 'linux', { servers: twoServers() });
  assert.strictEqual(result.servers.length, 1);
  assert.strictEqual(result.servers[0].name, 'local');
  assert.strictEqual(result.servers[0].url, 'http://127.0.0.1:6');
  assert.deepStrictEqual(result.servers[0].models, ['local-model']);
  const envModels = { ...ENV, SPARK_ROUTER_LOCAL_MODELS: 'e1' };
  const second = readConfig(envModels, 'linux', { servers: twoServers() });
  assert.deepStrictEqual(second.servers.map((entry) => entry.models), [['e1']]);
});

test('37. servers: a repeated model name (any case) is a SettingsFileError', () => {
  const list = twoServers();
  list[1].models = ['SPARK-coder'];
  assert.throws(() => readConfig(ENV, 'linux', { servers: list }), (error) => {
    return error instanceof SettingsFileError && /repeats the model name/.test(error.message);
  });
  const same = twoServers();
  same[0].models = ['a', 'A'];
  assert.throws(() => readConfig(ENV, 'linux', { servers: same }), SettingsFileError);
});

test('38. servers: a repeated server name (any case) is a SettingsFileError', () => {
  const list = twoServers();
  list[1].name = 'SPARK';
  assert.throws(() => readConfig(ENV, 'linux', { servers: list }), /repeats the server name/);
});

test('39. servers: a bad type is a SettingsFileError', () => {
  for (const type of ['gemini', '', 5, null]) {
    const list = twoServers();
    list[0].type = type;
    assert.throws(() => readConfig(ENV, 'linux', { servers: list }), (error) => {
      return error instanceof SettingsFileError && /\.type"/.test(error.message);
    });
  }
});

test('40. servers: a missing or empty name, url, or models is a SettingsFileError', () => {
  const edits = [
    [(item) => delete item.name, /\.name"/],
    [(item) => { item.name = '  '; }, /\.name"/],
    [(item) => { item.name = 3; }, /\.name"/],
    [(item) => delete item.url, /\.url"/],
    [(item) => { item.url = ''; }, /\.url"/],
    [(item) => { item.url = 'ftp://x'; }, /url" .* must be an http/],
    [(item) => delete item.models, /\.models"/],
    [(item) => { item.models = []; }, /\.models"/],
    [(item) => { item.models = ['a', ' ']; }, /\.models"/],
    [(item) => { item.models = 'a'; }, /\.models"/],
    [(item) => { item.keyFile = ' '; }, /\.keyFile"/]
  ];
  for (const [edit, pattern] of edits) {
    const list = twoServers();
    edit(list[0]);
    assert.throws(() => readConfig(ENV, 'linux', { servers: list }), (error) => {
      return error instanceof SettingsFileError && pattern.test(error.message);
    });
  }
});

test('41. servers: not a list, an empty list, or a non-object item', () => {
  for (const servers of [{}, 'x', [], [null], [5], [[]]]) {
    assert.throws(() => readConfig(ENV, 'linux', { servers }), SettingsFileError);
  }
});

test('42. readSettingsFile checks servers, names the file, and keeps unknown keys', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-servers-'));
  try {
    const good = path.join(tmpDir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ servers: twoServers(), future: 1 }));
    assert.strictEqual(readSettingsFile(good).future, 1);

    const bad = path.join(tmpDir, 'bad.json');
    const list = twoServers();
    list[1].models = ['spark-coder'];
    fs.writeFileSync(bad, JSON.stringify({ servers: list }));
    assert.throws(() => readSettingsFile(bad), (error) => {
      return error instanceof SettingsFileError && error.message.includes(bad)
        && error.message.includes('servers[1].models');
    });

    const result = loadConfig({ HOME: tmpDir, USERPROFILE: tmpDir }, 'linux');
    assert.strictEqual(result.servers.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('43. modelOptionName: default, from settings, blank value ignored by readConfig', () => {
  assert.strictEqual(readConfig(ENV, 'linux').modelOptionName, 'Local Agents');
  assert.strictEqual(
    readConfig(ENV, 'linux', { modelOptionName: ' Desk Model ' }).modelOptionName, 'Desk Model',
  );
  assert.strictEqual(readConfig(ENV, 'linux', { modelOptionName: '  ' }).modelOptionName,
    'Local Agents');
  const withServers = { servers: twoServers(), modelOptionName: 'Mine' };
  assert.strictEqual(readConfig(ENV, 'linux', withServers).modelOptionName, 'Mine');
});

test('44. readSettingsFile rejects a modelOptionName that is not a non-empty string', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-label-'));
  try {
    const file = path.join(tmpDir, 'settings.json');
    for (const value of [5, null, true, [], '', '   ']) {
      fs.writeFileSync(file, JSON.stringify({ modelOptionName: value }));
      assert.throws(() => readSettingsFile(file), (error) => {
        return error instanceof SettingsFileError && error.message.includes(file)
          && error.message.includes('"modelOptionName"');
      });
    }
    fs.writeFileSync(file, JSON.stringify({ modelOptionName: 'Fine', other: 1 }));
    assert.strictEqual(readSettingsFile(file).modelOptionName, 'Fine');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
