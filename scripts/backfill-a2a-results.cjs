'use strict';
/**
 * backfill-a2a-results.cjs — T-0350 AC6a: append MISSING type=result queue
 * entries into _intel/a2a-results.jsonl. "Missing" = AC1's definition — a
 * type=result line in _intel/queues/*.jsonl whose corr has NO line at all in
 * a2a-results.jsonl (delivery failed before recordResultOnce existed, or the
 * entry pre-dates this fix and was never recorded by any path).
 *
 * --dry-run is the DEFAULT: nothing is written unless --live is passed
 * explicitly. NEVER rewrites, truncates or deletes an existing line — data
 * deletion is an operator gate (T-0350 constraint). Idempotent by id: a
 * second run over the same intel dir finds nothing left to backfill once the
 * first run's lines are in a2a-results.jsonl.
 *
 * Usage:
 *   node scripts/backfill-a2a-results.cjs [intelDir] [--dry-run|--live]
 *   node scripts/backfill-a2a-results.cjs                       # dry-run, live _intel
 *   node scripts/backfill-a2a-results.cjs --live                # APPEND, live _intel
 *   node scripts/backfill-a2a-results.cjs /path/to/_intel --live
 */
const fs = require('fs');
const path = require('path');
const { detectV2, detectAbandons, detectDecisions, detectEvidence } = require('../src/a2a-intel.cjs');

const RESULT_BODY_CAP = 16 * 1024;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * Find type=result queue entries whose corr has no line in a2a-results.jsonl.
 * Read-only. Returns { missing, resultsFile }.
 */
function findMissing(intelDir) {
  const resultsFile = path.join(intelDir, 'a2a-results.jsonl');
  const resultsLines = readJsonl(resultsFile);
  const corrsRecorded = new Set(resultsLines.map((r) => r.corr));
  const idsRecorded = new Set(resultsLines.filter((r) => r.id).map((r) => r.id));

  const qDir = path.join(intelDir, 'queues');
  let files = [];
  try { files = fs.readdirSync(qDir).filter((f) => f.endsWith('.jsonl')); } catch { return { missing: [], resultsFile }; }

  const seenIds = new Set();
  const missing = [];
  for (const f of files) {
    for (const e of readJsonl(path.join(qDir, f))) {
      if (e.type !== 'result' || !e.id || seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      if (idsRecorded.has(e.id) || corrsRecorded.has(e.corr)) continue;
      missing.push({
        file: f, id: e.id, corr: e.corr, from_pane: e.from_pane,
        resolved_pane: e.resolved_pane ?? null, body: e.body, time: e.time,
      });
    }
  }
  return { missing, resultsFile };
}

/** Append one backfilled line. Marked `backfilled:true` — this is recovered
 * evidence, not a fresh delivery, and that distinction must survive. */
function appendBackfillLine(resultsFile, entry) {
  const text = String(entry.body ?? '');
  const truncated = text.length > RESULT_BODY_CAP;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    event: 'a2a.result',
    id: entry.id,
    corr: entry.corr,
    from_pane: entry.from_pane,
    to_pane: entry.resolved_pane ?? null,
    v2: detectV2(text),
    abandons: detectAbandons(text).count,
    decisions: detectDecisions(text),
    evidence: detectEvidence(text),
    body: truncated ? text.slice(0, RESULT_BODY_CAP) : text,
    body_truncated: truncated,
    backfilled: true,
    backfill_source_time: entry.time || null,
    backfill_source_file: `queues/${entry.file}`,
  });
  fs.appendFileSync(resultsFile, line + '\n');
}

function main(argv) {
  const args = argv.slice(2);
  const live = args.includes('--live');
  const intelDir = args.find((a) => !a.startsWith('--'))
    || process.env.WEZBRIDGE_INTEL_DIR
    || path.join(__dirname, '..', '..', '_intel');
  const { missing, resultsFile } = findMissing(intelDir);
  if (!missing.length) {
    console.log(`backfill: 0 missing type=result entries found in ${intelDir} — nothing to do.`);
    return { appended: 0, missing: [] };
  }
  console.log(`backfill: ${missing.length} missing type=result entr${missing.length === 1 ? 'y' : 'ies'} found in ${intelDir}`);
  for (const m of missing) console.log(`  [${live ? 'APPEND' : 'DRY-RUN'}] id=${m.id} corr=${m.corr} queue=${m.file}`);
  if (!live) {
    console.log(`\nDry-run only — nothing written. Re-run with --live to APPEND these ${missing.length} line(s) to ${resultsFile}.`);
    return { appended: 0, missing };
  }
  for (const m of missing) appendBackfillLine(resultsFile, m);
  console.log(`backfill: appended ${missing.length} line(s) to ${resultsFile}`);
  return { appended: missing.length, missing };
}

if (require.main === module) main(process.argv);
module.exports = { findMissing, appendBackfillLine, main };
