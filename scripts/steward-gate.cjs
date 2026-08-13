#!/usr/bin/env node
'use strict';
/**
 * steward-gate.cjs — turns the steward's REPORT into a CHECK THAT CAN FAIL.
 *
 * Why this exists: fleet-steward.cjs already finds forgotten work and has done
 * so correctly since 2026-07-29. It changes nothing, because a report can be
 * read and narrated. On 2026-08-12 the ledger held 26 ready tasks untouched for
 * ~10 days while the orchestrator pane said "nothing needs you" — a claim
 * nothing in the system could contradict.
 *
 * This is the contradiction. A finding older than its deadline must carry a
 * RULING or this exits non-zero. Narration cannot clear it; only a line in
 * _intel/rulings.jsonl can.
 *
 *   dispatched     — sent to an owner pane (re-raises if still idle later)
 *   cancelled      — the work is dead (permanent)
 *   operator-gated — waiting on the operator BY DESIGN (permanent)
 *   deferred       — parked on purpose, REQUIRES `until` (re-raises after)
 *
 * Deliberately NOT here: closing tasks, editing the ledger, deciding which
 * projects matter. The steward refuses to auto-close for good reason — silent
 * auto-close is how real work disappears. This only refuses to let it be
 * ignored quietly.
 *
 * Exit codes:  0 GREEN (every past-deadline finding is ruled)
 *              1 RED   (at least one is not)
 *              3 UNKNOWN (could not read the inputs — NEVER reported as 0)
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(HERE, '..', '..', '_intel');
const RULINGS = path.join(INTEL, 'rulings.jsonl');

/**
 * Hours a finding may sit before it MUST be ruled on. Generous on purpose: a
 * noisy gate gets ignored, and an enforcement artifact that fires on compliant
 * behaviour is worse than none.
 */
const DEADLINES = {
  'abandoned-lease': 6,
  'blocked-not-gated': 48,
  'stale-running': 24,
  'stale-review': 72,
  'stale-failed': 48,
  'awaiting-operator': Infinity,   // waiting on the operator IS the correct state
  idle: 72,
};

/** A ruling stops covering a finding once this passes (dispatched only). */
const DISPATCH_GRACE_HOURS = 24;

// ---------------------------------------------------------------------------
// PURE CORE — no clock, no filesystem. Everything below is unit-testable.
// ---------------------------------------------------------------------------

/**
 * Does `ruling` still cover `finding` at time `now`?
 *
 * Category is part of the match ON PURPOSE: a task deferred while merely idle
 * must NOT stay silent once it becomes abandoned-lease or stale-failed. The
 * situation changed, so the judgement has to be made again.
 */
function rulingCovers(ruling, finding, now) {
  if (!ruling || ruling.task !== finding.id) return false;
  if (ruling.category && ruling.category !== finding.category) return false;

  switch (ruling.ruling) {
    case 'cancelled':
    case 'operator-gated':
      return true;                                   // permanent by design
    case 'deferred': {
      if (!ruling.until) return false;               // a deferral with no end is a shrug
      const until = Date.parse(ruling.until);
      return Number.isFinite(until) && now < until;
    }
    case 'dispatched': {
      const at = Date.parse(ruling.at || '');
      if (!Number.isFinite(at)) return false;
      return (now - at) < DISPATCH_GRACE_HOURS * 3600000;
    }
    default:
      return false;                                  // unknown ruling word = no cover
  }
}

/** Latest ruling wins, so a decision can be revised by appending. */
function evaluate({ findings, rulings, now, deadlines = DEADLINES }) {
  const unruled = [];
  const covered = [];
  for (const f of findings) {
    const limit = deadlines[f.category];
    if (limit === undefined || !Number.isFinite(limit)) continue;   // not gated
    if (f.age_hours < limit) continue;                              // not yet due

    const applicable = rulings.filter((r) => r && r.task === f.id);
    const hit = [...applicable].reverse().find((r) => rulingCovers(r, f, now));
    (hit ? covered : unruled).push(hit ? { finding: f, ruling: hit } : f);
  }
  return { unruled, covered, verdict: unruled.length ? 'RED' : 'GREEN' };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

function readRulings(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }        // absent file is legitimately zero rulings
}

function loadFindings() {
  const from = process.argv.indexOf('--from');
  if (from > -1) return JSON.parse(fs.readFileSync(process.argv[from + 1], 'utf8'));
  // No --from: run the steward ourselves. If it cannot run we must say UNKNOWN,
  // never "0 findings" — a scan that did not happen is not a clean scan.
  const out = execFileSync(process.execPath, [path.join(HERE, 'fleet-steward.cjs'), '--json'],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function main() {
  let report;
  try {
    report = loadFindings();
    if (!report || !Array.isArray(report.findings)) throw new Error('no findings array');
  } catch (e) {
    console.log(`steward-gate UNKNOWN: could not obtain findings — ${String(e.message).split('\n')[0]}`);
    process.exit(3);
  }

  const now = Date.now();
  const rulings = readRulings(RULINGS);
  const { unruled, covered, verdict } = evaluate({ findings: report.findings, rulings, now });

  if (verdict === 'GREEN') {
    console.log(`steward-gate GREEN: ${report.findings.length} findings, ${covered.length} past deadline and all ruled.`);
    process.exit(0);
  }
  console.log(`steward-gate RED: ${unruled.length} finding(s) past deadline with NO ruling.`);
  for (const f of unruled.slice(0, 15)) {
    console.log(`  ${f.id} | ${f.repo} | ${f.category} | ${f.age_hours}h | ${String(f.title || '').slice(0, 46)}`);
  }
  if (unruled.length > 15) console.log(`  ... and ${unruled.length - 15} more`);
  console.log(`Rule on each by appending to ${RULINGS}: {"task":"<id>","category":"<category>","ruling":"cancelled|dispatched|deferred|operator-gated","why":"...","at":"<iso>"}`);
  process.exit(1);
}

if (require.main === module) main();
module.exports = { evaluate, rulingCovers, DEADLINES, DISPATCH_GRACE_HOURS };
