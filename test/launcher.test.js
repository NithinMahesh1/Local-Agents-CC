// Tests for the launcher: the router health check, starting the router, and whole claude
// sessions that run a fake claude. Network use is on 127.0.0.1 only.
//
// A real spark-router can run on port 8799, and a real Claude Code uses ~/.claude, on the
// machine that runs these tests. So every test that starts something gets its own port, its
// own environment object (never process.env itself) and its own temp folders.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { HEALTH_PATH } from '../src/config.js';
import { ensureRouter, getRouterHealth, main, startRouterProcess } from '../src/launcher.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-'));
const startedRouters = [];

after(async () => {
  await Promise.all(startedRouters.map(stopProcess));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const SETTINGS_BEFORE = '{\n  "model": "sonnet",\n  "theme": "dark"\n}\n';

// The fake claude. It records what it got. Then it saves the local model as the default model
// (like "/model" and Enter in Claude Code does) and ends with exit code 7. When
// FAKE_CLAUDE_STOP_FILE is set, it stays alive instead, until that file exists.
const FAKE_CLAUDE_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
fs.writeFileSync(env.FAKE_CLAUDE_OUT, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  env: {
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_CUSTOM_MODEL_OPTION: env.ANTHROPIC_CUSTOM_MODEL_OPTION,
    ANTHROPIC_DEFAULT_OPUS_MODEL: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  },
}));
if (env.FAKE_CLAUDE_STOP_FILE) {
  setInterval(() => {
    if (fs.existsSync(env.FAKE_CLAUDE_STOP_FILE)) {
      process.exit(0);
    }
  }, 100);
} else {
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  const text = fs.readFileSync(settings, 'utf8');
  fs.writeFileSync(settings, text.replace('"sonnet"', '"local-model"'));
  process.exit(7);
}
`;

// ---- helpers -------------------------------------------------------------------------------

function makeDir(name) {
  return fs.mkdtempSync(path.join(root, `${name}-`));
}

function urlOf(portOrServer) {
  const port = typeof portOrServer === 'number' ? portOrServer : portOrServer.address().port;
  return `http://127.0.0.1:${port}`;
}

function listen(handler, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// Answers like spark-router's health route.
function healthHandler(localModelServer) {
  return (request, response) => {
    if (request.url !== HEALTH_PATH) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ router: 'ok', local_model_server: localModelServer }));
  };
}

// Ports that nothing listens on right now. All of them are open at the same time while they
// are picked, so they are different from each other.
async function freePorts(count) {
  const servers = await Promise.all(Array.from({ length: count }, () => listen(() => {})));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map(closeServer));
  return ports;
}

// An environment object for one test. Every setting points at the test's own port and folders.
// HOME and USERPROFILE point at the test folder too, so nothing can reach the real home folder.
// nodeOnPath: false gives a PATH with an empty folder only (so no real claude can be found).
function makeEnv(dir, port, { nodeOnPath = true, ...extra } = {}) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const env = {
    SPARK_ROUTER_PORT: String(port),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    SPARK_ROUTER_LOG_DIR: path.join(dir, 'logs'),
    SPARK_ROUTER_KEY_FILE: path.join(dir, 'api-key'),
    PATH: nodeOnPath ? [binDir, path.dirname(process.execPath)].join(path.delimiter) : binDir,
    HOME: dir,
    USERPROFILE: dir,
    ...extra,
  };
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT']) {
      if (process.env[name] !== undefined) {
        env[name] = process.env[name];
      }
    }
  }
  return env;
}

// An output stream that keeps what is written to it.
function makeSink() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Waits for the router to answer; returns its health, or null when it does not answer in time.
async function waitForHealth(routerUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await getRouterHealth(routerUrl, 1000);
    if (health !== null || Date.now() >= deadline) {
      return health;
    }
    await sleep(100);
  }
}

async function waitUntil(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(50);
  }
  return condition();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Ends a fake claude that stays alive (on Windows it can outlive its cmd.exe wrapper) and
