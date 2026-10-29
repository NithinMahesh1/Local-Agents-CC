#!/usr/bin/env node
// spark-router: runs the router in this window. claude-agents starts it in the background
// when it does not answer, so you need this command only to watch the router or to run it
// as a service.

import { loadConfig, packageVersion, readKeyFile } from '../src/config.js';
import { startRouter } from '../src/router.js';

const HELP = `spark-router - the local router that claude-agents starts for you.

Requests for a local model name go to your AI server. All other requests go to
api.anthropic.com unchanged. The router listens on 127.0.0.1 only.

Usage:
  spark-router            run the router in this window (Ctrl+C stops it)
  spark-router --help     show this help
  spark-router --version  show the version

Settings (environment variables):
  SPARK_ROUTER_PORT          port on 127.0.0.1 (default 8799)
  SPARK_ROUTER_LOCAL_MODELS  model names that go to the AI server (default local-model)
  SPARK_ROUTER_LOCAL_URL     your AI server's address (default http://your-ai-server.local:8000)
  SPARK_ROUTER_KEY_FILE      file with the AI server's API key
                             (default <home>/.config/local-model/api-key)

Docs: https://github.com/NithinMahesh1/Local-Agents-CC#readme
`;

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write(HELP);
} else if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
  process.stdout.write(`${packageVersion()}\n`);
} else if (args.length > 0) {
  process.stderr.write(`spark-router: unknown argument "${args[0]}". Try: spark-router --help\n`);
  process.exitCode = 2;
} else {
  try {
    const config = loadConfig();
    const boxKey = readKeyFile(config.keyFile);
    await startRouter({ ...config, boxKey });
  } catch (error) {
    process.stderr.write(`spark-router: ${error.message}\n`);
    process.exitCode = 1;
  }
}
