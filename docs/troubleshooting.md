# Troubleshooting

This document provides solutions to common problems when using Local-Agents-CC.

[Back to the README](../README.md)

## "spark-router did not start - see .../router-errors.log"
- First: open that file. It names the reason.
- Cause: The key file is missing or empty.
- Fix: Create the key file ([Configuration](configuration.md#the-key-file)).
- Cause: The port 8799 is in use.
- Fix: Set `SPARK_ROUTER_PORT` to a free port.

## "warning - the local model server is not answering"
- Cause: The router cannot reach `GET <box>/health`.
- Fix: Check that the box is on.
- Fix: Check that the model server finished starting. A large model can take several minutes.
- Fix: Check that `SPARK_ROUTER_LOCAL_URL` is correct.
- Fix: Check that the box's firewall allows your computer.
- Fix: Try the box's IPv4 address instead of its name.

## "the local model server is not answering, and --all-local needs it"
- Cause: The router cannot reach the local model server.
- Fix: Perform the same checks as in the previous problem.
- Fix: Start without `--all-local`.

## HTTP 401 from the box
- Cause: The key in the key file does not match the server's key.
- Fix: Make sure both keys are the same.

## HTTP 404, or "model does not exist", from the box
- Cause: `SPARK_ROUTER_LOCAL_MODELS` does not hold a name that the server serves.
- Fix: Ensure `SPARK_ROUTER_LOCAL_MODELS` matches the name in the vLLM `--served-model-name` setting.

## HTTP 400 when Claude Code uses tools
- Cause: Tool calling is not active on the server.
- Fix: Turn on tool calling in the server. Use `--enable-auto-tool-choice` and the correct `--tool-call-parser` for the model in vLLM.

## HTTP 400 that names the reasoning effort
- Cause: The model does not accept the effort value. The router already changes "max" and "xhigh" to "high" for box requests, so the value is another one.
- Fix: Lower the effort level in Claude Code.

## "Input length ... exceeds the model's maximum context length"
- Cause: The input text is too long for the model.
- Fix: Set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` below the model's context window. Leave room for the answer. For example, use 120,000 for a 131,072-token window.

## Plain claude fails after a session because of an unknown model
- Cause: Local-agents-cc could not put back the default model. It printed a WARNING.
- Fix: In plain claude, run `/model` and pick a Claude model.
- Fix: Remove the "model" line from `~/.claude/settings.json`.

## A changed setting has no effect
- Cause: The router keeps running with the settings it used when it started.
- Fix: Stop the router, then start `local-agents-cc` again.
- Fix: On Windows, open a new terminal after you change a User environment variable.
- Fix: Stop the router with the command for your system.

Windows (PowerShell):

```powershell
Get-NetTCPConnection -LocalPort 8799 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

macOS and Linux:

```bash
kill $(lsof -t -iTCP:8799 -sTCP:LISTEN)
```

## HTTP 403 "spark-router accepts only requests addressed to 127.0.0.1 or localhost"
- Cause: A client used a host name other than `127.0.0.1` or `localhost` for the router.
- Fix: Use `http://127.0.0.1:8799`.

## "claude was not found on PATH"
- Cause: Claude Code is not installed or its location is not in the system PATH.
- Fix: Install Claude Code (https://github.com/anthropics/claude-code).
- Fix: Open a new terminal.

## Answers are slow with many agents
- Cause: One box serves only a few agents at once. On a DGX Spark, it serves about 8 agents, or about 6 with gpt-oss-120b.
- Fix: More agents cause a queue. Start fewer agents.

## Where are the logs?
- Windows: `%LOCALAPPDATA%\spark-router`
- macOS: `~/Library/Logs/spark-router`
- Linux: `~/.local/state/spark-router` (or `$XDG_STATE_HOME/spark-router`)
- The files are `router.log` and `router-errors.log`. `SPARK_ROUTER_LOG_DIR` changes the folder.
- The logs never hold keys, headers or message text, so you can share lines in an issue. Remove your box's address first.

Still stuck? Open an issue: https://github.com/NithinMahesh1/Local-Agents-CC/issues