// waits until it is gone, so no program keeps the temp folder or the test output open.
async function stopFakeClaude(outFile, stopFile) {
  fs.writeFileSync(stopFile, '');
  if (!fs.existsSync(outFile)) {
    return;
  }
  const { pid } = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (!(await waitUntil(() => !isAlive(pid), 5000))) {
    process.kill(pid);
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = waitForExit(child, 3000);
  child.kill();
  if (!(await exited)) {
    child.kill('SIGKILL');
    await waitForExit(child, 3000);
  }
}

// Puts a fake claude in binDir: an executable file on POSIX, claude.cmd on Windows.
function installFakeClaude(binDir) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'fake-claude.cjs'), FAKE_CLAUDE_SOURCE);
    fs.writeFileSync(
      path.join(binDir, 'claude.cmd'),
      `@"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`,
    );
  } else {
    const file = path.join(binDir, 'claude');
    fs.writeFileSync(file, `#!/usr/bin/env node\n${FAKE_CLAUDE_SOURCE}`);
    fs.chmodSync(file, 0o755);
  }
}

// The folders, the fake claude and the settings.json for one session test.
function setUpSession(port, settings = SETTINGS_BEFORE) {
  const dir = makeDir('session');
  const outFile = path.join(dir, 'claude-out.json');
  const env = makeEnv(dir, port, {
    FAKE_CLAUDE_OUT: outFile,
    ANTHROPIC_API_KEY: 'should-be-removed',
  });
  installFakeClaude(path.join(dir, 'bin'));
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settingsFile = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settingsFile, settings);
  return { env, outFile, settingsFile };
}

// An environment where claude is found on PATH but cannot be started. Windows: the claude.cmd
// file needs cmd.exe, and ComSpec points to a program that does not exist. macOS and Linux:
// a claude script that names an interpreter that does not exist.
function makeUnstartableEnv(env, dir) {
  if (process.platform === 'win32') {
    return { ...env, ComSpec: path.join(dir, 'no-such-folder', 'cmd.exe') };
  }
  const binDir = path.join(dir, 'broken-bin');
  fs.mkdirSync(binDir);
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, '#!/nonexistent/interpreter\n');
  fs.chmodSync(file, 0o755);
  return { ...env, PATH: binDir };
}

function signalListenerCounts() {
  return ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
}

// ---- getRouterHealth -------------------------------------------------------------------------

describe('getRouterHealth', { timeout: 30000 }, () => {
  it('returns the health data when the router answers ok', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      assert.deepEqual(await getRouterHealth(urlOf(server)), {
        router: 'ok',
        local_model_server: 'ok',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('returns null when the router answers with an error status', async () => {
    const server = await listen((request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ router: 'ok', local_model_server: 'ok' }));
    });
    try {
      assert.equal(await getRouterHealth(urlOf(server)), null);
    } finally {
      await closeServer(server);
    }
  });

  it('returns null when nothing listens on the port', async () => {
    const [port] = await freePorts(1);
    assert.equal(await getRouterHealth(urlOf(port)), null);
  });

  it('returns null when the answer is not the health JSON', async () => {
    let body = '';
    const server = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
    const answers = [
      'not json',
      '{"router":"starting","local_model_server":"ok"}',
      '{"router":"ok"}',
      'null',
    ];
    try {
      for (const answer of answers) {
        body = answer;
        assert.equal(await getRouterHealth(urlOf(server)), null, `answer: ${answer}`);
      }
    } finally {
      await closeServer(server);
    }
  });

  it('returns null soon after the timeout when the server never answers', async () => {
    const server = await listen(() => {});
    try {
      const startedAt = Date.now();
      assert.equal(await getRouterHealth(urlOf(server), 300), null);
      assert.ok(Date.now() - startedAt < 3000, 'the timeout did not stop the request');
    } finally {
      await closeServer(server);
    }
  });

  it('returns null soon after the timeout when the answer never ends', async () => {
    const server = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"router":"ok",');
    });
    try {
      const startedAt = Date.now();
      assert.equal(await getRouterHealth(urlOf(server), 300), null);
      assert.ok(Date.now() - startedAt < 3000, 'the timeout did not stop the request');
    } finally {
      await closeServer(server);
    }
  });
});

// ---- ensureRouter ----------------------------------------------------------------------------

