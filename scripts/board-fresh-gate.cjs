#!/usr/bin/env node
'use strict';
/**
 * board-fresh-gate.cjs — kills "¿está actualizado?" by making the answer a
 * CHECK THAT CAN FAIL. Work evidence (a head_moved beacon, or a deploy-class
 * marker git corroborates) older than FRESH_HOURS in a repo whose open tasks
 * nobody touched since is RED: work landed and the ledger never heard.
 *
 * Shape copied from waker-gate/steward-gate on purpose: pure evaluate() core,
 * thin IO shell, no model in the path, silent-green on compliant state.
 *
 * What counts as evidence (and what does not):
 *   - head_moved beacon lines — git ground truth, prose cannot fake it.
 *   - deploy-class markers (DEPLOY/MERGED/PUSHED/PR #n) ONLY when the beacon
 *     flagged them neither prose-only nor unsupported-by-vcs. Talking about a
 *     deploy is not a deploy — six dead surfaces died of exactly that noise.
 *   - NO evidence = GREEN. A repo where nothing happened is compliant.
 *
 * What clears a stale repo: any open task's updated_at/state_changed_at at or
 * after the evidence time, or any task.* ledger event for that repo since it.
 * That is the exact behaviour this gate exists to train.
 *
 * Exit codes:  0 GREEN · 1 RED · 3 UNKNOWN (inputs unreadable — NEVER green)
 */
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(HERE, '..', '..', '_intel');

/** Generous on purpose: a noisy gate teaches everyone to ignore it. */
const FRESH_HOURS = Number(process.env.BOARD_FRESH_GATE_HOURS || 4);

/** Same closed list the board uses; a task in any other state needs no touch. */
const OPEN_STATES = ['ready', 'queued', 'running', 'review', 'blocked', 'failed'];

/** Mirrors pane-beacon.cjs DEPLOY_CLASS: markers that assert something LANDED. */
const DEPLOY_CLASS = /^(DEPLOY|DEPLOYED|MERGED|PUSHED|PR #\d+)$/i;

// ---------------------------------------------------------------------------
// PURE CORE — no clock, no filesystem.
// ---------------------------------------------------------------------------

/** Is this beacon line real-work evidence? Returns {at, sha, kind} or null. */
function evidenceOfLine(line) {
  if (!line || line.event !== 'turn-end' || !line.repo) return null;
  const at = Date.parse(line.time || '');
  if (!Number.isFinite(at)) return null;
  if (line.head_moved === true) return { at, sha: line.head || null, kind: 'head_moved' };
  const markers = Array.isArray(line.markers) ? line.markers : [];
  if (!markers.some((m) => DEPLOY_CLASS.test(m))) return null;
  // Prose-only or git-contradicted deploy claims are NOT evidence. The beacon
  // never drops them (a filter that eats a real deploy tells nobody); the
  // judgement about trusting them lives here, in the consumer.
  if (line.markers_prose_only === true || line.markers_unsupported_by_vcs === true) return null;
  return { at, sha: null, kind: 'deploy-marker' };
}

/** Latest evidence per repo — a newer commit restarts the repo's clock. */
function latestEvidence(paneEvents) {
  const byRepo = new Map();
  for (const line of paneEvents) {
    const ev = evidenceOfLine(line);
    if (!ev) continue;
    const prev = byRepo.get(line.repo);
    if (!prev || ev.at > prev.at) byRepo.set(line.repo, ev);
  }
  return byRepo;
}

function touchedSince(task, atMs) {
  for (const field of ['updated_at', 'state_changed_at']) {
    const t = Date.parse(task[field] || '');
    if (Number.isFinite(t) && t >= atMs) return true;
  }
  return false;
}

/**
 * RED iff some repo has evidence older than freshHours, open tasks, and no
 * task touch nor task.* ledger event for that repo since the evidence.
 */
function evaluate({ paneEvents, tasks, ledgerEvents, now, freshHours = FRESH_HOURS }) {
  const stale = [];
  for (const [repo, ev] of latestEvidence(paneEvents)) {
    if (now - ev.at <= freshHours * 3600000) continue;      // grace: update may still be coming
    const repoTasks = tasks.filter((t) => t && t.repo === repo);
    const open = repoTasks.filter((t) => OPEN_STATES.includes(t.state));
    if (open.length === 0) continue;                        // nothing to update
    if (open.some((t) => touchedSince(t, ev.at))) continue;

    // task.updated/leased events carry no repo field — membership of the
    // task_id in this repo's ledger resolves them.
    const repoIds = new Set(repoTasks.map((t) => t.id));
    const ledgerTouched = (ledgerEvents || []).some((e) => {
      if (!e || typeof e.event !== 'string' || !e.event.startsWith('task.')) return false;
      const t = Date.parse(e.time || '');
      if (!Number.isFinite(t) || t < ev.at) return false;
      return e.repo === repo || (e.task_id && repoIds.has(e.task_id));
    });
    if (ledgerTouched) continue;

    stale.push({
      repo,
      sha: ev.sha,
      evidence_kind: ev.kind,
      evidence_at: new Date(ev.at).toISOString(),
      age_hours: Math.round((now - ev.at) / 3600000),
      open_tasks: open.map((t) => t.id).slice(0, 10),
    });
  }
  return { stale, verdict: stale.length ? 'RED' : 'GREEN' };
}

// ---------------------------------------------------------------------------
// IO shell (also imported by board-app/server.cjs for the freshness pill)
// ---------------------------------------------------------------------------

/** null on unreadable — [] would silently turn "cannot see" into "all clear". */
function readJsonlOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return null; }
}

