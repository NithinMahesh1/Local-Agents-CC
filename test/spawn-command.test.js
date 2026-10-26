// Tests for spawn-command.js: finding a program on PATH, and starting it with the quoting that
// Windows needs. Temp files live only under a folder made with fs.mkdtempSync (prefix lacc-).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildCmdCommandLine,
  escapeCmdMetaChars,
  quoteWindowsArgument,
  resolveCommand,
  spawnCommand,
} from '../src/spawn-command.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lacc-'));

after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const onWindows = process.platform === 'win32';
const WINDOWS_ONLY = { skip: onWindows ? false : 'Windows only' };
const POSIX_ONLY = { skip: onWindows ? 'macOS and Linux only' : false };

// Every character that cmd.exe or a program might treat in a special way.
const TRICKY_ARGS = [
  'plain', 'with space', 'quote"inside', 'amp&er', 'pipe|x', 'caret^x', 'percent%PATH%x',
  'bang!x', 'paren(x)', 'lt<gt>', 'back\\slash\\', 'semi;colon', 'comma,x', 'star*?', '',
];

function makeDir(name) {
  return fs.mkdtempSync(path.join(root, `${name}-`));
}

// Waits for the child to end. Returns its exit code and what it wrote to stdout.
function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

// Writes a batch file that prints its arguments as JSON, in a new folder with this name. Runs
// it through spawnCommand and checks that every tricky argument arrives unchanged.
async function expectTrickyArgumentsArrive(folderName, fileName) {
  const dir = path.join(makeDir('batch'), folderName);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'echo-args.js'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
  );
  const batchFile = path.join(dir, fileName);
  fs.writeFileSync(batchFile, `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);

  const child = spawnCommand(batchFile, TRICKY_ARGS, {
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 20000,
  });
  const { code, stdout } = await collect(child);

  assert.equal(code, 0, `the batch file ended with exit code ${code}`);
  assert.deepEqual(JSON.parse(stdout), TRICKY_ARGS);
}

describe('quoteWindowsArgument', () => {
  it('quotes an argument the way Windows programs read it', () => {
    assert.equal(quoteWindowsArgument('abc'), '"abc"');
    assert.equal(quoteWindowsArgument('a b'), '"a b"');
    assert.equal(quoteWindowsArgument(''), '""');
    assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
    assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
    assert.equal(quoteWindowsArgument('a\\'), '"a\\\\"');
    assert.equal(quoteWindowsArgument('a\\b'), '"a\\b"');
  });

  it('is fast on very long input', () => {
    const startedAt = Date.now();
    quoteWindowsArgument('\\'.repeat(100000) + 'x');
    escapeCmdMetaChars('&'.repeat(100000));
    assert.ok(Date.now() - startedAt < 1000, 'too slow');
  });
});

describe('escapeCmdMetaChars', () => {
  it('puts ^ before each special character and changes nothing else', () => {
    assert.equal(escapeCmdMetaChars('a&b'), 'a^&b');
    assert.equal(escapeCmdMetaChars('safe-text_1.2/3:x'), 'safe-text_1.2/3:x');
    for (const char of '()[]%!^"`<>&|;, *?') {
      assert.equal(escapeCmdMetaChars(char), `^${char}`, `character: ${char}`);
    }
  });
});

describe('buildCmdCommandLine', () => {
  it('quotes each argument, then escapes it twice, inside one pair of quotes', () => {
    assert.equal(
      buildCmdCommandLine('C:\\tools\\claude.cmd', ['a b', 'x&y']),
      '"C:\\tools\\claude.cmd ^^^"a^^^ b^^^" ^^^"x^^^&y^^^""',
    );
    assert.equal(
      buildCmdCommandLine('C:\\x\\c.cmd', ['q"x']),
      '"C:\\x\\c.cmd ^^^"q\\^^^"x^^^""',
    );
  });

  it('escapes the command path once', () => {
    assert.equal(buildCmdCommandLine('C:\\my tools\\c.cmd', []), '"C:\\my^ tools\\c.cmd"');
  });
});