describe('ensureRouter', { timeout: 30000 }, () => {
  it('returns the health of a running router and does not start one', async () => {
    const server = await listen(healthHandler('ok'));
    const env = makeEnv(makeDir('ensure'), server.address().port);
    const notes = [];
    try {
      const health = await ensureRouter({
        routerUrl: urlOf(server),
        logDir: env.SPARK_ROUTER_LOG_DIR,
        note: (message) => notes.push(message),
        env,
        start: () => assert.fail('start must not be called'),
      });
      assert.deepEqual(health, { router: 'ok', local_model_server: 'ok' });
      assert.deepEqual(notes, []);
    } finally {
      await closeServer(server);
    }
  });

  it('starts a router when none answers and returns its health', async () => {
    const [port] = await freePorts(1);
    const env = makeEnv(makeDir('ensure'), port);
    const logDir = env.SPARK_ROUTER_LOG_DIR;
    const notes = [];
    const startCalls = [];
    let server = null;
    // A fake start: the "router" is a health server that begins to listen on the test port.
    const start = (options) => {
      startCalls.push(options);
      server = http.createServer(healthHandler('ok')).listen(port, '127.0.0.1');
      return new EventEmitter();
    };
    try {
      const health = await ensureRouter({
        routerUrl: urlOf(port),
        logDir,
        note: (message) => notes.push(message),
        env,
        start,
      });
      assert.deepEqual(health, { router: 'ok', local_model_server: 'ok' });
      assert.deepEqual(notes, [
        `starting spark-router (log: ${path.join(logDir, 'router.log')}) ...`,
      ]);
      assert.equal(startCalls.length, 1);
      assert.equal(startCalls[0].logDir, logDir);
      assert.equal(startCalls[0].env, env);
    } finally {
      if (server !== null) {
        await closeServer(server);
      }
    }
  });

  it('throws and names router-errors.log when the router exits at once', async () => {
    const [port] = await freePorts(1);
    const env = makeEnv(makeDir('ensure'), port);
    const logDir = env.SPARK_ROUTER_LOG_DIR;
    let startedAt = 0;
    const start = () => {
      startedAt = Date.now();
      return spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    };
    await assert.rejects(
      ensureRouter({
        routerUrl: urlOf(port),
        logDir,
        note: () => {},
        env,
        startTimeoutMs: 2000,
        start,
      }),
      (error) => {
        assert.match(error.message, /^spark-router did not start/);
        assert.ok(error.message.includes(path.join(logDir, 'router-errors.log')));
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2000, 'the exit of the router did not end the wait');
  });

  it('throws when a router that stays alive does not answer in time', async () => {
    const [port] = await freePorts(1);
    const env = makeEnv(makeDir('ensure'), port);
    await assert.rejects(
      ensureRouter({
        routerUrl: urlOf(port),
        logDir: env.SPARK_ROUTER_LOG_DIR,
        note: () => {},
        env,
        startTimeoutMs: 500,
        start: () => new EventEmitter(),
      }),
      /router-errors\.log/,
    );
  });
});

// ---- startRouterProcess (starts the real router) ---------------------------------------------

describe('startRouterProcess', { timeout: 60000 }, () => {
  it('starts the real router, keeps the old logs and answers health', async () => {
    const [port, closedPort] = await freePorts(2);
    const env = makeEnv(makeDir('router'), port, {
      SPARK_ROUTER_LOCAL_URL: `http://127.0.0.1:${closedPort}`,
    });
    fs.writeFileSync(env.SPARK_ROUTER_KEY_FILE, 'test-key');
    const logDir = env.SPARK_ROUTER_LOG_DIR;
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'router.log'), 'old');
    fs.writeFileSync(path.join(logDir, 'router.previous.log'), 'older');
    fs.writeFileSync(path.join(logDir, 'router-errors.log'), 'old errors');

    const child = startRouterProcess({ logDir, env });
    startedRouters.push(child);

    const health = await waitForHealth(urlOf(port), 10000);
    const errorsLog = readText(path.join(logDir, 'router-errors.log'));
    assert.notEqual(health, null, `the router did not answer. router-errors.log: ${errorsLog}`);
    assert.equal(health.router, 'ok');
    assert.equal(health.local_model_server, 'unreachable');
    assert.equal(readText(path.join(logDir, 'router.previous.log')), 'old');
    assert.equal(readText(path.join(logDir, 'router-errors.previous.log')), 'old errors');
    assert.ok(fs.existsSync(path.join(logDir, 'router.log')));
    assert.ok(fs.existsSync(path.join(logDir, 'router-errors.log')));
  });

  it('writes startup errors to router-errors.log even when the old log cannot move', async () => {
    const [port] = await freePorts(1);
    // There is no key file, so the router stops at once.
    const env = makeEnv(makeDir('router'), port);
    const logDir = env.SPARK_ROUTER_LOG_DIR;
    // A folder with the name of the "previous" log: the old log cannot move there.
    fs.mkdirSync(path.join(logDir, 'router.previous.log', 'blocker'), { recursive: true });
    fs.writeFileSync(path.join(logDir, 'router.log'), 'old');

    const child = startRouterProcess({ logDir, env });
    startedRouters.push(child);
    assert.equal(await waitForExit(child, 10000), true, 'the router should stop at once');

    assert.match(readText(path.join(logDir, 'router-errors.log')), /key file not found/);
    assert.equal(readText(path.join(logDir, 'router.log')), 'old');
  });
});

