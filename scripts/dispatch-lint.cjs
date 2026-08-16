#!/usr/bin/env node
'use strict';
/**
 * dispatch-lint.cjs — two lints from the 2026-08-16 workflow-hardening retro.
 *
 * W1 `dispatch-unspecced`: dispatch quality is a single point of failure. The
 * kitchen UI v1 was rejected ("threw everything on one screen") because the
 * dispatch specced DATA, not design. Any open UI/service task must reference a
 * spec or a template from _intel/templates/ in its context_refs, or the steward
 * flags it before a builder burns a session on an unspecced build.
 *
 * W2 `ruling-unlanded`: decisions trapped in corr threads. The 120s/1800s
 * near-miss: a ruling changed an operational threshold, the value lived only in
 * the ruling's prose, and a pane later "fixed" the config from the stale value
 * it could see. A ruling that changes an operational value must name the FILE
 * where the value now lives (`value_landed_in`), because a value that lives in
 * prose is invisible to every process that reads files.
 *
 * ANTI-WOLF, both lints:
 *  - Epoch-gated: only tasks created / rulings made after the lint shipped are
 *    linted. Retro-flagging the whole backlog on day one would open with a
 *    hundred findings about work already ruled on, and train everyone to
 *    ignore the two categories on their first day of existence.
 *  - Conservative matches: word-boundary patterns chosen to under-fire. An
 *    enforcement artifact that fires on compliant behaviour is worse than none.
 *  - Self-clearing (W2): only the LATEST ruling per task is linted, so
 *    appending a corrected ruling that carries `value_landed_in` clears the
 *    finding without a separate ruling on the finding itself.
 */

/** Only work born after the lints exist is linted. */
const LINT_EPOCH_MS = Date.parse('2026-08-16T00:00:00Z');

/** Task kinds/titles that mean "this ships an interface". */
const UI_RE = /\b(ui|ux|frontend|front-end|dashboard|cockpit|pwa|landing page|design-gate|web app)\b/i;
/** Task kinds/titles that mean "this ships a long-running process". */
const SERVICE_RE = /\b(daemon|watcher|scheduler|streamer|long-running|pilot chain|service)\b/i;
/** A context_refs entry that counts as a spec reference. */
const SPEC_REF_RE = /(spec|template)/i;

/** Ruling prose that smells like an operational value change. */
const VALUE_CHANGE_RE = /\b(threshold|umbral|cadence|interval|timeout|retention|enabled?|disabled?|set to)\b/i;
/** A file-path-looking token inside `why` also counts as landing the value. */
const PATH_IN_WHY_RE = /[\w.-]+\.(env|json|jsonl|md|cjs|mjs|js|yml|yaml|toml|txt|ps1|cmd|cfg|ini)\b/i;

const OPEN_STATES = new Set(['queued', 'ready', 'running']);

const hoursSince = (ms, now) => Math.round((now - ms) / 3600000);

/**
 * W1. One finding per open, post-epoch UI/service task with no spec reference.
 * Age counts from CREATION — the defect is present from birth, not from the
 * last touch, and an age that reset on every lease renewal would never expire.
 */
function lintSpecRefs(tasks, now) {
  const out = [];
  for (const t of tasks) {
    if (!OPEN_STATES.has(t.state)) continue;
    const created = Date.parse(t.created_at || '');
    if (!Number.isFinite(created) || created < LINT_EPOCH_MS) continue;
    const surface = `${t.kind || ''} ${t.title || ''}`;
    if (!UI_RE.test(surface) && !SERVICE_RE.test(surface)) continue;
    const refs = Array.isArray(t.context_refs) ? t.context_refs : [];
    if (refs.some((r) => SPEC_REF_RE.test(String(r)))) continue;
    out.push({
      id: t.id,
      repo: t.repo,
      state: t.state,
      owner: (t.lease && t.lease.owner) || null,
      title: t.title,
      age_hours: hoursSince(created, now),
      category: 'dispatch-unspecced',
      why: 'UI/service work with no spec or template in context_refs — dispatch quality is a single point of failure (kitchen v1). Reference a spec file or _intel/templates/*.md before a builder starts.',
    });
  }
  return out;
}

/**
 * W2. One finding per task whose LATEST post-epoch ruling reads like a value
 * change but names no file — neither a `value_landed_in` field nor a
 * path-looking token in `why`.
 */
function lintRulings(rulings, now) {
  const latest = new Map();
  for (const r of rulings) {
    if (!r || !r.task) continue;
    const at = Date.parse(r.at || '');
    if (!Number.isFinite(at) || at < LINT_EPOCH_MS) continue;
    const prev = latest.get(r.task);
    if (!prev || at >= prev.at_ms) latest.set(r.task, { ...r, at_ms: at });
  }
  const out = [];
  for (const r of latest.values()) {
    const why = String(r.why || '');
    if (!VALUE_CHANGE_RE.test(why)) continue;
    if (r.value_landed_in) continue;
    if (PATH_IN_WHY_RE.test(why)) continue;
    out.push({
      id: `RL-unlanded-${r.task}`,
      repo: '_fleet',
      state: 'ruling',
      owner: null,
      title: `ruling on ${r.task} changes a value but names no file`,
      age_hours: hoursSince(r.at_ms, now),
      category: 'ruling-unlanded',
      why: `the latest ruling on ${r.task} reads like an operational value change but carries no value_landed_in and no file path — a value that lives only in ruling prose caused the 120s/1800s near-miss. Append a corrected ruling naming the file that now carries the value.`,
    });
  }
  return out;
}

module.exports = { lintSpecRefs, lintRulings, LINT_EPOCH_MS, UI_RE, SERVICE_RE, SPEC_REF_RE, VALUE_CHANGE_RE };
