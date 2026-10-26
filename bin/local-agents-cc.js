#!/usr/bin/env node
// local-agents-cc: starts Claude Code with your Claude plan models AND a local model on your
// box. The work is in src/launcher.js.

import { main } from '../src/launcher.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`local-agents-cc: ${error.message}\n`);
  process.exitCode = 1;
}
