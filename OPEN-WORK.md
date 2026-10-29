# Open work

This file lists work that was started but is not finished. Remove an item when it is done. Delete
this file when the list is empty.

## Tests to add

`test/launcher.test.js` has no tests yet for the launcher part of the Stop hook work
(`--missed-tool-calls` and the `--plugin-dir` argument). Add a `describe` block named
`main: missed tool calls and the plugin` with these cases:

1. `--missed-tool-calls` and no log file: exit code 0. The output says
   `No missed tool calls recorded yet.` and shows the log file path. Nothing goes to stderr. The log
   folder is not created, and no router starts.
2. `--missed-tool-calls --missed-events-file <file>`, where the file has 2 log lines from 2
   projects: the output shows `Total: 2`, `missed-tool-call: 2` and `app-one: 1`.
3. `SPARK_MISSED_EVENTS_FILE` set to a file with 1 log line: the output shows `Total: 1` and the
   file path.
4. `--missed-events-file x.jsonl` without `--missed-tool-calls`: exit code 1, and stderr says that
   the option works only together with `--missed-tool-calls`. The log folder is not created.
5. `--missed-tool-calls --missed-events-file` with no path: exit code 1, and stderr says that the
   option needs a file path.
6. `--missed-tool-calls --missed-events-file <a folder>`: exit code 1, and stderr says
   `cannot read`.
7. `--all-local -p hi`: Claude Code gets `--model=<local model>` as its first argument,
   `--plugin-dir=<package folder>/plugin`, and `-p hi` as its last two arguments.
8. A session without `--all-local`: Claude Code gets no `--plugin-dir` argument.
9. `--all-local` when `node` is not on `PATH`: stderr says `node is not on PATH`, and Claude Code
   gets no `--plugin-dir` argument.

## Fixes from the code review

- `local-agents-cc --missed-tool-calls --help` prints the report, not the help text. Check `--help`
  first in `main` (`src/launcher.js`), and add a test.
- `docs/how-it-works.md`: the `--all-local` section does not say that the launcher also passes
  `--plugin-dir=<package folder>/plugin`, or what the plugin's Stop hook does. Add one bullet.
- A relative path in `SPARK_MISSED_EVENTS_FILE` is used as it is. The Stop hook and
  `--missed-tool-calls` can run in different folders, so the same relative path can point to two
  different files. Make the path absolute in one place, or tell users to set an absolute path.
- `test/stop-nudge.test.js`: add tests for the 200-character limit on the reply line that the hook
  quotes, for each pattern in `ANNOUNCE_PATTERNS`, and for a Stop input without `background_tasks`.

## Checks in a real Claude Code session

These checks need a computer with Claude Code and a local model server.

- `--all-local` loads the plugin without a prompt, and `/hooks` lists its Stop hook.
- The user's own hooks still run next to the plugin's Stop hook.
- After a reply that announces a step but makes no tool call, `local-agents-cc --missed-tool-calls`
  shows `Total: 1`.
- With `examples/settings/all-local-guarded.json`: find out whether the Read deny rules also stop
  the Grep tool from showing the text of a denied file (for example `.env`) in a folder that it
  searches. Claude Code's documentation does not say.
- With the same file: a shell command that reads a denied file, for example `cat ~/.ssh/config`,
  fails inside the sandbox.
- Do the README steps on Windows 11 and on Ubuntu. macOS is not tested yet.

## Decisions

- Native Windows: Claude Code's sandbox does not run there. Decide whether to add an opt-in
  PreToolUse hook that checks commands, or to keep the advice to use WSL2 or a virtual machine.
