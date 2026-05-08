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

// Destructive-shell text that must NEVER be injected into a pane via
// send_prompt. Tight allowlist — false positives are worse than false
// negatives here (we just block, user can rephrase).
const DESTRUCTIVE_TEXT_PATTERNS = [
  /\brm\s+-rf\s+\//,                          // rm -rf / or rm -rf /home/...
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bformat\s+[A-Z]:/i,                       // Windows format C:
  /\bgit\s+push\s+(--force|-f)\s+origin\s+(main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bdd\s+if=.*of=\/dev\/(sd|nvme|hd)/,       // dd to a raw block device
  /\bmkfs(\.\w+)?\s+\/dev\//,                 // mkfs on a device
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,             // classic fork bomb
];

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
      DESTRUCTIVE_TEXT_PATTERNS.some((re) => re.test(prompt)),
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
      return { allowed: false, reason: rule.reason, matched: rule.name };
    }
  }
  return { allowed: true, reason: 'no destructive rule matched' };
}

module.exports = {
  evaluate,
  setSelfPaneIds,
  RULES,
  DESTRUCTIVE_TEXT_PATTERNS,
};
