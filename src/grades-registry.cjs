'use strict';
/**
 * grades-registry.cjs — In-memory LRU of outcome-grader results, keyed
 * by corr/paneId, with SSE broadcast on each new grade.
 *
 * Used by dashboard-server.cjs to surface scripts/outcome-grader.cjs
 * output (Task #3) to the SSE stream and via GET /api/grades. Forward-
 * compatible with future dashboard badge column once #4 UI lands.
 */

const DEFAULT_MAX = 100;

function _emptyEvent(type, payload) {
  return { type, ...payload };
}

/**
 * @param {Object} [opts]
 * @param {number} [opts.max=100] — LRU cap (oldest entry evicted on insert)
 * @param {Function} [opts.broadcast] — (event) => void; receives
 *   { type:'outcome_grade', key, grade, ts } when a grade is recorded
 */
function createRegistry({ max = DEFAULT_MAX, broadcast } = {}) {
  const map = new Map();

  function record(key, grade) {
    if (!key || !grade || typeof grade !== 'object') return null;
    const k = String(key);
    // Re-insert to push to end (LRU "recently used" semantics)
    if (map.has(k)) map.delete(k);
    const entry = { key: k, grade, ts: new Date().toISOString() };
    map.set(k, entry);
    while (map.size > max) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
    if (typeof broadcast === 'function') {
      try { broadcast(_emptyEvent('outcome_grade', entry)); }
      catch { /* swallow — broadcast failures must not break recording */ }
    }
    return entry;
  }

  function get(key) {
    return map.get(String(key)) || null;
  }

  function list() {
    return Array.from(map.values()).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  function clear() { map.clear(); }
  function size() { return map.size; }

  return { record, get, list, clear, size };
}

module.exports = { createRegistry, DEFAULT_MAX };
