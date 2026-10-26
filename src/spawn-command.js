// Finds and starts a program (claude) the same way on Windows, macOS and Linux, with no shell
// in between. Windows .cmd and .bat files can start only through cmd.exe, so their arguments
// get the quoting that cmd.exe needs.

/**
 * Finds a command on PATH, the same way a shell does. Never searches the current folder.
 * @param {string} name - for example 'claude'
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {string | null} the full path of the first match, or null
 */
export function resolveCommand(name, options = {}) {
  throw new Error('not implemented');
}

/**
 * Quotes one argument the way Windows programs read their command line.
 * @param {string} arg
 * @returns {string}
 */
export function quoteWindowsArgument(arg) {
  throw new Error('not implemented');
}

/**
 * Puts ^ before each character that cmd.exe treats as special.
 * @param {string} text
 * @returns {string}
 */
export function escapeCmdMetaChars(text) {
  throw new Error('not implemented');
}

/**
 * The text after `cmd.exe /d /s /c` that runs a .cmd or .bat file with these arguments.
 * @param {string} commandPath
 * @param {string[]} args
 * @returns {string}
 */
export function buildCmdCommandLine(commandPath, args) {
  throw new Error('not implemented');
}

/**
 * Starts a program with no shell in between (Windows .cmd and .bat files: through cmd.exe).
 * @param {string} commandPath - a full path, for example from resolveCommand
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @param {NodeJS.Platform} [platform]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnCommand(commandPath, args, options = {}, platform = process.platform) {
  throw new Error('not implemented');
}
