// Caps the reasoning effort in requests that go to the box.
// Some local models accept only "high", "medium" or "low" as the reasoning effort, and answer
// "max" or "xhigh" with HTTP 400. Requests to Anthropic never pass through here, so Claude
// models keep "max".

const TOO_HIGH = new Set(['max', 'xhigh']);

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
  if (!body.includes('output_config') && !body.includes('reasoning_effort')) {
    return { body, clamped: false };
  }

  let root;
  try {
    root = JSON.parse(body.toString('utf8'), keepNumberText);
  } catch {
    return { body, clamped: false };
  }
  if (root === null || typeof root !== 'object') {
    return { body, clamped: false };
  }

  // Both steps change only the tree that JSON.parse just made, never the caller's Buffer.
  const changedOutputConfig = clampOutputConfigEffort(root);
  const changedReasoning = clampReasoningEffort(root);
  if (!changedOutputConfig && !changedReasoning) {
    return { body, clamped: false };
  }
  return { body: Buffer.from(JSON.stringify(root), 'utf8'), clamped: true };
}

// A JSON.parse reviver that keeps the exact text of a number that would change when written
// back, for example an integer above 2^53. Node.js 22 gives the number's source text in
// `context`, and JSON.stringify writes a JSON.rawJSON value back as that text.
function keepNumberText(key, value, context) {
  if (typeof value === 'number' && typeof context?.source === 'string'
    && typeof JSON.rawJSON === 'function' && String(value) !== context.source) {
    return JSON.rawJSON(context.source);
  }
  return value;
}

// Changes a top-level output_config.effort of "max" or "xhigh" to "high".
// Returns true when it changed it.
function clampOutputConfigEffort(root) {
  if (Array.isArray(root)) {
    return false;
  }
  const outputConfig = root.output_config;
  if (outputConfig === null || typeof outputConfig !== 'object' || Array.isArray(outputConfig)) {
    return false;
  }
  if (!TOO_HIGH.has(outputConfig.effort)) {
    return false;
  }
  outputConfig.effort = 'high';
  return true;
}

// Changes every "reasoning_effort" of "max" or "xhigh" to "high", at any depth.
// Returns true when it changed anything.
function clampReasoningEffort(node) {
  if (node === null || typeof node !== 'object' || isRawJson(node)) {
    return false;
  }
  let changed = false;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === 'reasoning_effort' && TOO_HIGH.has(value)) {
      node[key] = 'high';
      changed = true;
    } else if (clampReasoningEffort(value)) {
      changed = true;
    }
  }
  return changed;
}

function isRawJson(value) {
  return typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(value);
}
