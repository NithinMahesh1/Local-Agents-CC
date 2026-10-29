# Contributing to Local-Agents-CC

Welcome to the Local-Agents-CC project.

## Ways to help

- Report a bug using the bug report form.
- Suggest a feature using the feature request form.
- Open a feature request form before you write code for a large change.
- Improve the documentation.
- Send a pull request.

## Before you start

This project has zero runtime dependencies on purpose. Runtime dependencies are external packages that the code needs to run. Without them, users can read all the code they run, and they have fewer packages to trust. A change that adds a dependency needs an issue, and agreement on that issue, before you write the code.

## Development setup

Use Node.js 22 or a later version. The `.nvmrc` file specifies Node.js 24.

```bash
git clone https://github.com/NithinMahesh1/Local-Agents-CC.git
cd Local-Agents-CC
npm test
```

You do not need to run `npm install`.

You can test the commands by running:

```bash
node bin/claude-agents.js --help
node bin/spark-router.js --help
```

## Project layout

| Path | What it does |
| :--- | :--- |
| `bin/claude-agents.js` | The launcher command. |
| `bin/spark-router.js` | The router command. |
| `src/config.js` | Settings from environment variables. |
| `src/router.js` | The router. |
| `src/effort.js` | The reasoning effort cap. |
| `src/session.js` | Launcher settings, arguments, and help text. |
| `src/launcher.js` | Starts the router and Claude Code. |
| `src/spawn-command.js` | Finds and starts Claude Code on Windows, macOS, and Linux. |
| `src/settings-guard.js` | Puts back the saved default model. |
| `test/` | One test file per module. |
| `docs/` | User documentation. |
| `examples/agents/spark-agent.md` | An example agent file. |

## Code style

- Use ES modules.
- Use built-in Node.js modules with the `node:` prefix.
- Use a 2-space indent.
- Use single quotes.
- Use semicolons.
- Keep lines at most 100 characters.
- Use braces for every `if`, `else`, `for`, and `while` body, even for one line.
- Use JSDoc on all exported functions.
- Do not change objects that a caller passes in.
- Write short comments in plain English.
- Do not use `console.log` in the `src/` directory.

## Tests

Every change in behavior needs a test.

- Tests use `node:test` and `node:assert/strict`.
- Test servers listen on `127.0.0.1` with port 0.
- Temporary files go in a folder under `os.tmpdir()` and are removed after the test.
- Tests must never use port 8799.
- Tests must never use the real `~/.claude` folder.
- Run `npm test` on your own computer before you open a pull request. The project has no CI (continuous integration) test workflow; the maintainer tests releases on Windows and Linux.

## Safety rules for the router

All changes to the router must keep these rules:

- Listen on `127.0.0.1` only.
- Answer only requests addressed to `127.0.0.1` or `localhost`.
- Read the model name only from JSON requests.
- Never send the `Authorization`, `x-api-key`, or `Cookie` header to the local model server.
- Keep the Anthropic address fixed in the code.
- Never let a request path change the destination host.
- Never log headers, query strings, message text, or keys.

## Documentation

Write documentation in plain English.
When you change a setting or a behavior, you must update `README.md`, the `docs/` directory, and the `--help` texts together.

## Pull requests

- Send one focused change per pull request.
- Use Conventional Commits for the title. Use prefixes like `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `ci:`, or `chore:`.
- Add `!` to the prefix for a breaking change (for example, `feat!:`).
- A workflow checks the title.
- Fill in the pull request template.
- AI-assisted contributions are welcome.
- You must read and understand the entire diff before you open a pull request.

## Releases (maintainers)

The `release-please` GitHub Action manages releases. It reads Conventional Commit messages on `main` and opens a release pull request. This pull request updates the version and `CHANGELOG.md`.
When a maintainer merges that pull request, the release workflow creates the tag and the GitHub release, runs the tests and publishes to npm with npm trusted publishing. The repository holds no npm token.

One-time setup for maintainers:

1. Publish the first version by hand from a clean checkout: `npm publish --access public`.
2. Create the GitHub release for that version: `gh release create v0.1.0 --title v0.1.0 --notes "First release."`. Release Please starts from it.
3. On npmjs.com, in the package settings, add a trusted publisher: GitHub Actions, this repository, and the workflow file `release.yml`.
4. In the GitHub repository settings, under Actions, allow GitHub Actions to create pull requests.
5. In the GitHub repository settings, under General, allow only squash merging, with the pull request title as the commit message. Release Please reads these commit messages.
6. Under Security, turn on private vulnerability reporting.

## Security problems

Do not open a public issue for security problems. See `SECURITY.md`.
