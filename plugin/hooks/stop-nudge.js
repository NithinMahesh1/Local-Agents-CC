// Claude Code runs this file at each Stop event of an --all-local session (see hooks.json). It
// reads the hook input as JSON on stdin and prints the hook's answer, if any, on stdout.
// The work is in src/stop-nudge.js. On any error this file prints nothing, so the turn ends as
// usual.

import { runStopHook } from '../../src/stop-nudge.js';

const chunks = [];
process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  try {
    const output = runStopHook(Buffer.concat(chunks).toString('utf8'), {
      env: process.env,
      platform: process.platform,
      now: new Date(),
    });
    if (output !== '') {
      process.stdout.write(output);
    }
  } catch {
    // Fail open: no output.
  }
});
