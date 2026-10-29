# Configuration

This document describes how to configure Local-Agents-CC.

[Back to the README](../README.md)

## Settings

| Variable | Default | What it does |
| :--- | :--- | :--- |
| `SPARK_ROUTER_PORT` | `8799` | The port on 127.0.0.1. Use a whole number from 1 to 65535. |
| `SPARK_ROUTER_LOCAL_MODELS` | `local-model` | Comma-separated names of local models, compared without regard to case. The first name is the one that `local-agents-cc` offers in `/model` and uses for `--all-local`. The other names also go to the box, for example an older name in a saved session. |
| `SPARK_ROUTER_LOCAL_URL` | `http://your-box.local:8000` | The URL of the local model server. It must start with `http://` or `https://`. |
| `SPARK_ROUTER_KEY_FILE` | `~/.config/local-model/api-key` | The path to the file that contains the local model API key. |
| `SPARK_ROUTER_LOG_DIR` | *Platform specific* | The folder where the router writes logs. |
| `SPARK_MISSED_EVENTS_FILE` | `missed-tool-events.jsonl` in the log folder | File where the Stop hook of `--all-local` sessions records each missed tool call. |
| `LOCAL_MODEL_CONTINUE` | not set | `off` turns off the Stop hook of `--all-local` sessions. |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `120000` (set by `local-agents-cc`) | The context window that Claude Code assumes for model names it does not know; Claude models keep their own. Keep it under the local model's real window, with room for the answer, or a long request fails with "Input length ... exceeds the model's maximum context length". If you set it yourself, the launcher keeps your value. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Read only. The folder that holds Claude Code's `settings.json`, for the settings guard. |

## Set a variable permanently

On macOS/Linux, add `export` lines to `~/.zshrc` or `~/.bashrc`, then open a new terminal.
On Windows, use the following command in PowerShell, then open a new terminal:

```powershell
[Environment]::SetEnvironmentVariable('NAME', 'value', 'User')
```

## The key file

The key file must contain only the key on one line.
The router does not start if the file is missing or empty.
Create the key file on macOS/Linux:

```bash
mkdir -p ~/.config/local-model
touch ~/.config/local-model/api-key
chmod 600 ~/.config/local-model/api-key
```

After you create the file, paste the key using an editor.
Create the key file on Windows:

```powershell
New-Item -ItemType Directory -Force "$HOME\.config\local-model" | Out-Null
notepad "$HOME\.config\local-model\api-key"
```

After you create the file, paste the key using Notepad. Do not type the key directly in a command.

## Log files

The router writes logs in the `SPARK_ROUTER_LOG_DIR`.
The default log directory depends on your platform:

- Windows: `%LOCALAPPDATA%\spark-router`
- macOS: `~/Library/Logs/spark-router`
- Linux: `$XDG_STATE_HOME/spark-router` or `~/.local/state/spark-router`

The log files are:

- `router.log`: Contains one line per request.
- `router-errors.log`: Contains startup errors.
- `router.previous.log`: The `router.log` from the previous run.
- `router-errors.previous.log`: The `router-errors.log` from the previous run.
- `missed-tool-events.jsonl`: one JSON line each time the Stop hook of an `--all-local` session sent the model back: `when`, `session_id`, `cwd`, `model` and `kind`. It never holds message text. `local-agents-cc --missed-tool-calls` counts the lines.

The router writes these files only when `local-agents-cc` starts it. When you run `spark-router` by hand, it writes to the terminal.

## Run the router by hand

You can run the router directly in your terminal.
Use `spark-router` to start the router.
Use `spark-router --help` to see the help message.
Use `spark-router --version` to see the version.
Press `Ctrl+C` to stop the router.

## Stop or restart the router

If the router is already running, it keeps its old settings until you stop it.
To stop the router on macOS/Linux:

```bash
kill $(lsof -t -iTCP:8799 -sTCP:LISTEN)
```

To stop the router on Windows:

```powershell
Get-NetTCPConnection -LocalPort 8799 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }
```

## Values that cannot be used

`SPARK_ROUTER_PORT` must be a whole number from 1 to 65535.
`SPARK_ROUTER_LOCAL_MODELS` must name at least one model.
`SPARK_ROUTER_LOCAL_URL` must start with `http://` or `https://`.
If you use a value that cannot be used, the command stops with a clear message, for example: `SPARK_ROUTER_PORT must be a whole number from 1 to 65535 (got "abc")`.
