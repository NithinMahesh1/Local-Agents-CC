# Changelog

## 0.1.0 (2026-10-26)

### Features

- `local-agents-cc` starts Claude Code with your local model in the `/model` menu as "Spark Agents", next to the Claude models.
- `spark-router` sends each request to your local model server or to Anthropic, by the model name in the request.
- `--all-local` sends every request, from the main session and from agents, to your local model.
- Requests to the box do not carry your Claude login. The router adds the box key, and changes the reasoning effort "max" and "xhigh" to "high".
- When a session ends, the launcher puts back the default model that `/model` saved for all sessions, so plain `claude` keeps working.
- The router accepts only requests addressed to `127.0.0.1` or `localhost`, and it routes only JSON requests.