// ---- main ------------------------------------------------------------------------------------

describe('main', { timeout: 60000 }, () => {
  it('prints the help text and starts no router', async () => {
    const [port] = await freePorts(1);
    const env = makeEnv(makeDir('help'), port);
    const stdout = makeSink();
    const stderr = makeSink();
    assert.equal(await main(['--help'], { env, stdout, stderr }), 0);
    assert.match(stdout.text, /local-agents-cc - Claude Code with/);
    assert.ok(stdout.text.includes(urlOf(port)), 'the help text shows the router URL');
    assert.equal(stderr.text, '');
    // No router was started: the log folder does not exist and nothing answers on the port.
    assert.equal(fs.existsSync(env.SPARK_ROUTER_LOG_DIR), false);
    assert.equal(await getRouterHealth(urlOf(port), 500), null);
  });

  it('stops with a message when a setting has a wrong value', async () => {
    const env = makeEnv(makeDir('badport'), 'abc');
    const stderr = makeSink();
    assert.equal(await main([], { env, stdout: makeSink(), stderr }), 1);
    assert.match(stderr.text, /SPARK_ROUTER_PORT/);
    assert.equal(fs.existsSync(env.SPARK_ROUTER_LOG_DIR), false);
  });

  it('runs claude with the router settings and puts the saved model back', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const { env, outFile, settingsFile } = setUpSession(server.address().port);
      const stderr = makeSink();
      const listenersBefore = signalListenerCounts();

      const code = await main(['-p', 'hello world'], { env, stdout: makeSink(), stderr });

      assert.equal(code, 7);
      const seen = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      assert.deepEqual(seen.args, ['-p', 'hello world']);
      assert.equal(seen.env.ANTHROPIC_BASE_URL, urlOf(server));
      assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(seen.env.ANTHROPIC_CUSTOM_MODEL_OPTION, 'local-model');
      assert.equal(seen.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
      // The fake claude saved "local-model" as the default. The launcher put "sonnet" back.
      assert.equal(readText(settingsFile), SETTINGS_BEFORE);
      assert.match(stderr.text, /\/model had saved local-model/);
      assert.deepEqual(signalListenerCounts(), listenersBefore);
    } finally {
      await closeServer(server);
    }
  });

  it('removes the saved model when it already was the local model', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const { env, outFile, settingsFile } = setUpSession(
        server.address().port,
        SETTINGS_BEFORE.replace('"sonnet"', '"local-model"'),
      );
      assert.equal(await main([], { env, stdout: makeSink(), stderr: makeSink() }), 7);
      assert.ok(fs.existsSync(outFile), 'the fake claude should have run');
      assert.equal(readText(settingsFile), '{\n  "theme": "dark"\n}\n');
    } finally {
      await closeServer(server);
    }
  });

  it('refuses --all-local when the local model server is down', async () => {
    const server = await listen(healthHandler('unreachable'));
    try {
      const { env, outFile, settingsFile } = setUpSession(server.address().port);
      const stderr = makeSink();
      assert.equal(await main(['--all-local'], { env, stdout: makeSink(), stderr }), 1);
      assert.match(stderr.text, /--all-local needs it/);
      assert.equal(fs.existsSync(outFile), false, 'the fake claude must not run');
      assert.equal(readText(settingsFile), SETTINGS_BEFORE);
    } finally {
      await closeServer(server);
    }
  });

  it('warns and still runs claude when the local model server is down', async () => {
    const server = await listen(healthHandler('unreachable'));
    try {
      const { env, outFile } = setUpSession(server.address().port);
      const stderr = makeSink();
      assert.equal(await main(['-p', 'hi'], { env, stdout: makeSink(), stderr }), 7);
      assert.match(stderr.text, /warning - the local model server is not answering/);
      assert.ok(fs.existsSync(outFile), 'the fake claude should have run');
    } finally {
      await closeServer(server);
    }
  });

  it('passes SIGTERM on to claude and returns 128 plus the signal number', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const { env, outFile } = setUpSession(server.address().port);
      const stopFile = path.join(path.dirname(outFile), 'stop');
      const termHandlersBefore = process.listeners('SIGTERM');
      const countsBefore = signalListenerCounts();

      const running = main([], {
        env: { ...env, FAKE_CLAUDE_STOP_FILE: stopFile },
        stdout: makeSink(),
        stderr: makeSink(),
      });
      try {
        assert.equal(await waitUntil(() => fs.existsSync(outFile), 10000), true);
        // While claude runs, this process has its own handlers (SIGINT does nothing).
        assert.deepEqual(signalListenerCounts(), countsBefore.map((count) => count + 1));
        // Call only the launcher's handler: a real signal would reach the test runner too.
        const handler = process.listeners('SIGTERM').find((fn) => !termHandlersBefore.includes(fn));
        handler('SIGTERM');
        const result = await Promise.race([running, sleep(10000, 'timed out', { ref: false })]);
        assert.equal(result, 128 + os.constants.signals.SIGTERM);
      } finally {
        await stopFakeClaude(outFile, stopFile);
      }
      assert.deepEqual(signalListenerCounts(), countsBefore);
    } finally {
      await closeServer(server);
    }
  });

  it('stops with a message when claude cannot start', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const session = setUpSession(server.address().port);
      const env = makeUnstartableEnv(session.env, path.dirname(session.env.CLAUDE_CONFIG_DIR));
      const stderr = makeSink();
      const listenersBefore = signalListenerCounts();

      assert.equal(await main([], { env, stdout: makeSink(), stderr }), 1);

      assert.match(stderr.text, /could not start claude/);
      assert.deepEqual(signalListenerCounts(), listenersBefore);
    } finally {
      await closeServer(server);
    }
  });

  it('stops with a message when starting claude throws an error at once', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const { env, outFile } = setUpSession(server.address().port);
      const stderr = makeSink();
      const listenersBefore = signalListenerCounts();

      // An argument with a null byte: Node refuses to start any program with it.
      assert.equal(await main(['-p', 'a\0b'], { env, stdout: makeSink(), stderr }), 1);

      assert.match(stderr.text, /could not start claude/);
      assert.equal(fs.existsSync(outFile), false, 'the fake claude must not run');
      assert.deepEqual(signalListenerCounts(), listenersBefore);
    } finally {
      await closeServer(server);
    }
  });

  // A .cmd file is started through cmd.exe, which cannot pass a line break inside an argument.
  it('stops with a message for a line break when claude is a .cmd file', {
    skip: process.platform === 'win32' ? false : 'Windows only',
  }, async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const { env, outFile } = setUpSession(server.address().port);
      const stderr = makeSink();

      const code = await main(['-p', 'line one\nline two'], { env, stdout: makeSink(), stderr });

      assert.equal(code, 1);
      assert.match(stderr.text, /could not start claude: cmd\.exe cannot pass a line break/);
      assert.equal(fs.existsSync(outFile), false, 'the fake claude must not run');
    } finally {
      await closeServer(server);
    }
  });

  it('stops with a message when claude is not on PATH', async () => {
    const server = await listen(healthHandler('ok'));
    try {
      const env = makeEnv(makeDir('noclaude'), server.address().port, { nodeOnPath: false });
      const stderr = makeSink();
      assert.equal(await main([], { env, stdout: makeSink(), stderr }), 1);
      assert.match(stderr.text, /claude was not found on PATH/);
    } finally {
      await closeServer(server);
    }
  });
});
