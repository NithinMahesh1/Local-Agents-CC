# Using more than one local server

## What this does
- spark-router can send requests to more than one local model server.
- It chooses the server by the model name in each request.
- A model name it does not know goes to your Claude plan as usual.

## The settings file
- The file is ~/.config/local-model/settings.json.
- Put this block in it:
```json
{
  "servers": [
    { "name": "spark", "url": "http://your-ai-server.local:8000", "models": ["spark-coder"], "type": "anthropic" },
    { "name": "desktop", "url": "http://127.0.0.1:1234", "models": ["desktop-docs"], "type": "openai" }
  ]
}
```
- name (a label you choose)
- url (the server address)
- models (the model names that go to this server; each name is used by only one server)
- type ("anthropic" or "openai")
- keyFile (an optional path to a per-server key file; the default is ~/.config/local-model/api-key)

## How routing works
- A request whose model name is in a server's "models" list goes to that server, with that server's key.
- Any other model name goes to your Claude plan at api.anthropic.com, unchanged.

## Example: different machines for different work
- Make one agent that uses the model "spark-coder" and one that uses "desktop-docs".
- Tell Claude: use the spark agents for coding and the desktop agents for documentation.
- Coding requests then go to the "spark" server. Documentation requests go to the "desktop" server.

## Server type
- type "anthropic": the server already speaks the Anthropic Messages API (for example vLLM set up that way). This works now.
- type "openai": the server speaks the OpenAI Chat Completions API (for example LM Studio or Ollama). spark-router translates between the Anthropic and OpenAI formats, so these servers work.

## Adding a server later

To add a server without editing the settings file by hand, run `claude-agents --add-server`.
It will ask you:
- A name you choose for the new server.
- Its address, for example `http://127.0.0.1:1234`.
- Which software runs it (1 = vLLM, which serves the Anthropic API; 2 = LM Studio or Ollama, which serve the OpenAI API).
- Its API key.
- The model name.

It checks that the server answers and then saves it.
If your settings file only has one server, it moves that server into a "servers" list and offers to rename it.

## Safety
- spark-router listens on 127.0.0.1 only.
- Each server has its own key file. Keys are never written to the logs.
- Your Claude login headers are removed before a request goes to a local server.
