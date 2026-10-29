# Command-line options

This document lists the options of the two commands in this package: `claude-agents` (the launcher) and `spark-router` (the router). Settings such as the port and the AI server address are environment variables, not options. See [Configuration](configuration.md).

[Back to the README](../README.md)

## claude-agents

```bash
claude-agents [claude-agents options] [Claude Code options and arguments]
```

### Options of claude-agents

These options can be in any position. `claude-agents` removes them before it starts Claude Code.

| Option | What it does |
| :--- | :--- |
| `--setup` | Asks for the AI server's address, API key and model name, saves them, checks the AI server, then exits. Use it alone. Starts no router and no Claude Code. |
| `--benchmark` | Measures the speed of your AI server: 3 runs of one prompt, then exits. Prints the time to the first token and tokens per second. Use it alone. |
| `--all-local` | Sends every request to your AI server: the main session, all agents and Claude Code's background jobs. No request uses your Claude plan. Web search is off, because it runs on Anthropic's servers. If the AI server does not answer, the command stops with an error. A Stop hook sends the model back once when a reply announces a step but makes no tool call. Details: [The --all-local mode](how-it-works.md#the---all-local-mode). |
| `--missed-tool-calls` | Shows how often the Stop hook of `--all-local` sessions sent the model back, by kind, model and project, then exits. It starts no router and no claude. It reads `missed-tool-events.jsonl` in the log folder, or the file that `SPARK_MISSED_EVENTS_FILE` names. |
| `--missed-events-file <file>` | Only together with `--missed-tool-calls`: read this file instead. `--missed-events-file=<file>` also works. Used alone, it is an error. |
| `--help`, `-h` | Shows the help of `claude-agents`. This works only when `--help` or `-h` is the only argument, or comes only with `--all-local` or `--missed-tool-calls`. With `--setup` or `--benchmark`, it is an error, because those options work only alone. In all other cases, the option goes to Claude Code. |

`claude-agents --version` shows the version of Claude Code, because `--version` goes to Claude Code. To see the version of this package, use `spark-router --version`.

### Claude Code options

All other arguments go to Claude Code unchanged and in the same order. So every Claude Code option works with `claude-agents`. The options change between Claude Code versions. For the full list for your version, run `claude --help`.

These Claude Code options are often useful with `claude-agents` (checked with Claude Code 2.1.310):

| Option | What it does |
| :--- | :--- |
| `-c`, `--continue` | Continues the most recent conversation in the current folder. |
| `-r`, `--resume [id or name]` | Continues the conversation with that ID or name. Without a value, it shows a list to pick from. |
| `-p`, `--print` | Runs one prompt, prints the answer and exits. |
| `--model <model>` | Sets the model for the session. Your local model name (for example `local-model`) starts the main session on the AI server. |
| `--permission-mode <mode>` | Sets the permission mode for the session. |
| `--add-dir <directories...>` | Lets the tools use more folders. |
| `-n`, `--name <name>` | Sets a display name for the session. |

### How the options work together

- `--all-local` also adds `--plugin-dir=<package folder>/plugin`, the plugin that holds the Stop hook.
- `--all-local` puts `--model=<local model>` and `--disallowedTools=WebSearch` before your own arguments. When you also give `--model`, Claude Code uses your value, because it comes later.
- With `--all-local`, the model names opus, sonnet, haiku and fable point to your local model. A full Claude model name, for example `claude-sonnet-5-5`, still goes to Anthropic and uses your Claude plan.
- `--model <local model>` without `--all-local` starts the main session on the AI server. Agents and Claude Code's background jobs can still use Claude models.

### Examples

| Command | What it does |
| :--- | :--- |
| `claude-agents --setup` | First-time setup: saves the AI server's address, API key and model name. |
| `claude-agents --benchmark` | Measures the speed of your AI server and exits. |
| `claude-agents` | A normal session. Claude models go to Anthropic; your local model is in `/model` as "Spark Agents". |
| `claude-agents -c` | Continues the last conversation in this folder. |
| `claude-agents --all-local` | The whole session and its agents run on the AI server. |
| `claude-agents --all-local -c` | Continues the last conversation, all on the AI server. |
| `claude-agents --all-local -p "Summarize README.md"` | Runs one prompt on the AI server, prints the answer and exits. |
| `claude-agents --missed-tool-calls` | Counts the missed tool calls of `--all-local` sessions and exits. |
| `claude-agents --model local-model` | A normal session that starts on the AI server. |

## Measure the speed of your AI server

`claude-agents --benchmark` measures the speed of your AI server (the computer that runs your local model). It sends one fixed prompt (a request for a story of about 400 words) 3 times, straight to the AI server, not through the router. Each run allows up to 512 output tokens. A token is a small piece of text, about 3/4 of a word.

For each run it prints: the time to the first token (how long you wait before the answer starts) and the output speed in tokens per second (tok/s). Then it prints the median (the middle value) of the 3 runs.

It uses the saved settings: the address and the first model name (from `claude-agents --setup` or the environment variables) and the API key file.

It must be used alone. It starts no router and no Claude Code. Exit code 0 when all runs work, 1 otherwise.

With a reasoning model, the thinking text counts as output too: the model generates it before the answer.

If the AI server does not report the token count, the line says "about N tokens (counted)": the count is then the number of text pieces the server sent.

The speed depends on the AI server, the model and how busy the server is. Other requests at the same time (for example spark agents) make it slower. The router itself adds almost no time.

Example of the output format (not a measurement):
```
Benchmark: local-model at http://my-ai-server.local:8000 (3 runs, up to 512 output tokens each)
Run 1: first token 0.45 s, 512 tokens in 10.20 s = 50.1 tok/s
Run 2: first token 0.40 s, 512 tokens in 10.10 s = 50.6 tok/s
Run 3: first token 0.41 s, 512 tokens in 10.15 s = 50.3 tok/s
Median: first token 0.41 s, 50.3 tok/s
```

## spark-router

```bash
spark-router [--help | --version]
```

| Option | What it does |
| :--- | :--- |
| (no option) | Starts the router in this terminal. It writes its log lines to the terminal. Press `Ctrl+C` to stop it. |
| `--help`, `-h` | Shows the help. |
| `--version`, `-v` | Shows the version of the package. |

Any other argument stops the command with an error. You do not usually start the router yourself: `claude-agents` starts it in the background when it does not answer. See [Run the router by hand](configuration.md#run-the-router-by-hand).
