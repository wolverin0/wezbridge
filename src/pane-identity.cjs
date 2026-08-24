'use strict';
/**
 * pane-identity.cjs — resolve a PROJECT to a live pane, durably.
 *
 * The problem, stated precisely after measuring it on 2026-07-29 rather than
 * repeating folklore:
 *
 *   - `pane_id` is monotonic and NEVER reused within a WezTerm process. Observed
 *     ids 0,2..6,9..15,28,29,37,38,43 — every closed pane left a permanent hole.
 *     A stale id therefore points at a DEAD pane and fails loudly ("no such
 *     pane"); it does not silently reach someone else. This is the opposite of
 *     the "ids renumber on close" belief that was written into several docs.
 *   - `pane_id` DOES reset to 0 when WezTerm itself restarts, and panes are then
 *     respawned in a different order. That is the real hazard: across a restart a
 *     stored id can point at a different project's pane. It is how the marketing
 *     session moved 4 -> 3 while another project took 4.
 *   - The displayed tab INDEX is positional and shifts as tabs close, so it is
 *     worse than the id, not better.
 *
 * So neither number is an identity. The two durable keys are:
 *
 *   cwd       — machine truth, and the canonical project name (its folder).
 *   tab_title — the operator's own label, set by hand and meaningful to them.
 *
 * They are not required to be equal. Pane 15 is titled "futuraCRM" while its cwd
 * is "argentina-sales-hub": that is an ALIAS, not an error, and a resolver that
 * treats it as a conflict would be wrong about the one case it most needs to get
 * right. Aliases are declared in Py Apps/fleet/<project>.md frontmatter.
 */

