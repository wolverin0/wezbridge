'use strict';
/**
 * lane-roster.cjs — T-0550: cross-match the lane-orchestrator roster
 * (_intel/orchestrators.json) against the Orca census so bridge_health (MCP tool
 * and /api/health) can report which lane orchestrators are actually live.
 * Key terms: loadRoster, mergeLanes, lanes.
 * Read when: bridge_health's `lanes` field is empty, wrong, or a live lane orchestrator
 * shows live:false despite its terminal being up (check the handle/prefix match).
 * Never throws: a missing or unparseable roster degrades to {lanes: [], roster_missing: true}.
 */
const fs = require('node:fs');
const path = require('node:path');

// Same convention as orca-census.cjs (WEZBRIDGE_INTEL_DIR, else Py Apps/_intel).
const DEFAULT_INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');

/**
 * Load _intel/orchestrators.json. Never throws.
 * Returns {lanes: [...], roster_missing: false, fleet} or {lanes: [], roster_missing: true}
 * on a missing file or unparseable JSON.
 */
function loadRoster(intelDir = DEFAULT_INTEL) {
  let raw;
  try { raw = fs.readFileSync(path.join(intelDir, 'orchestrators.json'), 'utf8'); }
  catch { return { lanes: [], roster_missing: true }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { lanes: [], roster_missing: true }; }
  const lanes = (j && Array.isArray(j.lanes)) ? j.lanes : [];
  return { lanes, roster_missing: false, fleet: (j && j.fleet) || null };
}

/**
 * Cross-match roster lanes against a census (the `orca` health block — an object
 * carrying `.list` of {handle, title, ...}, as returned by orca-census.cjs's
 * healthBlock()/readPersistedCensus()). A lane's `handle` matches a census entry
 * on an exact match OR when the lane's handle is a PREFIX of the census handle
 * (roster entries are sometimes recorded with a short id before the full one is
 * known — e.g. roster "term_db1a50e0" matches census "term_db1a50e0-9530-...").
 * census with no usable `.list` (Orca disabled/unavailable/unknown) => live: null
 * for every lane — "we don't know", never a false "not live".
 */
function mergeLanes(roster, census) {
  const lanes = (roster && Array.isArray(roster.lanes)) ? roster.lanes : [];
  const list = (census && Array.isArray(census.list)) ? census.list : null;
  return lanes.map((l) => {
    const handle = l.handle || null;
    let live = null;
    let title = null;
    if (list) {
      live = false;
      if (handle) {
        const hit = list.find((t) => t && t.handle
          && (t.handle === handle || t.handle.startsWith(handle)));
        if (hit) { live = true; title = hit.title || null; }
      }
    }
    return {
      lane: l.lane || null,
      handle,
      model: l.model || null,
      effort: l.effort || null,
      state: l.state || null,
      live,
      title,
    };
  });
}

module.exports = { loadRoster, mergeLanes, DEFAULT_INTEL };
