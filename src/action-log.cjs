'use strict';
/**
 * action-log.cjs — unified fleet action log: WHO did WHAT to WHOM and WHY.
 * Appends one JSON line per action to Py Apps/_intel/actions.jsonl.
 * Born 2026-08-22 after the pane-34 mystery: a headless orchestrator turn
 * spawned a pane and NOTHING recorded the spawner (mm-96f8/mm-7d0e).
 * Writers so far: wezterm.cjs spawnPane/killPane, orchestrator-turn.cjs
 * turn-start/turn-end. Future writers: Hermes bot routines, ledger dispatches.
 * NEVER throws — observability must not break the action it observes.
 * Actor resolution: WEZBRIDGE_ACTOR env > pane-<WEZTERM_PANE> > script name.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOG_PATH = path.resolve(__dirname, '..', '..', '_intel', 'actions.jsonl');

function resolveActor() {
  if (process.env.WEZBRIDGE_ACTOR) return process.env.WEZBRIDGE_ACTOR;
  if (process.env.WEZTERM_PANE) return `pane-${process.env.WEZTERM_PANE}`;
  const script = process.argv[1] ? path.basename(process.argv[1], '.cjs') : null;
  return script || `pid-${process.pid}`;
}

/**
 * logAction('spawn_pane', { target: cwd, why: corr, extra: {...} })
 * All fields optional except action. Silent no-op on any failure.
 */
function logAction(action, { target = '', why = '', extra = null } = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      actor: resolveActor(),
      pid: process.pid,
      action,
      target,
      why: why || process.env.WEZBRIDGE_ACTION_WHY || '',
      ...(extra ? { extra } : {}),
    });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* never break the caller */ }
}

module.exports = { logAction, LOG_PATH };
