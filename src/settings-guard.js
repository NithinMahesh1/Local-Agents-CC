// Guard for Claude Code's saved default model.
// In a claude-agents session, "/model -> Local Agents -> Enter" saves the local model as the
// default for ALL sessions. Plain `claude` cannot reach the local model, so when the session
// ends, claude-agents puts the old default back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Path of Claude Code's user settings file: $CLAUDE_CONFIG_DIR/settings.json when that
 * variable is set and not blank, else <home>/.claude/settings.json.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function claudeSettingsPath(env = process.env) {
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim() !== '') {
    return path.join(env.CLAUDE_CONFIG_DIR.trim(), 'settings.json');
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * The top-level "model" saved in the settings file, or '' when the file is missing, cannot
 * be read, is not JSON, or has no top-level string "model". A UTF-8 byte order mark at the
 * start of the file is allowed.
 * @param {string} settingsPath
 * @returns {string}
 */
export function readSavedModel(settingsPath) {
  try {
    const buffer = fs.readFileSync(settingsPath);
    const text = buffer.subarray(hasBom(buffer) ? BOM.length : 0).toString('utf8');
    const json = JSON.parse(text);
    if (json !== null && typeof json === 'object' && typeof json.model === 'string') {
      return json.model;
    }
  } catch {
    // Ignore errors
  }
  return '';
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
  const esc = localModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^  "model": "' + esc + '"(,?)[ \\t]*(\\r?\\n|(?![\\s\\S]))', 'gm');
  const matches = [...text.matchAll(pattern)];

  if (matches.length !== 1) {
    const hasMatch = new RegExp('"model"\\s*:\\s*"' + esc + '"').test(text);
    if (!hasMatch) {
      return null;
    }
    throw new Error('the "model" line does not have the expected format');
  }

  const match = matches[0];
  const matchIndex = match.index;
  const head = text.slice(0, matchIndex);
  const tail = text.slice(match.index + match[0].length);
  const comma = match[1];
  const lineEnd = match[2];

  if (modelBefore !== '') {
    const value = modelBefore.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return head + '  "model": "' + value + '"' + comma + lineEnd + tail;
  }

  if (comma === ',') {
    return head + tail;
  }

  // modelBefore empty and no comma (the line was the last key)
  return head.replace(/,(\s*)$/, '$1') + tail;
}

/**
 * Undoes a "/model" choice of the local model that Claude Code saved as the default for all
 * sessions. Never throws: a failure becomes a WARNING message through note().
 * @param {{ settingsPath: string, localModel: string, modelBefore: string,
 *   note: (message: string) => void }} options
 * @returns {void}
 */
export function restoreSavedModel({ settingsPath, localModel, modelBefore, note }) {
  let tmp = '';
  try {
    if (!fs.existsSync(settingsPath)) {
      return;
    }

    const buffer = fs.readFileSync(settingsPath);
    const keepBom = hasBom(buffer);
    const text = buffer.subarray(keepBom ? BOM.length : 0).toString('utf8');

    const newText = replaceModelLine(text, localModel, modelBefore);
    if (newText === null) {
      return;
    }

    // Write a new file, then swap it in with one rename: a crash cannot leave half a file.
    tmp = settingsPath + '.local-agents-cc.tmp';
    const newBytes = Buffer.from(newText, 'utf8');
    fs.writeFileSync(tmp, keepBom ? Buffer.concat([BOM, newBytes]) : newBytes);
    fs.chmodSync(tmp, fs.statSync(settingsPath).mode & 0o777);
    fs.renameSync(tmp, settingsPath);

    const restored = modelBefore || 'the built-in default';
    note(`/model had saved ${localModel} as the default for all sessions - `
      + `changed it back to ${restored}.`);
  } catch (error) {
    if (tmp && fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // The warning below matters more than a left-over temporary file.
      }
    }
    note(`WARNING - the default model in ${settingsPath} may still be ${localModel}; `
      + `plain claude will fail until you change it. (${error.message})`);
  }
}

// The UTF-8 byte order mark that some editors put at the start of a file.
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasBom(buffer) {
  return buffer.subarray(0, BOM.length).equals(BOM);
}