/**
 * Evaluate straight from an _intel dir. pane-events.jsonl unreadable is
 * UNKNOWN — the beacon stream is the gate's eyes and a blind gate must say so.
 * events.jsonl absent is zero ledger events: that can only make the verdict
 * redder, never falsely green, so it does not blind the gate.
 */
function evaluateIntel({ intelDir = INTEL, tasks, now = Date.now(), freshHours = FRESH_HOURS }) {
  const paneEvents = readJsonlOrNull(path.join(intelDir, 'pane-events.jsonl'));
  if (paneEvents === null) {
    return { verdict: 'UNKNOWN', stale: [], reason: 'pane-events.jsonl unreadable' };
  }
  const ledgerEvents = readJsonlOrNull(path.join(intelDir, 'events.jsonl')) || [];
  return evaluate({ paneEvents, tasks, ledgerEvents, now, freshHours });
}

function main() {
  let tasks;
  try {
    tasks = require(path.join(HERE, 'fleet-steward.cjs')).loadTasks();
  } catch (e) {
    console.log(`board-fresh-gate: UNKNOWN — could not load tasks (${String(e.message).split('\n')[0]}). Refusing to report GREEN on missing inputs.`);
    process.exit(3);
  }

  const out = evaluateIntel({ tasks });
  if (out.verdict === 'UNKNOWN') {
    console.log(`board-fresh-gate: UNKNOWN — ${out.reason}. A blind gate is not a clean one.`);
    process.exit(3);
  }
  if (out.verdict === 'GREEN') {
    console.log(`board-fresh-gate: GREEN — every repo with work evidence >${FRESH_HOURS}h old has its ledger touched since.`);
    process.exit(0);
  }
  console.log(`board-fresh-gate: RED — ${out.stale.length} repo(s) have work evidence with NO task update since:`);
  for (const s of out.stale) {
    console.log(`  ${s.repo}  ${s.evidence_kind}${s.sha ? ` ${s.sha}` : ''}  ${s.age_hours}h ago  open+untouched: ${s.open_tasks.join(', ')}`);
  }
  console.log('Work landed and the ledger never heard. Update the task (or append a task.* event) so the board answers "está actualizado" instead of you.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { evaluate, evaluateIntel, latestEvidence, evidenceOfLine, FRESH_HOURS, OPEN_STATES };
