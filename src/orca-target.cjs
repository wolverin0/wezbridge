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
/** Shared census+roster merge — the lane-tagged terminal list both resolveOrcaTarget
 * (name -> handle) and resolveOrcaSender (handle -> name) work from, so the two
 * directions can never drift on what "lane" means for a given handle. */
async function liveOrcaTerminals({
  runOrcaCensus = require('./orca-census.cjs').runCensus,
  loadRoster = require('./lane-roster.cjs').loadRoster,
  mergeLanes = require('./lane-roster.cjs').mergeLanes,
} = {}) {
  const census = await runOrcaCensus();
  if (!census.ok) return { ok: false, warning: census.reason || 'orca census failed', terminals: [] };
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
  const terminals = census.terminals
    .filter((t) => t.connected)
    .map((t) => ({ handle: t.handle, title: t.title, worktreePath: t.worktreePath, lane: laneByHandle.get(t.handle) || null }));
  return { ok: true, warning: null, terminals };
}

async function resolveOrcaTarget(wanted, {
  runOrcaCensus, loadRoster, mergeLanes,
  resolveOrca = require('./pane-identity.cjs').resolveOrca,
} = {}) {
  try {
    const live = await liveOrcaTerminals({ runOrcaCensus, loadRoster, mergeLanes });
    if (!live.ok) return { handle: null, matchedBy: null, ambiguous: [], warning: live.warning };
    return resolveOrca(wanted, live.terminals);
  } catch (e) {
    return { handle: null, matchedBy: null, ambiguous: [], warning: `orca-target: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * T-0600: the REVERSE of resolveOrcaTarget — resolve THIS process's own
 * sender identity from `handle` (process.env.ORCA_TERMINAL_HANDLE, stamped
 * by Orca into every terminal's env at spawn — the only durable self-identity
 * Orca offers, same fact orca-target.cjs's self-send guard already relies on).
 * Lets an Orca-hosted headless sender (the Fleet, with no WezTerm pane at
 * all) call a2a_send / bin/a2a-send-cli.cjs without --from-pane: it can still
 * PROVE which lane/project it is, via the SAME census+roster merge
 * resolveOrcaTarget uses, so the two directions never drift.
 *
 * Returns { project, matchedBy: 'lane'|'cwd'|'title'|null, warning }.
 * `project` is null when the handle has no live terminal (stale/dead) or that
 * terminal has no resolvable lane/cwd/title — never guessed, never defaulted.
 *
 * SECURITY NOTE: this resolves WHO is sending, nothing more. It grants no
 * dispatch authority — a2a_send's existing dispatch gate / decision-authority
 * checks (checkDispatchGate, decisionDisposition against rulings.jsonl) run
 * unchanged AFTER this, keyed on the envelope's corr/ruling, not on sender
 * identity. A resolved from_project here is exactly as authoritative as an
 * explicit --from-project always was — it does not widen what the sender is
 * allowed to dispatch.
 */
async function resolveOrcaSender(handle, {
  runOrcaCensus, loadRoster, mergeLanes,
  projectFromCwd = require('./pane-identity.cjs').projectFromCwd,
} = {}) {
  if (!handle) return { project: null, matchedBy: null, warning: 'no ORCA_TERMINAL_HANDLE given' };
  try {
    const live = await liveOrcaTerminals({ runOrcaCensus, loadRoster, mergeLanes });
    if (!live.ok) return { project: null, matchedBy: null, warning: live.warning };
    const term = live.terminals.find((t) => t.handle === handle);
    if (!term) return { project: null, matchedBy: null, warning: `no live orca terminal found for handle "${handle}"` };
    if (term.lane) return { project: term.lane, matchedBy: 'lane', warning: null };
    const cwdProject = projectFromCwd(term.worktreePath);
    if (cwdProject) return { project: cwdProject, matchedBy: 'cwd', warning: null };
    if (term.title) return { project: term.title, matchedBy: 'title', warning: null };
    return { project: null, matchedBy: null, warning: `terminal ${handle} has no resolvable lane, worktree cwd or title` };
  } catch (e) {
    return { project: null, matchedBy: null, warning: `orca-target: ${e && e.message ? e.message : String(e)}` };
  }
}

module.exports = { resolveOrcaTarget, resolveOrcaSender, liveOrcaTerminals };