describe('resolveCommand', () => {
  it('finds an executable file, and not one without execute permission', POSIX_ONLY, () => {
    const dir = makeDir('posix');
    const file = path.join(dir, 'claude');
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
    const env = { PATH: dir };

    assert.equal(resolveCommand('claude', { env, platform: 'linux' }), file);

    fs.chmodSync(file, 0o644);
    assert.equal(resolveCommand('claude', { env, platform: 'linux' }), null);
  });

  it('does not match a folder on macOS and Linux', POSIX_ONLY, () => {
    const dir = makeDir('posix');
    fs.mkdirSync(path.join(dir, 'claude'), { mode: 0o755 });
    assert.equal(resolveCommand('claude', { env: { PATH: dir }, platform: 'linux' }), null);
  });

  it('uses the first match on PATH', POSIX_ONLY, () => {
    const [first, second] = [makeDir('posix'), makeDir('posix')];
    for (const dir of [first, second]) {
      fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(dir, 'tool'), 0o755);
    }
    const env = { PATH: `${second}:${first}` };
    assert.equal(resolveCommand('tool', { env, platform: 'linux' }), path.join(second, 'tool'));
  });

  it('follows the PATHEXT order, with any case in the variable names', WINDOWS_ONLY, () => {
    const dir = makeDir('win');
    for (const file of ['tool', 'tool.cmd', 'tool.exe']) {
      fs.writeFileSync(path.join(dir, file), 'x');
    }
    const exeFirst = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    const cmdFirst = { Path: dir, PathExt: '.cmd;.exe' };

    const exeFile = path.join(dir, 'tool.exe');
    const cmdFile = path.join(dir, 'tool.cmd');
    assert.equal(resolveCommand('tool', { env: exeFirst, platform: 'win32' }), exeFile);
    assert.equal(resolveCommand('tool', { env: cmdFirst, platform: 'win32' }), cmdFile);
  });

  it('accepts a PATH entry in quotes on Windows', WINDOWS_ONLY, () => {
    const dir = makeDir('win');
    fs.writeFileSync(path.join(dir, 'tool.exe'), 'x');
    const env = { PATH: `"${dir}"`, PATHEXT: '.EXE' };
    assert.equal(
      resolveCommand('tool', { env, platform: 'win32' }),
      path.join(dir, 'tool.exe'),
    );
  });

  it('does not match a folder named claude.cmd on Windows', WINDOWS_ONLY, () => {
    const dir = makeDir('win');
    fs.mkdirSync(path.join(dir, 'claude.cmd'));
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(resolveCommand('claude', { env, platform: 'win32' }), null);
  });

  it('skips PATHEXT types that spawnCommand cannot start, such as .js', WINDOWS_ONLY, () => {
    const dir = makeDir('win');
    fs.writeFileSync(path.join(dir, 'claude.js'), 'x');
    const env = { PATH: dir, PATHEXT: '.JS;.CMD' };
    assert.equal(resolveCommand('claude', { env, platform: 'win32' }), null);

    // With a .cmd file next to it, the .cmd file is the one that is found.
    fs.writeFileSync(path.join(dir, 'claude.cmd'), 'x');
    assert.equal(
      resolveCommand('claude', { env, platform: 'win32' }),
      path.join(dir, 'claude.cmd'),
    );
  });

  it('uses the default PATHEXT list when the variable is missing', WINDOWS_ONLY, () => {
    const dir = makeDir('win');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), 'x');
    assert.equal(
      resolveCommand('claude', { env: { PATH: dir }, platform: 'win32' }),
      path.join(dir, 'claude.cmd'),
    );
  });

  it('never searches the current folder, for a PATH entry like . or an empty one', () => {
    const dir = makeDir('cwd');
    const name = onWindows ? 'tool.exe' : 'tool';
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.chmodSync(path.join(dir, name), 0o755);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.copyFileSync(path.join(dir, name), path.join(dir, 'sub', name));
    const env = { PATH: ['.', 'sub', ''].join(path.delimiter), PATHEXT: '.EXE' };

    const folderBefore = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(resolveCommand('tool', { env }), null);
    } finally {
      process.chdir(folderBefore);
    }
  });

  it('returns null when PATH is empty or missing', () => {
    assert.equal(resolveCommand('tool', { env: { PATH: '' } }), null);
    assert.equal(resolveCommand('tool', { env: {} }), null);
  });

  it('checks a name with a folder part as it is, and never matches a folder', () => {
    const dir = makeDir('named');
    assert.equal(resolveCommand(process.execPath), process.execPath);
    const withSlashes = process.execPath.split(path.sep).join('/');
    assert.equal(resolveCommand(withSlashes), withSlashes);
    assert.equal(resolveCommand(dir), null);
    assert.equal(resolveCommand(path.join(dir, 'missing')), null);
  });
});

describe('spawnCommand', () => {
  it('starts a program with the arguments unchanged, line breaks too', async () => {
    const wanted = ['a b', 'q"x', 'back\\slash\\', '', 'two\nlines'];
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const child = spawnCommand(process.execPath, ['-e', script, ...wanted], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const { stdout } = await collect(child);
    assert.deepEqual(JSON.parse(stdout), wanted);
  });

  it('refuses a line break in an argument for a .cmd or .bat file', () => {
    const cases = [
      ['C:\\x\\claude.cmd', 'claude.cmd'],
      ['C:\\x\\run.BAT', 'run.BAT'],
    ];
    for (const [file, shortName] of cases) {
      for (const arg of ['a\nb', 'a\rb']) {
        assert.throws(() => spawnCommand(file, ['ok', arg], {}, 'win32'), {
          message: `cmd.exe cannot pass a line break in an argument to ${shortName}. `
            + 'Remove the line break, or install the native Claude Code (claude.exe).',
        });
      }
    }
  });

  it('passes tricky arguments to a .cmd file (no space in the path)', WINDOWS_ONLY, () => {
    return expectTrickyArgumentsArrive('nospace', 'fake.cmd');
  });

  it('passes tricky arguments to a .cmd file (space in the path)', WINDOWS_ONLY, () => {
    return expectTrickyArgumentsArrive('dir with space', 'fake.cmd');
  });

  it('passes tricky arguments to a .bat file', WINDOWS_ONLY, () => {
    return expectTrickyArgumentsArrive('batch', 'fake.bat');
  });
});
