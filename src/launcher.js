// local-agents-cc: starts Claude Code pointed at spark-router, and starts the router first when
// it does not answer. Only ANTHROPIC_BASE_URL (and the model settings below) change, so your
// claude.ai login, plan limits and billing stay the same.

/**
 * Asks the router for its health. Never throws.
 * @param {string} routerUrl - for example http://127.0.0.1:8799
 * @param {number} [timeoutMs]
 * @returns {Promise<{ router: string, local_model_server: string } | null>} null when the
 *   router does not answer, answers with an error, or does not answer with the health JSON
 */
export async function getRouterHealth(routerUrl, timeoutMs = 4000) {
  throw new Error('not implemented');
}

/**
 * Starts `spark-router` in the background with no window. It keeps running after this
 * process ends. Its output goes to router.log and router-errors.log in logDir; the logs of
 * the run before are kept as router.previous.log and router-errors.previous.log.
 * @param {{ logDir: string, env?: NodeJS.ProcessEnv }} options
 * @returns {import('node:child_process').ChildProcess}
 */
export function startRouterProcess(options) {
  throw new Error('not implemented');
}

/**
 * Returns the router's health, and starts the router first when it does not answer.
 * @param {{ routerUrl: string, logDir: string, note: (message: string) => void,
 *   env?: NodeJS.ProcessEnv, startTimeoutMs?: number,
 *   start?: (options: { logDir: string, env?: NodeJS.ProcessEnv }) =>
 *     import('node:child_process').ChildProcess }} options
 * @returns {Promise<{ router: string, local_model_server: string }>}
 * @throws {Error} when the router does not answer in time
 */
export async function ensureRouter(options) {
  throw new Error('not implemented');
}

/**
 * Runs local-agents-cc and returns the exit code (claude's exit code after a session).
 * @param {string[]} argv - the arguments after the command name
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform,
 *   stdout?: { write: (text: string) => unknown },
 *   stderr?: { write: (text: string) => unknown } }} [options]
 * @returns {Promise<number>}
 */
export async function main(argv, options = {}) {
  throw new Error('not implemented');
}
