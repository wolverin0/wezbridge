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

// ── Liveness heartbeat ─────────────────────────────────────────────────────
// The daemon cannot report its own death. Nothing watched it, so when it died
// the whole wake loop died silently (audit hole 3, 2026-08-06). A file solves
// exactly that: it OUTLIVES the process, so its staleness is positive evidence
// of death — "last beat 40 minutes ago" is knowable when the daemon is gone,
// which is precisely when you need to know it.

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
// Three missed beats. Tight enough to notice within ~2 min, loose enough that a
// GC pause or a busy machine never cries wolf — an alert that fires on healthy
// systems trains everyone to ignore it.
const HEARTBEAT_STALE_MS = 95 * 1000;

function startHeartbeat({ file, intervalMs = HEARTBEAT_INTERVAL_MS, write, now = () => Date.now() }) {
  if (!file) throw new Error('daemon-status.startHeartbeat: file is required');
  const writeFn = write || ((p, data) => {
    const fs = require('node:fs');
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p); // atomic: a reader never sees a half-written beat
  });
  const beat = () => {
    try {
      writeFn(file, `${JSON.stringify({
        ts: new Date(now()).toISOString(),
        pid: process.pid,
        intervalMs,
        services: snapshot(),
      }, null, 1)}\n`);
    } catch { /* a failed beat must never take the daemon down */ }
  };
  const handle = setInterval(beat, intervalMs);
  if (handle && handle.unref) handle.unref();
  beat();
  return () => clearInterval(handle);
}

function readHeartbeat(file, read) {
  try {
    const readFn = read || ((p) => require('node:fs').readFileSync(p, 'utf8'));
    return JSON.parse(readFn(file));
  } catch { return null; }
}

/**
 * Turn raw liveness into plain-language alerts. Numbers in a health blob are
 * only observable if somebody interprets them (audit hole 4) — so the
 * interpretation happens HERE, once, and every caller gets sentences.
 *
 * `daemonReachable` is the live HTTP probe; the heartbeat is the forensic
 * record. Together they separate "down" from "up but wedged": a daemon that
 * answers HTTP while its heartbeat has gone stale has a dead timer loop, which
 * looks perfectly healthy to a port check.
 */
function assessLiveness({ heartbeat, daemonReachable, now = Date.now(), staleMs = HEARTBEAT_STALE_MS }) {
  const alerts = [];
  const ageMs = heartbeat && heartbeat.ts ? now - Date.parse(heartbeat.ts) : null;
  const stale = ageMs === null || ageMs > staleMs;

  if (!daemonReachable) {
    alerts.push(heartbeat && heartbeat.ts
      ? `DAEMON DOWN — last heartbeat ${describeAge(ageMs)} ago (${heartbeat.ts}). The wake loop is not running; nothing will poke the orchestrator. Restart with \`npm run dashboard\`.`
      : 'DAEMON DOWN — and no heartbeat file was ever written. The wake loop is not running. Restart with `npm run dashboard`.');
  } else if (stale) {
    alerts.push(`DAEMON WEDGED — it answers HTTP but its heartbeat is ${describeAge(ageMs)} old. Timers are not firing, so the wake loop is dead despite the port being open. Restart it.`);
  }

  const svc = (heartbeat && heartbeat.services) || {};
  const waker = svc.orchestrator_waker;
  if (daemonReachable && !stale) {
    if (!waker) {
      alerts.push('ORCHESTRATOR WAKER MISSING — the daemon is healthy but never registered a waker at all. Pane completions will not reach the orchestrator.');
    } else if (!waker.armed) {
      alerts.push(`ORCHESTRATOR WAKER OFF — ${waker.reason}. Pane completions will not reach the orchestrator.`);
    } else if (typeof waker.cursorLagBytes === 'number' && waker.cursorLagBytes > 4096) {
      alerts.push(`WAKER FALLING BEHIND — ${waker.cursorLagBytes} bytes of pane events written but unread. Completions are piling up undelivered.`);
    }
  }
  return { ok: alerts.length === 0, alerts, heartbeatAgeMs: ageMs };
}

function describeAge(ms) {
  if (ms === null || Number.isNaN(ms)) return 'an unknown time';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}min` : `${(m / 60).toFixed(1)}h`;
}

module.exports = {
  set, snapshot, _reset,
  startHeartbeat, readHeartbeat, assessLiveness,
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS,
};
