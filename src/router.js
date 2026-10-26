// spark-router: a small local router that lets ONE Claude Code session use both your Claude
// plan models and a local model on another machine (your "box").
//
// The one rule:
//   * A request whose JSON body names a LOCAL model goes to your local model server (for
//     example vLLM, or anything that serves the Anthropic Messages API), with the box's key.
//   * Every other request goes to https://api.anthropic.com UNCHANGED, so the claude.ai login
//     that Claude Code sends keeps working and your plan pays.
//
// Safety rules built in:
//   * Listens on 127.0.0.1 only, and answers only requests addressed to 127.0.0.1 or localhost.
//   * Your Claude login headers are removed before a request goes to the box.
//   * The box's API key is read from a file: never in this code, never logged.
//   * Each log line shows method, path, model, destination, status and time: never headers,
//     never query strings, never message text.

import { ANTHROPIC_URL, HEALTH_PATH, isLocalModel } from './config.js';
import { clampBoxEffort } from './effort.js';

/**
 * Starts the router on 127.0.0.1.
 * @param {object} options
 * @param {number} options.port - TCP port; 0 picks a free port (for tests)
 * @param {string[]} options.localModels - model names that go to the box (any case)
 * @param {string} options.localUrl - the box's base URL, for example http://your-box.local:8000
 * @param {string} options.boxKey - the box's API key; sent only to the box, never logged
 * @param {string} [options.anthropicUrl] - default ANTHROPIC_URL; tests pass a local server
 * @param {(body: Buffer) => { body: Buffer, clamped: boolean }} [options.clampEffort]
 *   - default clampBoxEffort; called only for box requests
 * @param {{ info: (message: string) => void, warn: (message: string) => void }} [options.log]
 *   - default createLogger()
 * @param {number} [options.maxBodyBytes] - largest request body; default 256 MiB
 * @returns {Promise<import('node:http').Server>} resolves when the server listens; rejects
 *   on a listen error (for example EADDRINUSE)
 */
export function startRouter(options) {
  throw new Error('not implemented');
}

/**
 * An error body in the same shape as Anthropic's errors, so Claude Code shows the message:
 * {"type":"error","error":{"type":"api_error","message":"<message>"}}
 * @param {string} message
 * @returns {string}
 */
export function errorJson(message) {
  throw new Error('not implemented');
}

/**
 * A logger that writes one line per call: "HH:MM:SS info: <message>" or
 * "HH:MM:SS warn: <message>" (local time, 24-hour clock).
 * @param {{ write: (text: string) => unknown }} [stream] - default process.stdout
 * @returns {{ info: (message: string) => void, warn: (message: string) => void }}
 */
export function createLogger(stream = process.stdout) {
  throw new Error('not implemented');
}
