#!/usr/bin/env node
// claude-agents: starts Claude Code with your Claude plan models AND a local model on your
// AI server. The work is in src/launcher.js.

import { main } from '../src/launcher.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`claude-agents: ${error.message}\n`);
  process.exitCode = 1;
}
