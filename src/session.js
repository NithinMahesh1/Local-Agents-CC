// The parts of local-agents-cc that only compute values: the help text, the split between
// local-agents-cc's own flags and claude's arguments, and the environment for one session.

/**
 * The text that `local-agents-cc --help` prints.
 * @param {{ routerUrl: string, logDir: string, localModel: string }} options
 * @returns {string}
 */
export function helpText({ routerUrl, logDir, localModel }) {
  return `local-agents-cc - Claude Code with your Claude plan models AND a local model on your box.

  Claude models (opus, sonnet, ...) -> spark-router -> api.anthropic.com  (your claude.ai login)
  Spark Agents (${localModel}) -> spark-router -> your local box  (free, home network only)

Usage:
  local-agents-cc [local-agents-cc flags] [claude options and arguments]

local-agents-cc flags (in any position; they do not go to claude):
  --all-local   Run EVERYTHING on the box: the main session, all agents and Claude Code's
                background jobs. No request uses your Claude plan - for when the plan
                limit is reached. Web search is off. Everything the session reads goes to
                the box: no client-identifying code, credentials, connection strings or
                customer data. Stops with an error if the box does not answer.
  --help, -h    Show this help (only when used alone). Claude Code's own help: claude --help

All other arguments go to claude unchanged. Examples:
  local-agents-cc                           normal session: Claude models; spark agents on the box
  local-agents-cc --all-local               the whole session and its agents on the box
  local-agents-cc -p "summarize README.md"  one prompt, print the answer, exit
  local-agents-cc --all-local -c            continue the last session, all on the box

Local model in a normal session:
  agents:        ask Claude to "fan out spark agents" (needs a spark-agent agent file;
                 see examples/agents/spark-agent.md in this package)
  whole session: /model -> "Spark Agents" -> press s (this session only)

Router: ${routerUrl} (SPARK_ROUTER_PORT changes it),
  started by local-agents-cc when needed.
Logs:   ${logDir}
Setup:  https://github.com/NithinMahesh1/Local-Agents-CC#readme
`;
}

/**
 * Splits local-agents-cc's own flags from the arguments that go to claude.
 * @param {string[]} argv - the command-line arguments after the command name
 * @returns {{ allLocal: boolean, showHelp: boolean, claudeArgs: string[] }}
 */
export function parseArgs(argv) {
  const allLocal = argv.includes('--all-local');
  const claudeArgs = argv.filter((arg) => arg !== '--all-local');
  const showHelp =
    claudeArgs.length > 0 && claudeArgs.every((arg) => arg === '--help' || arg === '-h');

  return { allLocal, showHelp, claudeArgs };
}

/**
 * The environment and arguments for one claude session. Never changes its inputs.
 * @param {{ baseEnv: Record<string, string | undefined>, routerUrl: string,
 *   localModel: string, allLocal: boolean, claudeArgs: string[] }} options
 * @returns {{ env: Record<string, string>, args: string[], notes: string[] }}
 */
export function buildSession({ baseEnv, routerUrl, localModel, allLocal, claudeArgs }) {
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
    'Free local model on your box - exact, mechanical coding tasks',
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
    args = ['--model=' + localModel, '--disallowedTools=WebSearch', ...claudeArgs];
    notes = [
      'ALL-LOCAL: this session, all its agents and its background jobs run on your local box. '
        + 'Web search is off.',
      'ALL-LOCAL: everything the session reads goes to the box - no client-identifying code, '
        + 'credentials, connection strings or customer data.',
    ];
  } else {
    args = [...claudeArgs];
    notes = [];
  }

  return { env, args, notes };
}
