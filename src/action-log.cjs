'use strict';
/**
 * action-log.cjs — unified fleet action log: WHO did WHAT to WHOM and WHY.
 * Appends one JSON line per action to Py Apps/_intel/actions.jsonl.
 * Born 2026-08-22 after the pane-34 mystery: a headless orchestrator turn
 * spawned a pane and NOTHING recorded the spawner (mm-96f8/mm-7d0e).
 * Writers: wezterm.cjs spawnPane/killPane/spawn_refused, orchestrator-turn.cjs,
 * mcp-server (auto_ack, auto_close_shadow, affinity_override), project-queue.
 * v2 (B2): optional corr/task/project fields; dir auto-created; path honors
 * WEZBRIDGE_INTEL_DIR. NEVER throws — observability must not break the action.
 * Actor resolution: WEZBRIDGE_ACTOR env > pane-<WEZTERM_PANE> > script name.
 */

const fs = require('node:fs');
const path = require('node:path');

// Default kept as a constant for back-compat readers; logAction resolves the
// path per call via logPath() so tests (and relocated control planes) can
// point WEZBRIDGE_INTEL_DIR elsewhere without re-requiring the module.
const LOG_PATH = path.resolve(__dirname, '..', '..', '_intel', 'actions.jsonl');

function logPath() {
  return process.env.WEZBRIDGE_INTEL_DIR
    ? path.join(process.env.WEZBRIDGE_INTEL_DIR, 'actions.jsonl')
    : LOG_PATH;
}

function resolveActor() {
  if (process.env.WEZBRIDGE_ACTOR) return process.env.WEZBRIDGE_ACTOR;
  if (process.env.WEZTERM_PANE) return `pane-${process.env.WEZTERM_PANE}`;
  const script = process.argv[1] ? path.basename(process.argv[1], '.cjs') : null;
  return script || `pid-${process.pid}`;
}

/**
 * logAction('spawn_pane', { target: cwd, why: corr, extra: {...} })
 * All fields optional except action. Silent no-op on any failure.
 * v2 (B2, 2026-08-22): creates the _intel dir if missing, and accepts
 * optional attribution fields `corr` / `task` / `project` on the record so
 * lines join against a2a threads and the ledger without parsing `why` prose.
 */
function logAction(action, { target = '', why = '', corr = null, task = null, project = null, extra = null } = {}) {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      actor: resolveActor(),
      pid: process.pid,
      action,
      target,
      why: why || process.env.WEZBRIDGE_ACTION_WHY || '',
      ...(corr ? { corr } : {}),
      ...(task ? { task } : {}),
      ...(project ? { project } : {}),
      ...(extra ? { extra } : {}),
    });
    fs.appendFileSync(file, line + '\n');
  } catch { /* never break the caller */ }
}

module.exports = { logAction, logPath, LOG_PATH };
