# Limit what the local model can do

A model can be trained with a hidden trigger, often called a backdoor: when it sees the trigger, it acts against you. In a Claude Code session, the model's tool calls (shell commands, file reads and file edits) run on your computer, with the rights of your user. This page shows what Claude Code already stops, what it does not stop, and example settings that limit the damage in `--all-local` sessions.

## The risk

- For example, a model with a backdoor can read a `.env` file and send the secrets to a server.
- The tool calls run on your computer, not on the AI server. A firewall around the AI server does not stop what the model makes Claude Code do on your computer.
- In `--all-local` sessions, the main session and every agent run on the local model.

## What Claude Code already asks before

- In the default permission mode, a shell command that is not read-only needs your approval. Examples: `curl`, `wget`, or a `node` or `python` script.
- WebFetch asks before it fetches from a new domain (some documentation sites are approved already). `--all-local` turns off WebSearch.
- Claude Code asks before it reads files outside the working folders.

## What it does not stop

- Inside the working folder, the Read tool and read-only shell commands such as `cat` read files without a prompt. This includes `.env` files.
- A command that you approved with "Yes, and don't ask again" runs without a prompt later.
- `--dangerously-skip-permissions` turns off all prompts. Do not use it with `--all-local`.

## Use the example settings (macOS, Linux and WSL2)

- The file `examples/settings/all-local-guarded.json` in this package holds Claude Code settings. Pass it with `--settings` for one session. It does not change your settings files.
- Copy it, change `allowedDomains` to the hosts your work needs, and start the session:

```bash
mkdir -p ~/.config/local-agents-cc
cp "$(npm root -g)/local-agents-cc/examples/settings/all-local-guarded.json" ~/.config/local-agents-cc/
claude-agents --all-local --settings ~/.config/local-agents-cc/all-local-guarded.json
```

- On Linux and WSL2, the sandbox needs the programs `bubblewrap` and `socat`. On Ubuntu: `sudo apt install bubblewrap socat`.
- In the session, `/sandbox` shows the sandbox settings.

### What each part does

- `permissions.deny`: Claude's file tools (Read, Edit and Write) cannot open `.env` files in the project, or credential files in your home folder: `~/.ssh`, `~/.aws`, cloud and Git tokens, the token and password files of npm, PyPI and PostgreSQL, .NET user secrets, and the AI server key folder `~/.config/local-model`. The `WebFetch` rule removes the WebFetch tool, because the sandbox does not limit it.
- `sandbox.enabled`: shell commands run in Claude Code's sandbox, a limit that the operating system enforces. Their network connections are checked against the hosts in `allowedDomains`.
- `sandbox.network.strictAllowlist`: a connection to any other host fails at once. Without this setting, Claude Code asks you.
- `sandbox.credentials`: shell commands cannot read the listed credential files and folders. The listed token variables, for example `GITHUB_TOKEN`, are removed from their environment.
- `sandbox.filesystem.denyRead`: shell commands cannot read `.env` files under your home folder.
- `sandbox.allowUnsandboxedCommands: false`: Claude cannot run a blocked command again outside the sandbox. When you pass the file with `--settings`, settings files in a repository cannot loosen the sandbox.
- `sandbox.failIfUnavailable: true`: when the sandbox cannot start (for example on native Windows, or without bubblewrap), Claude Code stops instead of running commands without the sandbox.

### Before you use it

- Inside the sandbox, shell commands run without a prompt. They can still change files in the working folder, so check the changes with git.
- Each host in `allowedDomains` is also a way out. Add only the hosts your work needs.
- The `.env.*` rules also block files such as `.env.example`. Remove those rules if a task needs such files.
- If your `~/.npmrc` holds a token, add it to `sandbox.credentials.files`, then check that npm still works.
- Without WebFetch, Claude cannot read web pages. To allow some sites, remove `WebFetch` from `deny` and add `WebFetch(domain:<host>)` rules to `allow`. Claude Code then asks before it fetches from any other site.
- If your AI server key file is not in `~/.config/local-model` (you set `SPARK_ROUTER_KEY_FILE`), add its path to `permissions.deny` and to `sandbox.credentials.files`.
- `sandbox.filesystem.denyRead` covers `.env` files under your home folder only. If your projects are in another folder, for example under `/mnt/c` in WSL2, add a pattern for that folder.

## Native Windows

- The sandbox does not run on native Windows: there, Claude Code runs commands without it. With this file, Claude Code stops at startup, because of `failIfUnavailable`.
- Run `--all-local` sessions in WSL2 or in a virtual machine.
- Or remove the `sandbox` part of the file. The `permissions.deny` rules still work, but shell commands are not limited.

## What these settings do not stop

- They reduce the risk. They do not isolate the model completely.
- The strongest protection is outside Claude Code: a firewall on your computer that blocks outbound connections by default, agents in a container or a virtual machine without your secrets, and model weights from a trusted source, checked by their SHA-256 hash.
- MCP servers and hooks run outside the sandbox. So does WebFetch, if you allow it again.
- The local model server gets everything that the session reads. Run it on a machine that you control.

## More information

- [Claude Code: Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code: Configure permissions](https://code.claude.com/docs/en/permissions)
