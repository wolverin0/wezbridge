'use strict';
/**
 * safety-policy.cjs — Shared destructive-op gate for wezbridge MCP +
 * dashboard handlers.
 *
 * Sibling to scripts/command-guard.cjs (which gates SHELL commands via
 * PATH shims). This one gates wezbridge's NATIVE actions: send_prompt
 * with destructive shell content, kill_session targeting the orchestrator,
 * worktree cleanup outside .worktrees/, broadcast spam.
 *
 * Used by:
 *   - src/mcp-server.cjs handlers (send_prompt, send_key, kill_session,
 *     auto_handoff)
 *   - src/dashboard-server.cjs handlers (handlePostPrompt, handlePostKey,
 *     handlePostKill, worktree routes)
 *
 * Contract:
 *   evaluate(ctx) → { allowed: bool, reason: string, matched?: string }
 *
 * Override: WEZBRIDGE_SAFETY_OVERRIDE=1 bypasses for one call. The caller
 * is responsible for unsetting after consumption (same pattern as
 * WEZBRIDGE_GUARD_OVERRIDE in command-guard.cjs).
 *
 * See docs/PLAN-managed-agents-backfill.md task #2.
 */

const path = require('node:path');

const SAFETY_TRIPWIRE_RESPONSE = [
  'Safety tripwire triggered.',
  'This request looks destructive and was not sent to the pane.',
  'Confirm the exact action via the dashboard side channel before retrying.',
].join(' ');

// Destructive-shell text that must NEVER be injected into a pane via
// send_prompt. These catch known bypass forms before the command allowlist.
const DESTRUCTIVE_TEXT_PATTERNS = [
  /\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+(?:--\s*)?\//i, // rm -rf / or rm -rf /home/...
  /\bsudo\s+rm\b/i,
  /\bRemove-Item\b(?=.*\b-(?:Recurse|r)\b)(?=.*\b-(?:Force|f)\b)/i,
  // AXIS-1: PowerShell abbreviated recursive/force params (Remove-Item -Rec -Fo)
  /\bRemove-Item\b.*-(?:Rec|Fo)/i,
  // AXIS-1: PowerShell built-in aliases ri/del/erase with recursive or force flags
  /\b(?:ri|del|erase)\b.*-(?:Recurse|Rec|r|Force|Fo|f)/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\btruncate\s+(?:[^\n;]*\s)?--size\s*=\s*0\b/i,
  /(^|[;&|\s]):>\s*\S+/,                      // shell truncation: :> file
  /\bformat\s+[A-Z]:/i,                       // Windows format C:
  /\bgit\s+push\s+(--force|-f)\s+origin\s+(main|master)\b/i,
  /\bgit\s+push\b[^\n;]*--force-with-lease\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bgh\s+repo\s+delete\b/i,
  /\bdd\b(?=.*\bif=\/dev\/zero\b)/i,
  /\bdd\s+if=.*of=\/dev\/(sd|nvme|hd)/,       // dd to a raw block device
  /\bmkfs(\.\w+)?\s+\/dev\//,                 // mkfs on a device
  /\bshred\b/i,
  /\bwipefs\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,             // classic fork bomb
];

const SHELL_INTENT_RE = /^\s*(?:\$|>|(?:please\s+)?(?:run|execute|type|paste)\s+)(.+)$/i;
const SHELL_COMMAND_RE = /^(?:git|gh|rm|sudo|truncate|dd|mkfs(?:\.\w+)?|shred|wipefs|Remove-Item|format|npm|pnpm|yarn|node|ls|dir|pwd|echo|cat|type|rg|grep)\b/i;
const ALLOWED_SHELL_TEXT_PATTERNS = [
  /^git\s+(?:status|diff|log|show|branch)\b/i,
  /^git\s+checkout\s+-b\s+[\w./-]+$/i,
  /^git\s+push\s+(?:-u\s+)?origin\s+(?!main\b|master\b)[\w./-]+$/i,
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+[\w:-]+)\b/i,
  /^node\s+(?:--test|--check)\b/i,
  /^(?:ls|dir|pwd|echo|cat|type|rg|grep)\b/i,
];

function _shellCommandFromLine(line) {
  const match = String(line || '').match(SHELL_INTENT_RE);
  return (match ? match[1] : line).trim();
}

function _hasUnallowlistedShellIntent(prompt) {
  return String(prompt || '').split(/\r?\n/).some((line) => {
    const command = _shellCommandFromLine(line);
    if (!SHELL_COMMAND_RE.test(command)) return false;
    return !ALLOWED_SHELL_TEXT_PATTERNS.some((re) => re.test(command));
  });
}

