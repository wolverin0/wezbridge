'use strict';
/**
 * team-manifest.cjs — Persistent JSONL append-log for wezbridge teams +
 * worktrees state (Task #6).
 *
 * teamsRegistry and worktreeRegistry in src/dashboard-server.cjs are
 * process-memory only; on dashboard restart they're lost — orchestrator
 * forgets which pane owned which worktree, what role each pane plays in
 * a PRD bootstrap, etc. Managed Agents' roster survives server state by
 * design; this module backfills that locally.
 *
 * Events appended to vault/_wezbridge/teams.jsonl, one JSON object per
 * line:
 *   { ts, event: 'team_added', team_name, prd, cwd, roles[] }
 *   { ts, event: 'worktree_added', pane_id, persona, worktree_path,
 *     branch_name, base_cwd }
 *   { ts, event: 'worktree_removed', pane_id }
 *   { ts, event: 'team_dissolved', team_name }
 *
 * On dashboard boot, replay() walks the log and reconstructs Maps. This
 * is "snapshot from event log" not "ledger of changes" — we only care
 * about the LATEST state per key (paneId/teamName).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG = path.resolve(__dirname, '..', 'vault', '_wezbridge', 'teams.jsonl');

function _ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Append one event. Best-effort; never throws to caller. */
function record(event, opts = {}) {
  if (!event || typeof event !== 'object' || !event.event) return false;
  const logPath = opts.logPath || DEFAULT_LOG;
  try {
    _ensureDir(logPath);
    const line = JSON.stringify({ ts: event.ts || new Date().toISOString(), ...event });
    fs.appendFileSync(logPath, line + '\n', 'utf8');
    return true;
  } catch (e) {
    // Persistence failure must not break the host. Caller may pass a
    // logger via opts.log to surface the issue.
    if (typeof opts.log === 'function') {
      opts.log(`team-manifest record failed: ${e.message}`);
    }
    return false;
  }
}

/** Read all events. Returns [] if log missing. Skips malformed lines. */
function readEvents(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG;
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Replay the log into fresh Map snapshots. Caller wires the result into
 * its in-memory registries.
 *
 * @param {Object} [opts] - { logPath }
 * @returns {{teams: Map, worktrees: Map}}
 */
function replay(opts = {}) {
  const events = readEvents(opts);
  const teams = new Map();
  const worktrees = new Map();
  for (const e of events) {
    if (!e || !e.event) continue;
    switch (e.event) {
      case 'team_added':
        if (e.team_name) {
          teams.set(e.team_name, {
            prd: e.prd || null,
            createdAt: e.ts,
            cwd: e.cwd || null,
            roles: Array.isArray(e.roles) ? e.roles : [],
          });
        }
        break;
      case 'team_dissolved':
        if (e.team_name) teams.delete(e.team_name);
        break;
      case 'worktree_added':
        if (e.pane_id !== undefined && e.pane_id !== null) {
          worktrees.set(e.pane_id, {
            persona: e.persona || null,
            worktreePath: e.worktree_path || null,
            branchName: e.branch_name || null,
            baseCwd: e.base_cwd || null,
          });
        }
        break;
      case 'worktree_removed':
        if (e.pane_id !== undefined && e.pane_id !== null) {
          worktrees.delete(e.pane_id);
        }
        break;
      // unknown events ignored — forward-compatible
    }
  }
  return { teams, worktrees };
}

module.exports = {
  DEFAULT_LOG,
  record,
  readEvents,
  replay,
};
