// Guard for Claude Code's saved default model.
// In a local-agents-cc session, "/model -> Spark Agents -> Enter" saves the local model as the
// default for ALL sessions. Plain `claude` cannot reach the local model, so when the session
// ends, local-agents-cc puts the old default back.

/**
 * Path of Claude Code's user settings file: $CLAUDE_CONFIG_DIR/settings.json when that
 * variable is set and not blank, else <home>/.claude/settings.json.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function claudeSettingsPath(env = process.env) {
  throw new Error('not implemented');
}

/**
 * The top-level "model" saved in the settings file, or '' when the file is missing, cannot
 * be read, is not JSON, or has no top-level string "model". A UTF-8 byte order mark at the
 * start of the file is allowed.
 * @param {string} settingsPath
 * @returns {string}
 */
export function readSavedModel(settingsPath) {
  throw new Error('not implemented');
}

/**
 * Returns the settings text with the saved local model taken out again, or null when there
 * is nothing to undo. Changes only the one top-level "model" line; every other byte stays.
 * @param {string} text - the settings file's text (without a byte order mark)
 * @param {string} localModel - the local model name that may have been saved
 * @param {string} modelBefore - the default before the session; '' = no default
 * @returns {string | null}
 * @throws {Error} 'the "model" line does not have the expected format'
 */
export function replaceModelLine(text, localModel, modelBefore) {
  throw new Error('not implemented');
}

/**
 * Undoes a "/model" choice of the local model that Claude Code saved as the default for all
 * sessions. Never throws: a failure becomes a WARNING message through note().
 * @param {{ settingsPath: string, localModel: string, modelBefore: string,
 *   note: (message: string) => void }} options
 * @returns {void}
 */
export function restoreSavedModel(options) {
  throw new Error('not implemented');
}