function _promptIsUnsafe(prompt) {
  const text = String(prompt || '');
  return DESTRUCTIVE_TEXT_PATTERNS.some((re) => re.test(text)) || _hasUnallowlistedShellIntent(text);
}

function _blocked(rule) {
  const result = { allowed: false, reason: rule.reason, matched: rule.name };
  if (process.env.WEZBRIDGE_SAFETY_TRIPWIRE === 'true') {
    process.stderr.write(`[safety-policy] tripwire ${rule.name}: ${rule.reason}\n`);
    result.tripwire = true;
    result.response = SAFETY_TRIPWIRE_RESPONSE;
  }
  return result;
}

// Self-pane registry — populated by host at startup. The orchestrator
// MUST NOT target its own pane(s) for kill / hard send_key sequences.
let _selfPaneIds = new Set();

/** Register pane IDs that represent the orchestrator/dashboard itself. */
function setSelfPaneIds(ids) {
  if (!Array.isArray(ids)) ids = [ids];
  _selfPaneIds = new Set(ids.map((id) => String(id)));
}

function _isSelfPane(paneId) {
  return paneId !== undefined && paneId !== null && _selfPaneIds.has(String(paneId));
}

function _normalizePath(p) {
  if (!p) return p;
  return path.resolve(String(p)).replace(/\\/g, '/');
}

const RULES = [
  {
    name: 'no_self_kill',
    test: ({ action, paneId }) =>
      action === 'kill_session' && _isSelfPane(paneId),
    reason: "kill_session targets the orchestrator/dashboard's own pane",
  },
  {
    name: 'no_destructive_prompt_injection',
    test: ({ action, prompt }) =>
      action === 'send_prompt' &&
      typeof prompt === 'string' &&
      _promptIsUnsafe(prompt),
    reason: 'send_prompt contains destructive shell content',
  },
  {
    name: 'worktree_outside_dotworktrees',
    test: ({ action, worktreePath, baseCwd }) => {
      if (action !== 'worktree_remove' && action !== 'worktree_prune') return false;
      if (!worktreePath || !baseCwd) return false;
      const norm = _normalizePath(worktreePath);
      const expected = _normalizePath(path.join(String(baseCwd), '.worktrees'));
      return !(norm.startsWith(expected + '/') || norm === expected);
    },
    reason: 'worktree op targets a path outside <baseCwd>/.worktrees/',
  },
  {
    name: 'broadcast_too_wide',
    test: ({ action, recipientCount }) =>
      action === 'broadcast' &&
      typeof recipientCount === 'number' &&
      recipientCount > 10,
    reason: 'broadcast targets >10 panes — likely spam',
  },
  {
    name: 'send_key_ctrl_c_to_self',
    test: ({ action, paneId, key }) =>
      action === 'send_key' &&
      _isSelfPane(paneId) &&
      typeof key === 'string' &&
      /^ctrl\+c$/i.test(key),
    reason: "send_key ctrl+c to the orchestrator's own pane (would interrupt the host)",
  },
];

/**
 * Evaluate a wezbridge-native action against the safety rules.
 *
 * @param {Object} ctx
 * @param {string} ctx.action - one of: kill_session, send_prompt, send_key,
 *   worktree_remove, worktree_prune, broadcast, auto_handoff
 * @param {string|number} [ctx.paneId] - target pane ID
 * @param {string} [ctx.prompt] - text being sent (for send_prompt)
 * @param {string} [ctx.key] - key being sent (for send_key)
 * @param {string} [ctx.worktreePath] - worktree path (for worktree_*)
 * @param {string} [ctx.baseCwd] - repo root (for worktree path safety)
 * @param {number} [ctx.recipientCount] - target count (for broadcast)
 * @returns {{allowed: boolean, reason: string, matched?: string}}
 */
function evaluate(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return { allowed: true, reason: 'empty context' };
  }
  if (process.env.WEZBRIDGE_SAFETY_OVERRIDE === '1') {
    return { allowed: true, reason: 'WEZBRIDGE_SAFETY_OVERRIDE=1' };
  }
  for (const rule of RULES) {
    let hit = false;
    try {
      hit = !!rule.test(ctx);
    } catch (_err) {
      // A buggy rule must not crash the host; treat as no-match.
      hit = false;
    }
    if (hit) {
      return _blocked(rule);
    }
  }
  return { allowed: true, reason: 'no destructive rule matched' };
}

module.exports = {
  evaluate,
  setSelfPaneIds,
  RULES,
  DESTRUCTIVE_TEXT_PATTERNS,
  ALLOWED_SHELL_TEXT_PATTERNS,
  SAFETY_TRIPWIRE_RESPONSE,
};
