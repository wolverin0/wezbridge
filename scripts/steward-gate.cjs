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
 *   resolved       — harvested and closed against its criteria (permanent)
 *   approved       — el operador respondio; cubre SOLO awaiting-operator
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
const { latestRulingWhere, rulingMatchesCategory } = require('../src/rulings.cjs');

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
  // T-0272: un owner muerto con lease escrita es un tablero MINTIENDO ahora
  // mismo — mas urgente que el vencimiento, porque el orquestador despacha
  // contra ese estado. census-unavailable igual de apretado: es el detector
  // ciego, y ciego que calla se vuelve "todo sano".
  'dead-owner-lease': 6,
  'lease-census-unavailable': 6,
  'lease-owner-unverifiable': 24,
  'abandoned-lease': 6,
  'blocked-not-gated': 48,
  'stale-running': 24,
  'stale-review': 72,
  'stale-failed': 48,
  'awaiting-operator': Infinity,   // waiting on the operator IS the correct state
  idle: 72,
  // Scheduled-routine output. A routine that ran and found something, or that
  // could not measure, is worthless if nobody looks; these deadlines are what
  // make looking mandatory. routine-silent is tightest because it means the
  // schedule itself has stopped, which silently invalidates everything after it.
  'routine-silent': 24,
  'routine-void': 48,
  'routine-findings': 48,
  // 2026-08-16 workflow-hardening lints. dispatch-unspecced is 48h because a
  // builder may already be burning a session on the unspecced work; ruling-
  // unlanded is 72h — generous on purpose, the fix is a one-line re-append.
  'dispatch-unspecced': 48,
  'ruling-unlanded': 72,
  // 2026-08-20: a PROPOSAL marker that never became a ledger task. 24h because
  // the proposing session is usually gone by then — the idea survives only if
  // someone files it or rules it dead while the context is still warm.
  'proposal-unledgered': 24,
  // 2026-09-01 (W1). Una decision del operador que su dueno nunca escucho es el
  // loop roto AHORA mismo: 6h, tan apretado como dead-owner-lease.
  'decision-unheard': 6,
  // Un result entregado que no movio su tarjeta deja el tablero mintiendo sobre
  // trabajo YA hecho; 24h alcanza para el reintento del cursor.
  'result-unlinked': 24,
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
  // `cancelled` is exempt from the category match: dead work is a property of
  // the TASK, not of whichever category the steward files its still-open card
  // under later. Proven live by T-0191 — cancelled by operator decision on
  // 2026-08-20 with category "observability" (its ledger KIND; no steward
  // finding existed yet to copy a category from), then re-fired RED daily as
  // "idle" because this check gated even the permanent verdict. `resolved`
  // deliberately KEEPS the match (see the 2026-08-14 test: finished work that
  // later shows up stale-failed was reopened or regressed, so the judgement
  // must be made again) — a dead card has no worker left to fail.
  if (ruling.ruling === 'cancelled') return true;
  // Mismo predicado que el waker (src/rulings.cjs, T-0316): una sola palabra.
  if (!rulingMatchesCategory(ruling, finding.category)) return false;

  switch (ruling.ruling) {
    case 'cancelled':
    case 'operator-gated':
      return true;                                   // permanent by design
    // `resolved` — the work was HARVESTED AND CLOSED, verified against its
    // acceptance criteria. Added 2026-08-14 because the first autonomous turn
    // hit the gap and said so: step 4 of the routine (harvest and close)
    // produced a decision that step 3's vocabulary could not express. It had to
    // log three closures as `dispatched`, which is wrong on its face and only
    // defensible because it fails safe. `cancelled` was no better — that word
    // means the work is DEAD, and a reader would misread a completed task as an
    // abandoned one. Permanent like the other two: finished work does not
    // become unfinished.
    case 'resolved':
      return true;
    // `approved` — el operador RESPONDIO la pregunta. Entra al vocabulario el
    // 2026-09-01 (W1) porque el camino sin teclado (tablero -> ruling) genera
    // esta palabra y el gate no la conocia. Cubre SOLO `awaiting-operator`, que
    // es la pregunta que respondio: aprobar no es hacer, asi que una tarjeta
    // aprobada que nadie levanta vuelve a sonar como `idle` a las 72h — eso es
    // correcto y esta afirmado en el test. La version anterior de este archivo
    // afirmaba que approved no cubria nada por miedo a ese silencio; el match
    // de categoria da la cobertura sin el silencio.
    case 'approved':
      return finding.category === 'awaiting-operator';
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

    // El criterio de "cual ruling es el mas reciente" vive en src/rulings.cjs y
    // en un solo lugar (T-0294): tres piezas lo interpretaban por su cuenta.
    const hit = latestRulingWhere(rulings, f.id, (r) => rulingCovers(r, f, now));
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

/**
 * Parse a steward report, or throw. Used for both exit paths below so that
 * "is this a valid report?" is decided by the CONTENT, in one place, rather
 * than by the exit code in two.
 */
function parseReport(text) {
  const report = JSON.parse(text);
  if (!report || !Array.isArray(report.findings)) throw new Error('no findings array');
  return report;
}

function loadFindings() {
  const from = process.argv.indexOf('--from');
  if (from > -1) return parseReport(fs.readFileSync(process.argv[from + 1], 'utf8'));
  // No --from: run the steward ourselves. If it cannot run we must say UNKNOWN,
  // never "0 findings" — a scan that did not happen is not a clean scan.
  //
  // THE STEWARD EXITS 1 ON PURPOSE when the operator personally owes something,
  // and execFileSync throws on any non-zero exit. So this used to report UNKNOWN
  // exactly when an operator decision was pending — the gate going blind in the
  // one situation it exists to surface. Latent until 2026-08-14, when fixing the
  // top-level `gate` read reclassified T-0072 to awaiting-operator and fired it
  // for the first time. Exit 3 pokes rather than passing silently, so it failed
  // loudly, which is the only reason it was noticed at all.
  //
  // A REPORT IS VALID BECAUSE IT PARSES, NOT BECAUSE THE EXIT CODE WAS 0. But a
  // crash must still be UNKNOWN, so unparseable stdout is rethrown either way.
  try {
    return parseReport(execFileSync(process.execPath, [path.join(HERE, 'fleet-steward.cjs'), '--json'],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }));
  } catch (e) {
    if (e && typeof e.status === 'number' && e.status !== 0 && e.stdout) return parseReport(e.stdout);
    throw e;
  }
}

function main() {
  let report;
  try {
    report = loadFindings();      // validates shape itself, see parseReport
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
  // El `source` va en el ejemplo porque desde W1 es OBLIGATORIO: appendRuling()
  // (src/rulings.cjs) rechaza la linea sin el, y este texto es de donde la gente
  // copia. `approved` esta listado porque el tablero ya lo escribe.
  console.log(`Rule on each by appending to ${RULINGS} (via appendRuling in src/rulings.cjs): `
    + '{"task":"<id>","category":"<category>","ruling":"cancelled|dispatched|deferred|operator-gated|resolved|approved",'
    + '"why":"...","source":"board-app|ledger-cli|telegram|orchestrator-pane|drill","at":"<iso>"}');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { evaluate, rulingCovers, DEADLINES, DISPATCH_GRACE_HOURS };
