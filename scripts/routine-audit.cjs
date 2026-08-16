#!/usr/bin/env node
'use strict';
/**
 * routine-audit.cjs — gives scheduled ROUTINES a consumer.
 *
 * Why this exists: on 2026-08-14 the routine runner was scheduled and the
 * routine prompt ended with "findings become ledger tasks" — but nothing read
 * `_intel/routine-findings/`. A routine whose output nobody consumes is a
 * routine that runs to write a file into a folder no process opens. That is the
 * same shape as the report nobody acts on, one layer down.
 *
 * This turns a routine's output into steward FINDINGS, so the existing gate
 * refuses to let them be ignored. It deliberately does NOT create ledger tasks:
 * a routine is a model, and auto-creating work from model output would let one
 * bad run manufacture forty tasks. The orchestrator converts the real ones by
 * hand; this only makes ignoring them impossible.
 *
 * The defect family this repo keeps re-finding is a check whose visibility is
 * narrower than its subject reporting CLEAN instead of "I cannot see". Applied
 * here, FIVE separate ways, every one of which used to read as silence:
 *
 *   runner exited non-zero      -> void, not clean
 *   no findings artifact at all -> void, not clean
 *   artifact says verdict void  -> void (the routine said so itself)
 *   verdict word unrecognised   -> void, not clean
 *   the schedule stopped firing -> routine-silent
 *
 * Only an explicit `clean` from a run that completed is silence.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Used when a run record does not state its own cadence. */
const DEFAULT_CADENCE_HOURS = 168;   // weekly
/** Slack before a missed run counts as silence. A noisy gate gets ignored. */
const SILENCE_GRACE_HOURS = 24;

// ---------------------------------------------------------------------------
// PURE CORE — no clock, no filesystem.
// ---------------------------------------------------------------------------

/**
 * Classify one completed run. Returns null only when the run genuinely reported
 * a clean result, which is the one case that may be silent.
 *
 * `at_ms` comes from the run record's FILE MTIME, not from a timestamp inside
 * it. The runner is a batch script and %DATE% is locale-dependent; a clock the
 * writer cannot get wrong beats a string it can.
 */
function classifyRun(run, now) {
  const { id, routine, repo, exit_status, findings, at_ms } = run;
  const common = {
    id,
    repo,
    state: 'routine',
    owner: null,
    title: `${routine} on ${repo}`,
    age_hours: Math.round((now - at_ms) / 3600000),
  };

  if (exit_status !== 0) {
    return { ...common, category: 'routine-void', why: `runner exited ${exit_status} — the routine did not complete, so it produced no verdict about the code` };
  }
  if (!findings) {
    return { ...common, category: 'routine-void', why: 'runner exited 0 but wrote no findings artifact — a run with no output is not a clean run' };
  }
  const verdict = String(findings.verdict || '').toLowerCase();
  if (verdict === 'clean') return null;
  if (verdict === 'void') {
    return { ...common, category: 'routine-void', why: `routine reported void — it could not measure${findings.void_reason ? `: ${findings.void_reason}` : ''}` };
  }
  if (verdict === 'findings') {
    // Generic wording on purpose: the first consumer was the test-strength
    // routine and this said "surviving mutation(s)" — which read as nonsense
    // the moment a pilot-liveness probe reported through the same contract.
    // The routine's own findings file carries the specific language.
    const n = Array.isArray(findings.survived) ? findings.survived.length : 0;
    const first = n && findings.survived[0] && findings.survived[0].title ? ` — first: ${findings.survived[0].title}` : '';
    return { ...common, category: 'routine-findings', why: `${n} finding(s) reported and nobody has ruled on them${first}` };
  }
  return { ...common, category: 'routine-void', why: `unrecognised verdict ${JSON.stringify(findings.verdict)} — an unreadable verdict is not a pass` };
}

/**
 * Detect a routine whose schedule stopped firing.
 *
 * ARMS ITSELF ON FIRST EVIDENCE, on purpose. Silence is only measurable against
 * a run that actually happened, so a routine that has never run once produces
 * nothing here. That avoids the worse failure: an artifact that fires on
 * compliant behaviour (the schedule simply not having come round yet) and
 * trains everyone to ignore it.
 */
function classifySilence(runs, now) {
  const newest = new Map();
  for (const r of runs) {
    const key = `${r.routine}::${r.repo}`;
    const prev = newest.get(key);
    if (!prev || r.at_ms > prev.at_ms) newest.set(key, r);
  }
  const out = [];
  for (const r of newest.values()) {
    const cadence = Number(r.cadence_hours) > 0 ? Number(r.cadence_hours) : DEFAULT_CADENCE_HOURS;
    const dueAt = r.at_ms + (cadence + SILENCE_GRACE_HOURS) * 3600000;
    if (now <= dueAt) continue;
    out.push({
      id: `R-silent-${r.routine}-${r.repo}`,
      repo: r.repo,
      state: 'routine',
      owner: null,
      title: `${r.routine} on ${r.repo} stopped running`,
      age_hours: Math.round((now - dueAt) / 3600000),
      category: 'routine-silent',
      why: `last run ${Math.round((now - r.at_ms) / 3600000)}h ago, cadence ${cadence}h plus ${SILENCE_GRACE_HOURS}h grace — the schedule is not firing`,
    });
  }
  return out;
}

/** Both rules over an already-loaded set of runs. */
function auditRuns(runs, now) {
  return [...runs.map((r) => classifyRun(r, now)).filter(Boolean), ...classifySilence(runs, now)];
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

/**
 * Read every `run-*.json` in the routine-findings directory and attach the
 * findings artifact each one points at.
 *
 * An unreadable run record is skipped rather than guessed at — but note that it
 * then cannot suppress anything either, because silence detection keys off the
 * records that DID parse.
 */
function loadRuns(findingsDir) {
  let files;
  try { files = fs.readdirSync(findingsDir); } catch { return []; }
  const runs = [];
  for (const f of files) {
    if (!f.startsWith('run-') || !f.endsWith('.json')) continue;
    const full = path.join(findingsDir, f);
    let record;
    let at_ms;
    try {
      record = JSON.parse(fs.readFileSync(full, 'utf8'));
      at_ms = fs.statSync(full).mtimeMs;
    } catch { continue; }

    let findings = null;
    if (record.findings_file) {
      const target = path.isAbsolute(record.findings_file)
        ? record.findings_file
        : path.join(findingsDir, record.findings_file);
      try { findings = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { findings = null; }
    }
    runs.push({
      id: f.replace(/\.json$/, ''),
      routine: record.routine || 'unknown',
      repo: record.repo || 'unknown',
      exit_status: Number.isFinite(record.exit_status) ? record.exit_status : 1,
      cadence_hours: record.cadence_hours,
      at_ms,
      findings,
    });
  }
  return runs;
}

/** Entry point used by fleet-steward. */
function auditRoutines(intelDir, now = Date.now()) {
  return auditRuns(loadRuns(path.join(intelDir, 'routine-findings')), now);
}

module.exports = {
  classifyRun, classifySilence, auditRuns, loadRuns, auditRoutines,
  DEFAULT_CADENCE_HOURS, SILENCE_GRACE_HOURS,
};
