'use strict';
/**
 * a2a-heartbeat.cjs — A2A heartbeat SLA watcher (Task #5 from
 * docs/PLAN-managed-agents-backfill.md).
 *
 * The A2A protocol contract (per CLAUDE.md "Push-vs-watch asymmetry")
 * requires every responder to emit type=progress every ~3 min during
 * long work AND type=result on completion. Without enforcement, silent
 * specialists waste whole panes — the orchestrator never gets a "stuck"
 * signal.
 *
 * This module:
 *   - Pure predicate isA2ASilent(info, now, thresholdMs) — testable.
 *   - findSilentEntries(a2aState, now, thresholdMs) — scan helper.
 *   - startWatcher({...}) — sets a setInterval that emits a2a_silent
 *     SSE events ONCE per silence period, never repeatedly.
 *
 * Designed to be required by src/dashboard-server.cjs; it consumes the
 * existing a2aState Map without owning it.
 */

const DEFAULT_THRESHOLD_MS = 5 * 60 * 1000;   // 5 min — 1.6× the 3 min contract
const DEFAULT_INTERVAL_MS = 60 * 1000;         // scan once a minute

/**
 * @param {Object} info - a2aState entry: {status, firstSeen, lastSeen,
 *   lastProgressAt?, notified_silent?, ...}
 * @param {number} now - epoch ms
 * @param {number} thresholdMs
 */
function isA2ASilent(info, now, thresholdMs) {
  if (!info || info.status !== 'active') return false;
  const last = info.lastProgressAt || info.lastSeen || info.firstSeen || 0;
  if (last === 0) return false;
  return (now - last) > thresholdMs;
}

/**
 * Iterate a2aState; return entries that are silent AND haven't yet
 * been notified for this silence period. Caller is responsible for
 * setting info.notified_silent=true after broadcasting so we don't
 * spam the same corr every interval.
 */
function findSilentEntries(a2aState, now, thresholdMs = DEFAULT_THRESHOLD_MS) {
  const out = [];
  if (!a2aState) return out;
  for (const info of a2aState.values()) {
    if (!isA2ASilent(info, now, thresholdMs)) continue;
    if (info.notified_silent) continue;
    out.push(info);
  }
  return out;
}

/**
 * Start the periodic watcher. Returns a stop fn.
 *
 * @param {Object} opts
 * @param {Map} opts.a2aState - the existing a2aState Map
 * @param {Function} opts.broadcastSSE - (event) => void
 * @param {number} [opts.intervalMs=60000]
 * @param {number} [opts.thresholdMs=300000]
 * @param {Function} [opts.log] - optional logger
 * @returns {Function} stop function
 */
function startWatcher({ a2aState, broadcastSSE, intervalMs, thresholdMs, log } = {}) {
  if (!a2aState || typeof broadcastSSE !== 'function') {
    throw new Error('a2a-heartbeat.startWatcher: a2aState and broadcastSSE required');
  }
  const interval = intervalMs || DEFAULT_INTERVAL_MS;
  const threshold = thresholdMs || DEFAULT_THRESHOLD_MS;
  const tick = () => {
    const now = Date.now();
    const silent = findSilentEntries(a2aState, now, threshold);
    for (const info of silent) {
      info.notified_silent = true;
      const silentFor = now - (info.lastProgressAt || info.lastSeen || info.firstSeen || now);
      const event = {
        type: 'a2a_silent',
        corr: info.corr,
        from: info.from,
        to: info.to,
        silent_for_ms: silentFor,
        silent_for_min: Math.round(silentFor / 60000),
        status: info.status,
      };
      try { broadcastSSE(event); }
      catch (e) { if (typeof log === 'function') log(`a2a-heartbeat broadcast failed: ${e.message}`); }
    }
  };
  const id = setInterval(tick, interval);
  // unref so the interval doesn't keep the process alive on its own
  if (typeof id.unref === 'function') id.unref();
  return () => clearInterval(id);
}

module.exports = {
  DEFAULT_THRESHOLD_MS,
  DEFAULT_INTERVAL_MS,
  isA2ASilent,
  findSilentEntries,
  startWatcher,
};
