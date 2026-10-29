# Agent instructions

This project is Local-Agents-CC, an npm package that routes requests between Claude Code and a local model server.

## Commands

- `npm test`
- `node bin/claude-agents.js --help`
- `node bin/spark-router.js --help`

## Rules

- This project has zero runtime dependencies. Do not add packages, and never run `npm install <package>`.
- Use Node.js 22 or later and ES modules. Import built-in modules with the `node:` prefix.
- Follow the code style: 2-space indent, single quotes, semicolons, lines of at most 100 characters, and braces for every control flow body.
- Use JSDoc on all exported functions.
- Every change in behavior needs a test. Tests must use `node:test` and `node:assert/strict`.
- Never use port 8799 in tests.
- Never use the real `~/.claude` folder in tests.
- The router must always:
  - Listen on `127.0.0.1` only.
  - Answer only requests for `127.0.0.1` or `localhost`.
  - Read the model name only from JSON requests.
  - Never send `Authorization`, `x-api-key`, or `Cookie` headers to the local model.
  - Keep the Anthropic address fixed in the code.
  - Never let a request path change the destination host.
  - Never log headers, query strings, message text, or keys.
- Write documentation in plain English. Update `README.md`, `docs/`, and `--help` texts together when changing settings or behavior.
- Never put keys, real hostnames, IP addresses other than `127.0.0.1`, or other private data in code, tests, docs, or commits.

## Where things are

- `bin/claude-agents.js`: The launcher command.
- `bin/spark-router.js`: The router command.
- `src/config.js`: Settings from environment variables.
- `src/router.js`: The router.
- `src/effort.js`: The reasoning effort cap.
- `src/session.js`: Launcher settings, arguments, and help text.
- `src/launcher.js`: Starts the router and Claude Code.
- `src/spawn-command.js`: Finds and starts Claude Code on Windows, macOS, and Linux.
- `src/settings-guard.js`: Puts back the saved default model.
- `src/stop-nudge.js`: The Stop hook of --all-local sessions: sends the model back once when a reply announces a step but makes no tool call, and logs the event.
- `src/missed-events.js`: Reads and counts the missed tool call log (`--missed-tool-calls`).
- `plugin/`: The Claude Code plugin that --all-local sessions load. It holds the Stop hook.
- `test/`: One test file per module.
- `docs/`: User documentation.
- `examples/agents/spark-agent.md`: An example agent file.
- `examples/settings/all-local-guarded.json`: Example sandbox and deny settings for --all-local sessions.

## Pull requests

- Use Conventional Commits for titles (for example `feat:` or `fix:`).
- Send one focused change per pull request.
- A human must review the entire diff before opening the pull request.
