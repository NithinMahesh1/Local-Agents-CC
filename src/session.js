// The parts of local-agents-cc that only compute values: the help text, the split between
// local-agents-cc's own flags and claude's arguments, and the environment for one session.

/**
 * The text that `local-agents-cc --help` prints.
 * @param {{ routerUrl: string, logDir: string, localModel: string }} options
 * @returns {string}
 */
export function helpText(options) {
  throw new Error('not implemented');
}

/**
 * Splits local-agents-cc's own flags from the arguments that go to claude.
 * @param {string[]} argv - the command-line arguments after the command name
 * @returns {{ allLocal: boolean, showHelp: boolean, claudeArgs: string[] }}
 */
export function parseArgs(argv) {
  throw new Error('not implemented');
}

/**
 * The environment and arguments for one claude session. Never changes its inputs.
 * @param {{ baseEnv: Record<string, string | undefined>, routerUrl: string,
 *   localModel: string, allLocal: boolean, claudeArgs: string[] }} options
 * @returns {{ env: Record<string, string>, args: string[], notes: string[] }}
 */
export function buildSession(options) {
  throw new Error('not implemented');
}
