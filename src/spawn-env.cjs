'use strict';
/**
 * spawn-env.cjs — M3 (retro 2026-08-24): sanitize the env a spawned Claude
 * pane inherits. Panes get their env from the WEZTERM MUX, and when the mux
 * itself was (re)launched from inside a Claude session — crash recovery did
 * exactly that on 2026-08-24 — every spawned pane inherits
 * CLAUDE_CODE_CHILD_SESSION and boots with transcript saving OFF. That marker
 * cost a full session's transcript on 2026-08-23 and nearly a second one today
 * (pane 32, killed at 30s old).
 *
 * The fix rides the command we already TYPE into the pane: prefix the claude
 * invocation with `env -u CLAUDE_CODE_CHILD_SESSION
 * CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`. `env` exists in every POSIX shell
 * this fleet spawns (Git Bash/MINGW64 on this machine). Operators on cmd/pwsh
 * default shells can opt out with WEZBRIDGE_NO_SPAWN_ENV_SANITIZE=1.
 *
 * Only `claude` needs this — the marker means nothing to codex or plain shells.
 */

const SANITIZE_PREFIX = 'env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 ';

/**
 * @param {string} cliCmd  the already-quoted command line about to be typed
 * @param {string} agent   'claude' | 'codex' | 'shell'
 * @param {object} env     process.env (injectable for tests)
 * @returns {string} the command line, sanitized when it boots claude
 */
function sanitizeAgentCmd(cliCmd, agent, env = process.env) {
  if (!cliCmd || agent !== 'claude') return cliCmd;
  if (env.WEZBRIDGE_NO_SPAWN_ENV_SANITIZE === '1') return cliCmd;
  return SANITIZE_PREFIX + cliCmd;
}

module.exports = { sanitizeAgentCmd, SANITIZE_PREFIX };