/** cwd arrives as a file:// URL, percent-encoded, sometimes with a trailing slash. */
function projectFromCwd(cwd) {
  if (!cwd) return null;
  let s = String(cwd);
  try { s = decodeURIComponent(s); } catch { /* leave as-is if malformed */ }
  s = s.replace(/^file:\/\/\/?/, '').replace(/[/\\]+$/, '');
  const parts = s.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Describe one pane's identity.
 * `canonical` is always the cwd folder when we have one — the machine's answer,
 * which survives the operator renaming a tab and survives a WezTerm restart.
 */
function identify(pane, aliasMap = new Map()) {
  const fromCwd = projectFromCwd(pane.cwd);
  const label = pane.tab_title || null;
  const labelCanonical = label ? (aliasMap.get(norm(label)) || null) : null;
  return {
    paneId: pane.pane_id,
    canonical: fromCwd || labelCanonical || null,
    label,
    cwdProject: fromCwd,
    // A label that resolves to a DIFFERENT project than the cwd is worth
    // surfacing: it means the pane is labelled as one project while working in
    // another — either a borrowed pane, or a tab someone forgot to relabel.
    labelConflict: Boolean(fromCwd && labelCanonical && labelCanonical !== fromCwd),
  };
}

/**
 * Build alias -> canonical from fleet briefs.
 * A project always aliases to itself so a bare folder name resolves.
 */
function buildAliasMap(briefs) {
  const m = new Map();
  for (const b of briefs) {
    if (!b || !b.project) continue;
    m.set(norm(b.project), b.project);
    const aliases = Array.isArray(b.aliases) ? b.aliases : (b.aliases ? [b.aliases] : []);
    for (const a of aliases) m.set(norm(a), b.project);
  }
  return m;
}

/**
 * Resolve a project name (canonical OR alias OR tab label) to a live pane.
 *
 * Returns { paneId, matchedBy, ambiguous, warning }. `paneId` is null when the
 * project has no live pane — spawn one in its cwd rather than borrowing another.
 * Never cache the result beyond the current session, and re-resolve on
 * "no such pane" or after any WezTerm restart.
 */
function resolve(wanted, panes, aliasMap = new Map()) {
  const target = aliasMap.get(norm(wanted)) || wanted;
  const ids = panes.map((p) => identify(p, aliasMap));

  const byCwd = ids.filter((i) => i.cwdProject && norm(i.cwdProject) === norm(target));
  const byLabel = ids.filter((i) => i.label
    && (norm(i.label) === norm(target) || aliasMap.get(norm(i.label)) === target));

  // cwd wins over label: the folder is where work actually lands, and a tab can
  // be mislabelled or left over from a previous occupant.
  const hits = byCwd.length ? byCwd : byLabel;
  if (!hits.length) return { paneId: null, matchedBy: null, ambiguous: [], warning: `no live pane for "${wanted}"` };

  const conflicted = hits.find((h) => h.labelConflict);
  return {
    paneId: hits[0].paneId,
    matchedBy: byCwd.length ? 'cwd' : 'tab_title',
    ambiguous: hits.length > 1 ? hits.map((h) => h.paneId) : [],
    warning: hits.length > 1
      ? `${hits.length} panes match "${wanted}" (${hits.map((h) => h.paneId).join(', ')}) — disambiguate before sending`
      : (conflicted ? `pane ${conflicted.paneId} is labelled "${conflicted.label}" but works in "${conflicted.cwdProject}"` : null),
  };
}

/**
 * T-0235: resolve the SENDER's own pane at send time. WEZTERM_PANE is stamped
 * into the MCP server's env at spawn and never updates — after a WezTerm
 * restart it points at a dead or foreign pane (pane-0 signed as 6, 1 and 2
 * within one hour on 2026-08-23, and infra signed as an id the census had
 * reassigned). The durable self-identity is the process cwd's PROJECT; the env
 * id is transport, trusted only when the census confirms it still means us.
 *
 * Returns { paneId, source, project, warning }:
 *   'explicit'      — caller passed from_pane; trusted verbatim (documented
 *                     workaround for external/headless senders).
 *   'env-verified'  — env id is live AND its cwd project matches ours.
 *   'env-corrected' — env id dead/foreign; census has exactly one live pane
 *                     for our project — that one is us.
 *   'unresolved'    — nothing provable: keeps env as last resort (with the
 *                     warning) or null when there is no env at all.
 */
function resolveSelfPane({ explicitPane, envPane, cwd, panes, aliasMap = new Map() }) {
  const project = projectFromCwd(cwd);
  if (Number.isInteger(explicitPane)) {
    return { paneId: explicitPane, source: 'explicit', project, warning: null };
  }
  const ids = (panes || []).map((p) => identify(p, aliasMap));
  const env = Number.isInteger(envPane) ? ids.find((i) => i.paneId === envPane) : null;
  if (env && project && env.cwdProject && norm(env.cwdProject) === norm(project)) {
    return { paneId: envPane, source: 'env-verified', project, warning: null };
  }
  // Correction requires an env id to correct: a sender with NO WEZTERM_PANE at
  // all is a headless/external process, and resolving it to the project's live
  // pane would let it SIGN AS that session — the phantom-driver problem
  // (mm-376c/mm-6e6c) in reverse. Headless senders must pass from_pane
  // explicitly; only a stale-but-present env gets census-corrected.
  const mine = (Number.isInteger(envPane) && project)
    ? ids.filter((i) => i.cwdProject && norm(i.cwdProject) === norm(project)) : [];
  if (mine.length === 1) {
    return {
      paneId: mine[0].paneId,
      source: 'env-corrected',
      project,
      warning: `WEZTERM_PANE=${envPane} is stale (dead or foreign pane) — census resolves this session to pane ${mine[0].paneId}`,
    };
  }
  return {
    paneId: Number.isInteger(envPane) ? envPane : null,
    source: 'unresolved',
    project,
    warning: mine.length > 1
      ? `${mine.length} live panes share project "${project}" (${mine.map((i) => i.paneId).join(', ')}) — pass from_pane explicitly`
      : `cannot prove own pane (no census match for project "${project}")`,
  };
}

module.exports = { projectFromCwd, identify, buildAliasMap, resolve, resolveSelfPane };
