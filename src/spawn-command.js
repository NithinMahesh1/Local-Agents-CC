// Finds and starts a program (claude) the same way on Windows, macOS and Linux, with no shell
// in between. Windows .cmd and .bat files can start only through cmd.exe, so their arguments
// get the quoting that cmd.exe needs. cmd.exe cannot pass a line break inside an argument, so
// spawnCommand stops with an error for such an argument instead of cutting it short.

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

// The Windows file types that spawnCommand can start: programs, and batch files (cmd.exe).
const STARTABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

// The list that Windows uses when PATHEXT is not set.
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Finds a command on PATH, the same way a shell does. Never searches the current folder.
 *
 * Windows: tries name + extension for each PATHEXT entry that spawnCommand can start (.com,
 * .exe, .bat, .cmd), in PATHEXT order; the extension in the result is in lower case.
 * macOS and Linux: the file needs the execute permission. A folder never matches. A name with
 * a folder part (for example C:\tools\claude.cmd or ./claude) is checked as it is, without PATH.
 * @param {string} name - for example 'claude'
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {string | null} the full path of the first match, or null
 */
export function resolveCommand(name, { env = process.env, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (hasFolderPart(name, platform)) {
    return isExecutable(name, platform) ? name : null;
  }

  const pathValue = envValue(env, 'PATH');
  if (!pathValue) {
    return null;
  }
  // Only full folder paths count. A PATH entry that is empty or relative would mean "the
  // current folder", and that folder is never searched.
  const entries = pathValue.split(paths.delimiter);
  const folders = (platform === 'win32' ? entries.map(removeQuotes) : entries)
    .filter((folder) => folder !== '' && paths.isAbsolute(folder));

  // Windows: name + extension. macOS and Linux: the name as it is.
  const suffixes = platform === 'win32' ? startableExtensions(envValue(env, 'PATHEXT')) : [''];
  for (const folder of folders) {
    for (const suffix of suffixes) {
      const candidate = paths.join(folder, name + suffix);
      if (isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Quotes one argument the way Windows programs read their command line.
 * @param {string} arg
 * @returns {string}
 */
export function quoteWindowsArgument(arg) {
  let out = '"';
  let slashes = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === '\\') {
      slashes += 1;
      continue;
    }
    if (c === '"') {
      // Backslashes before a quote are doubled, and the quote itself is escaped.
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + c;
    }
    slashes = 0;
  }
  // Backslashes before the closing quote are doubled, so they do not escape it.
  out += '\\'.repeat(slashes * 2) + '"';
  return out;
}

/**
 * Puts ^ before each character that cmd.exe treats as special.
 * @param {string} text
 * @returns {string}
 */
export function escapeCmdMetaChars(text) {
  return text.replace(/[()[\]%!^"`<>&|;, *?]/g, '^$&');
}

/**
 * The text after `cmd.exe /d /s /c` that runs a .cmd or .bat file with these arguments.
 * Each argument is quoted for the program, then its special characters get a ^ twice: once
 * for cmd.exe reading this line, and once for the .cmd file reading its arguments (%*) again.
 * The whole line is in quotes, and cmd.exe removes the outer pair (that is what /s does).
 * @param {string} commandPath
 * @param {string[]} args
 * @returns {string}
 */
export function buildCmdCommandLine(commandPath, args) {
  const parts = [
    escapeCmdMetaChars(commandPath),
    ...args.map((arg) => escapeCmdMetaChars(escapeCmdMetaChars(quoteWindowsArgument(arg)))),
  ];
  return '"' + parts.join(' ') + '"';
}

/**
 * Starts a program with no shell in between (Windows .cmd and .bat files: through cmd.exe).
 * @param {string} commandPath - a full path, for example from resolveCommand
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @param {NodeJS.Platform} [platform]
 * @returns {import('node:child_process').ChildProcess}
 * @throws {Error} when a Windows .cmd or .bat file gets an argument with a line break
 */
export function spawnCommand(commandPath, args, options = {}, platform = process.platform) {
  if (platform !== 'win32' || !/\.(bat|cmd)$/i.test(commandPath)) {
    return spawn(commandPath, args, options);
  }
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new Error(
      'cmd.exe cannot pass a line break in an argument to ' + path.win32.basename(commandPath)
      + '. Remove the line break, or install the native Claude Code (claude.exe).',
    );
  }
  const comspec = envValue(options.env ?? process.env, 'COMSPEC') || 'cmd.exe';
  return spawn(comspec, ['/d', '/s', '/c', buildCmdCommandLine(commandPath, args)], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

// The value of an environment variable. The name is matched without regard to upper or lower
// case, because Windows variable names are not case sensitive (Path, PATH, path).
function envValue(env, name) {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

// True when the name has a folder part, so it names a file and is not searched on PATH.
function hasFolderPart(name, platform) {
  return platform === 'win32' ? /[\\/]/.test(name) : name.includes('/');
}

// A Windows PATH entry may be in quotes, for example "C:\Program Files\tools".
function removeQuotes(folder) {
  return folder.replace(/^"|"$/g, '');
}

// The PATHEXT entries that spawnCommand can start, in PATHEXT order, in lower case (the usual
// spelling of real files; Windows does not care). Other types, for example .js or .vbs, need
// another program to open them.
function startableExtensions(pathExt) {
  return (pathExt || DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.toLowerCase())
    .filter((extension) => STARTABLE_EXTENSIONS.includes(extension));
}

// True when the path is a file (not a folder) and, on macOS and Linux, has the execute
// permission. Windows has no execute permission: a file with the right extension is enough.
function isExecutable(file, platform) {
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    if (platform !== 'win32') {
      accessSync(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
