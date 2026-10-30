# Changelog

## 0.1.0 (2026-10-26)

### Features

- `claude-agents` starts Claude Code with your local model in the `/model` menu as "Local Agents", next to the Claude models.
- `spark-router` sends each request to your local model server or to Anthropic, by the model name in the request.
- `--all-local` sends every request, from the main session and from agents, to your local model.
- In `--all-local` sessions, a Stop hook sends the model back once when a reply says what the model will do next but makes no tool call. `claude-agents --missed-tool-calls` counts these events.
- An example settings file, `examples/settings/all-local-guarded.json`, turns on Claude Code's sandbox, blocks reads of common secret files and turns off WebFetch. See `docs/local-model-safety.md`.
- Requests to the AI server do not carry your Claude login. The router adds the AI server key, and changes the reasoning effort "max" and "xhigh" to "high".
- When a session ends, the launcher puts back the default model that `/model` saved for all sessions, so plain `claude` keeps working.
- The router accepts only requests addressed to `127.0.0.1` or `localhost`, and it routes only JSON requests.
- `claude-agents --setup` asks for the AI server's address, API key and model name, saves them, and checks that the AI server answers.
- `claude-agents --benchmark` measures the speed of your AI server: the time to the first token and tokens per second.
- The launcher command is `claude-agents`. The npm package is still `local-agents-cc`.
