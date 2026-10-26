# Command-line options

This document lists the options of the two commands in this package: `local-agents-cc` (the launcher) and `spark-router` (the router). Settings such as the port and the box address are environment variables, not options. See [Configuration](configuration.md).

[Back to the README](../README.md)

## local-agents-cc

```bash
local-agents-cc [local-agents-cc options] [Claude Code options and arguments]
```

### Options of local-agents-cc

These options can be in any position. `local-agents-cc` removes them before it starts Claude Code.

| Option | What it does |
| :--- | :--- |
| `--all-local` | Sends every request to your box: the main session, all agents and Claude Code's background jobs. No request uses your Claude plan. Web search is off, because it runs on Anthropic's servers. If the box does not answer, the command stops with an error. Details: [The --all-local mode](how-it-works.md#the---all-local-mode). |
| `--help`, `-h` | Shows the help of `local-agents-cc`. This works only when `--help` or `-h` is the only argument, or comes only with `--all-local`. In all other cases, the option goes to Claude Code. |

`local-agents-cc --version` shows the version of Claude Code, because `--version` goes to Claude Code. To see the version of this package, use `spark-router --version`.

### Claude Code options

All other arguments go to Claude Code unchanged and in the same order. So every Claude Code option works with `local-agents-cc`. The options change between Claude Code versions. For the full list for your version, run `claude --help`.

These Claude Code options are often useful with `local-agents-cc` (checked with Claude Code 2.1.310):

| Option | What it does |
| :--- | :--- |
| `-c`, `--continue` | Continues the most recent conversation in the current folder. |
| `-r`, `--resume [id or name]` | Continues the conversation with that ID or name. Without a value, it shows a list to pick from. |
| `-p`, `--print` | Runs one prompt, prints the answer and exits. |
| `--model <model>` | Sets the model for the session. Your local model name (for example `local-model`) starts the main session on the box. |
| `--permission-mode <mode>` | Sets the permission mode for the session. |
| `--add-dir <directories...>` | Lets the tools use more folders. |
| `-n`, `--name <name>` | Sets a display name for the session. |

### How the options work together

- `--all-local` puts `--model=<local model>` and `--disallowedTools=WebSearch` before your own arguments. When you also give `--model`, Claude Code uses your value, because it comes later.
- With `--all-local`, the model names opus, sonnet, haiku and fable point to your local model. A full Claude model name, for example `claude-sonnet-5-5`, still goes to Anthropic and uses your Claude plan.
- `--model <local model>` without `--all-local` starts the main session on the box. Agents and Claude Code's background jobs can still use Claude models.

### Examples

| Command | What it does |
| :--- | :--- |
| `local-agents-cc` | A normal session. Claude models go to Anthropic; your local model is in `/model` as "Spark Agents". |
| `local-agents-cc -c` | Continues the last conversation in this folder. |
| `local-agents-cc --all-local` | The whole session and its agents run on the box. |
| `local-agents-cc --all-local -c` | Continues the last conversation, all on the box. |
| `local-agents-cc --all-local -p "Summarize README.md"` | Runs one prompt on the box, prints the answer and exits. |
| `local-agents-cc --model local-model` | A normal session that starts on the box. |

## spark-router

```bash
spark-router [--help | --version]
```

| Option | What it does |
| :--- | :--- |
| (no option) | Starts the router in this terminal. It writes its log lines to the terminal. Press `Ctrl+C` to stop it. |
| `--help`, `-h` | Shows the help. |
| `--version`, `-v` | Shows the version of the package. |

Any other argument stops the command with an error. You do not usually start the router yourself: `local-agents-cc` starts it in the background when it does not answer. See [Run the router by hand](configuration.md#run-the-router-by-hand).
