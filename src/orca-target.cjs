'use strict';
/**
 * orca-target.cjs — T-0596 paso 2: ONE shared resolver for "project/lane name ->
 * live Orca terminal handle", used by BOTH a2a_send (mcp-server.cjs) and
 * queue-drain (project-queue.cjs's createConsumer). Before this file the same
 * census+roster+resolveOrca block was inlined once in mcp-server.cjs; paso 2
 * needed it a second time for the drain path and duplicating it would have let
 * the two call sites drift (a common Orca-target bug class this repo already
 * warns about for WezTerm resolution).
 * Key terms: resolveOrcaTarget.
 * Read when: a2a_send or queue-drain need to turn a project/lane name into a
 * live Orca terminal handle (WezTerm already found nothing usable).
 */

/**
 * Resolve `wanted` (a project or lane name) to a live Orca terminal.
 * Returns the SAME shape as pane-identity.cjs's resolveOrca:
 *   { handle, matchedBy, ambiguous, warning }
 * Never throws — a census/roster failure resolves to `{ handle: null, ... }`
 * with a warning, same fail-soft stance as every other Orca primitive here.
 */
async function resolveOrcaTarget(wanted, {
  runOrcaCensus = require('./orca-census.cjs').runCensus,
  loadRoster = require('./lane-roster.cjs').loadRoster,
  mergeLanes = require('./lane-roster.cjs').mergeLanes,
  resolveOrca = require('./pane-identity.cjs').resolveOrca,
} = {}) {
  try {
    const census = await runOrcaCensus();
    if (!census.ok) return { handle: null, matchedBy: null, ambiguous: [], warning: census.reason || 'orca census failed' };
    const roster = loadRoster();
    // Cross-match the roster's (possibly stale/renumbered) handle against the
    // LIVE census, same as bridge_health/lane-roster.cjs, so a lane name
    // resolves even when orchestrators.json's handle is a prefix of the
    // current one.
    const merged = mergeLanes(roster, {
      list: census.terminals.map((t) => ({ handle: t.handle, title: t.title })),
    });
    const laneByHandle = new Map();
    for (const m of merged) {
      if (!m.live || !m.handle) continue;
      const full = census.terminals.find((t) => t.handle === m.handle || t.handle.startsWith(m.handle));
      if (full) laneByHandle.set(full.handle, m.lane);
    }
    const orcaTerminals = census.terminals
      .filter((t) => t.connected)
      .map((t) => ({ handle: t.handle, title: t.title, worktreePath: t.worktreePath, lane: laneByHandle.get(t.handle) || null }));
    return resolveOrca(wanted, orcaTerminals);
  } catch (e) {
    return { handle: null, matchedBy: null, ambiguous: [], warning: `orca-target: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { resolveOrcaTarget };
