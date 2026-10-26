// Caps the reasoning effort in requests that go to the box.
// Some local models accept only "high", "medium" or "low" as the reasoning effort, and answer
// "max" or "xhigh" with HTTP 400. Requests to Anthropic never pass through here, so Claude
// models keep "max".

/**
 * Changes a reasoning effort of "max" or "xhigh" to "high", in two places only:
 *  - the top-level "output_config": { "effort": ... } (how Claude Code sends its effort).
 *    Only the top level is read, so an "effort" inside the message history (for example an
 *    Agent tool call's input) never changes;
 *  - every "reasoning_effort" key, at any depth (other clients).
 * Nothing else in the body changes. When the body is not valid JSON, or holds neither value,
 * the same Buffer comes back with clamped = false.
 *
 * @param {Buffer} body - the request body as received
 * @returns {{ body: Buffer, clamped: boolean }}
 */
export function clampBoxEffort(body) {
  throw new Error('not implemented');
}
