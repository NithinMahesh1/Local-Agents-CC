# Changelog

## 0.1.0 (2026-10-26)

### Features

- `local-agents-cc` starts Claude Code with your local model in the `/model` menu as "Spark Agents", next to the Claude models.
- `spark-router` sends each request to your local model server or to Anthropic, by the model name in the request.
- `--all-local` sends every request, from the main session and from agents, to your local model.
- In `--all-local` sessions, a Stop hook sends the model back once when a reply says what the model will do next but makes no tool call. `local-agents-cc --missed-tool-calls` counts these events.
- An example settings file, `examples/settings/all-local-guarded.json`, turns on Claude Code's sandbox, blocks reads of common secret files and turns off WebFetch. See `docs/local-model-safety.md`.
- Requests to the box do not carry your Claude login. The router adds the box key, and changes the reasoning effort "max" and "xhigh" to "high".
- When a session ends, the launcher puts back the default model that `/model` saved for all sessions, so plain `claude` keeps working.
- The router accepts only requests addressed to `127.0.0.1` or `localhost`, and it routes only JSON requests.
