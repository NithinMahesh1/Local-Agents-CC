# Changelog

## [0.2.0](https://github.com/NithinMahesh1/Local-Agents-CC/compare/v0.1.0...v0.2.0) (2026-10-30)


### Features

* add a Stop hook plugin and a missed tool call count ([85a1218](https://github.com/NithinMahesh1/Local-Agents-CC/commit/85a12181fe73c3021b78344c2c8e1525e4515c64))
* add setup and benchmark commands, and call the box "AI server" ([4e24693](https://github.com/NithinMahesh1/Local-Agents-CC/commit/4e2469330c9dc0e70abca9aeb78d5834c9109c76))
* add the router that sends each request to the box or to Anthropic ([248de80](https://github.com/NithinMahesh1/Local-Agents-CC/commit/248de80140ce540af4bbd839be7b6899130d6f81))
* add the session settings and help text for local-agents-cc ([fc9a5e7](https://github.com/NithinMahesh1/Local-Agents-CC/commit/fc9a5e7c104ec369e49afcdedfd0cde4543ffc58))
* cap the reasoning effort on requests to the box ([2b6a53e](https://github.com/NithinMahesh1/Local-Agents-CC/commit/2b6a53e767d844868d7fdf1cecd6fb51d9442e83))
* find and start claude on Windows, macOS and Linux without a shell ([f13007e](https://github.com/NithinMahesh1/Local-Agents-CC/commit/f13007ef8f595a29b799bd724d70a7b5203c4496))
* put back the default model that /model saved for all sessions ([d6ec724](https://github.com/NithinMahesh1/Local-Agents-CC/commit/d6ec724941f5205a945afa3d4ebc727b91a0df00))
* rename the launcher command to claude-agents ([1a69449](https://github.com/NithinMahesh1/Local-Agents-CC/commit/1a694496870e4b3a09d9218e98c160c899039b56))
* start the router in the background and run claude through it ([be6be43](https://github.com/NithinMahesh1/Local-Agents-CC/commit/be6be43997d2fb5163b99ed1452d966c1a4a76be))


### Bug Fixes

* make settings errors clearer and correct the docs ([8fcf47f](https://github.com/NithinMahesh1/Local-Agents-CC/commit/8fcf47f3cf2b00b16957b9083100710d91da645a))


### Documentation

* add a page that lists every command-line option ([1c38743](https://github.com/NithinMahesh1/Local-Agents-CC/commit/1c38743a3aa5a7358b32da82bfb1674b03b740fb))
* add an example agent file for per-task work ([cdd2ffc](https://github.com/NithinMahesh1/Local-Agents-CC/commit/cdd2ffc5d0a89fb38262a008fb19dd13f6d217f8))
* add blank lines around headings, lists, tables and code blocks ([000ee64](https://github.com/NithinMahesh1/Local-Agents-CC/commit/000ee64f28dd9f266d2829a30cf97a2c36bc8bbe))
* add contributor and coding agent guides ([15029ea](https://github.com/NithinMahesh1/Local-Agents-CC/commit/15029ea211c76244dd017f4a70081c8503efc483))
* add the README, guides and security policy ([b1d01b1](https://github.com/NithinMahesh1/Local-Agents-CC/commit/b1d01b10bfed1d84453113c4ea8055f9cdc23faf))
* describe the new router checks for bad URLs and path tricks ([460a522](https://github.com/NithinMahesh1/Local-Agents-CC/commit/460a5228e5fe547b5d8361eaac3b957df7778454))
* list the work that is not finished yet ([84305e0](https://github.com/NithinMahesh1/Local-Agents-CC/commit/84305e016bf60ccac46246c603c3f9a826ff4a69))
* remove the affiliation note from the README ([3abe0ba](https://github.com/NithinMahesh1/Local-Agents-CC/commit/3abe0ba95cebb1a9a6fc24d5d65146d8074c2124))

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
