// The parts of claude-agents that only compute values: the help text, the split between
// the launcher's own flags and claude's arguments, and the environment for one session.

/**
 * The text that `claude-agents --help` prints.
 * @param {{ routerUrl: string, logDir: string, localModel: string }} options
 * @returns {string}
 */
export function helpText({ routerUrl, logDir, localModel }) {
  return `claude-agents - Claude Code with your Claude plan models AND a local model on your AI
server (the computer that runs your local model).

  Claude models (opus, sonnet, ...) -> spark-router -> api.anthropic.com  (your claude.ai login)
  Spark Agents (${localModel}) -> spark-router -> your AI server  (free, home network only)

Usage:
  claude-agents [claude-agents flags] [claude options and arguments]

First time: run claude-agents --setup. It asks for your AI server's address, its API key and
the model name, and checks that the AI server answers.

claude-agents flags (in any position; they do not go to claude):
  --setup       Ask for the AI server's address, API key and model name, save them, check
                the AI server, then exit. Use it alone. Starts no router and no claude.
  --benchmark   Measure the speed of your AI server: 3 runs of one prompt, then exit. Prints
                the time to the first token and the output speed in tokens per second.
                Use it alone. Starts no router and no claude.
  --all-local   Run EVERYTHING on the AI server: the main session, all agents and Claude
                Code's background jobs. No request uses your Claude plan - for when the plan
                limit is reached. Web search is off. Everything the session reads goes to
                the AI server: no client-identifying code, credentials, connection strings
                or customer data. Stops with an error if the AI server does not answer. When
                the model ends a reply with a plan but no tool call, a Stop hook sends it
                back once and records the event.
  --missed-tool-calls
                Show how often that Stop hook sent the model back, by model and project,
                then exit. Starts no router and no claude.
  --missed-events-file <file>
                With --missed-tool-calls: read this file instead of the default log.
  --help, -h    Show this help (only when used alone). Claude Code's own help: claude --help

All other arguments go to claude unchanged. Examples:
  claude-agents                           normal session: Claude models; spark agents on
                                          the AI server
  claude-agents --all-local               the whole session and its agents on the AI server
  claude-agents -p "summarize README.md"  one prompt, print the answer, exit
  claude-agents --all-local -c            continue the last session, all on the AI server

Local model in a normal session:
  agents:        ask Claude to give a task to spark-agent (needs the agent file:
                 see examples/agents/spark-agent.md in this package)
  whole session: /model -> "Spark Agents" -> press s (this session only)

Router: ${routerUrl} (SPARK_ROUTER_PORT changes it),
  started by claude-agents when needed.
Logs:   ${logDir}
Setup:  https://github.com/NithinMahesh1/Local-Agents-CC#readme
All options: https://github.com/NithinMahesh1/Local-Agents-CC/blob/main/docs/command-line.md
`;
}

/**
 * Splits the launcher's own flags from the arguments that go to claude.
 * @param {string[]} argv - the command-line arguments after the command name
 * @returns {{ allLocal: boolean, showHelp: boolean, setup: boolean, benchmark: boolean,
 *   missedToolCalls: boolean,
 *   missedEventsFile: string | null, claudeArgs: string[] }} missedEventsFile is the value of
 *   --missed-events-file (as the next argument, or after "="), '' when the flag has no value,
 *   and null when the flag is not used
 */
export function parseArgs(argv) {
  const valueFlag = '--missed-events-file';
  let allLocal = false;
  let setup = false;
  let benchmark = false;
  let missedToolCalls = false;
  let missedEventsFile = null;
  const claudeArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all-local') {
      allLocal = true;
    } else if (arg === '--setup') {
      setup = true;
    } else if (arg === '--benchmark') {
      benchmark = true;
    } else if (arg === '--missed-tool-calls') {
      missedToolCalls = true;
    } else if (arg === valueFlag) {
      missedEventsFile = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith(`${valueFlag}=`)) {
      missedEventsFile = arg.slice(valueFlag.length + 1);
    } else {
      claudeArgs.push(arg);
    }
  }
  const showHelp =
    claudeArgs.length > 0 && claudeArgs.every((arg) => arg === '--help' || arg === '-h');

  return { allLocal, showHelp, setup, benchmark, missedToolCalls, missedEventsFile, claudeArgs };
}

/**
 * The environment and arguments for one claude session. Never changes its inputs.
 * @param {{ baseEnv: Record<string, string | undefined>, routerUrl: string,
 *   localModel: string, allLocal: boolean, claudeArgs: string[],
 *   pluginDir?: string | null }} options - pluginDir: the Claude Code plugin folder that an
 *   --all-local session loads (it holds the Stop hook), or null for none
 * @returns {{ env: Record<string, string>, args: string[], notes: string[] }}
 */
export function buildSession({
  baseEnv,
  routerUrl,
  localModel,
  allLocal,
  claudeArgs,
  pluginDir = null,
}) {
  let env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  /**
   * Returns a NEW object based on the current environment.
   * @param {Record<string, string>} currentEnv
   * @param {string} name
   * @param {string | null} value
   * @returns {Record<string, string>}
   */
  function withVar(currentEnv, name, value) {
    const nextEnv = {};
    const upperName = name.toUpperCase();
    for (const [k, v] of Object.entries(currentEnv)) {
      if (k.toUpperCase() !== upperName) {
        nextEnv[k] = v;
      }
    }
    if (value !== null) {
      nextEnv[name] = value;
    }
    return nextEnv;
  }

  env = withVar(env, 'ANTHROPIC_API_KEY', null);
  env = withVar(env, 'ANTHROPIC_AUTH_TOKEN', null);
  env = withVar(env, 'ANTHROPIC_BASE_URL', routerUrl);
  env = withVar(env, 'ANTHROPIC_CUSTOM_MODEL_OPTION', localModel);
  env = withVar(env, 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'Spark Agents');
  env = withVar(
    env,
    'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
    'Free local model on your AI server - exact, mechanical coding tasks',
  );

  let maxContextTokens = '120000';
  for (const [k, v] of Object.entries(env)) {
    if (
      k.toUpperCase() === 'CLAUDE_CODE_MAX_CONTEXT_TOKENS' &&
      typeof v === 'string' &&
      v.trim() !== ''
    ) {
      maxContextTokens = v;
      break;
    }
  }
  env = withVar(env, 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', maxContextTokens);

  let args;
  let notes;

  if (allLocal) {
    env = withVar(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', localModel);
    env = withVar(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', localModel);
    env = withVar(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', localModel);
    env = withVar(env, 'ANTHROPIC_DEFAULT_FABLE_MODEL', localModel);
    env = withVar(env, 'CLAUDE_CODE_SUBAGENT_MODEL', localModel);
    env = withVar(env, 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', '1');
    env = withVar(env, 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', '1');
    env = withVar(env, 'BASH_DEFAULT_TIMEOUT_MS', '600000');
    args = [
      '--model=' + localModel,
      '--disallowedTools=WebSearch',
      ...(pluginDir ? ['--plugin-dir=' + pluginDir] : []),
      ...claudeArgs,
    ];
    notes = [
      'ALL-LOCAL: this session, all its agents and its background jobs run on your local '
        + 'AI server. Web search is off.',
      'ALL-LOCAL: everything the session reads goes to the AI server - no client-identifying code, '
        + 'credentials, connection strings or customer data.',
    ];
  } else {
    args = [...claudeArgs];
    notes = [];
  }

  return { env, args, notes };
}
