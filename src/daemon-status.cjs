'use strict';

/**
 * daemon-status.cjs — what the daemon ACTUALLY armed, reported by the daemon.
 *
 * Covers: runtime registry of background watchers; live status probes; the
 * /api/health payload. Key terms: armed, reason, probe, orchestrator-waker,
 * session-snapshot. Read when: a health field disagrees with reality, or a
 * background service is silently not running.
 *
 * Why this exists (2026-08-06): `bridge_health.session_snapshot_armed` was
 * computed from `process.env` inside the MCP SERVER — a different process from
 * the daemon that owns the watcher. It reported a wish, not a measurement, and
 * would have said "armed" while nothing was running. The same day, the
 * orchestrator-waker sat disarmed for 2h45m after a daemon restart dropped its
 * env var, with no log line and no health field to reveal it.
 *
 * Rule this file enforces: a component reports its own arming AT the point it
 * arms (or declines to), and health reads that registry. Nothing infers arming
 * from an environment variable it does not own.
 */

const registry = new Map(); // name -> { armed, reason, at, probe? }

/**
 * Record a component's arming decision. Call on BOTH paths — armed and not —
 * because "absent from the registry" and "deliberately off" must be
 * distinguishable in the health payload.
 *
 * @param {string} name        stable key, e.g. 'orchestrator_waker'
 * @param {object} info        { armed: boolean, reason: string, probe?: () => object }
 */
function set(name, info) {
  if (!name || typeof name !== 'string') throw new Error('daemon-status.set: name is required');
  if (!info || typeof info.armed !== 'boolean') {
    throw new Error(`daemon-status.set(${name}): info.armed must be a boolean`);
  }
  registry.set(name, {
    armed: info.armed,
    reason: info.reason || (info.armed ? 'armed' : 'not armed'),
    at: new Date().toISOString(),
    probe: typeof info.probe === 'function' ? info.probe : null,
  });
}

/**
 * Current status of every registered component. Probes run inside try/catch —
 * a component whose probe throws is reported as armed with a probe_error, never
 * allowed to break the health endpoint (a health surface that can 500 is worse
 * than no health surface).
 */
function snapshot() {
  const out = {};
  for (const [name, entry] of registry) {
    const item = { armed: entry.armed, reason: entry.reason, since: entry.at };
    if (entry.probe) {
      try {
        Object.assign(item, entry.probe());
      } catch (err) {
        item.probe_error = err.message;
      }
    }
    out[name] = item;
  }
  return out;
}

/** Test seam only — the daemon never clears its own registry. */
function _reset() { registry.clear(); }

module.exports = { set, snapshot, _reset };
