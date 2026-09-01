#!/usr/bin/env node
'use strict';
/**
 * orchestrator-turn.cjs — wakes the orchestrator, or does the turn without one.
 *
 * WHAT THIS CORRECTS. Six orchestrator attempts were diagnosed as "the model was
 * load-bearing for liveness". That diagnosis was wrong, and it was mine. The
 * orchestrator-waker WAS firing — it accumulated 55 undrained intents. The pane
 * that reported "nothing needs you" over 26 idle tasks WAS awake. Neither died.
 * They were alive and produced nothing, and nothing in the system could say so.
 *
 * The invariant is therefore NOT "keep the model out of the loop". It is:
 *
 *      NO CLAIM MAY EXIST THAT ONLY A MODEL CAN CONTRADICT.
 *
 * steward-gate already enforces that: RED is cleared by a FILE, never by an
 * assurance. Once the check is deterministic, waking a model as often as we like
 * is safe, because a turn that narrates instead of working leaves the gate red
 * and leaves this script's own delta at zero.
 *
 * THREE PROPERTIES THAT KEEP THIS FROM BECOMING ITERATION #7:
 *
 * 1. CONDITIONAL WAKE. The trigger is evaluated by code, for free, before any
 *    model is invoked: gate not-green, or a task sitting in `review` with
 *    finished work nobody has judged. Green and nothing to judge means this
 *    exits without spending a token. The old waker's fatal shape was a clock
 *    saying "go see if anything needs doing"; this one only ever carries a
 *    specific, already-identified reason.
 *
 * 2. NO PANE REQUIRED. If a wezbridge pane exists, poke it — it has context and
 *    that is cheapest. If WezTerm is closed, run the same turn HEADLESS. So the
 *    loop turns whether or not anyone is there, which is the thing the operator
 *    was right to insist on.
 *
 * 3. THE LOOP AUDITS ITSELF. Every turn snapshots the ledger. The next turn
 *    compares. Turns that fire against a red gate and change nothing are counted,
 *    and a run of them raises an OPERATOR-GATED finding — because a loop that
 *    spins without working is exactly the failure of attempt #5, and it must
 *    reach the operator rather than quietly re-poking forever.
 *
 * EXIT CODES MEAN "DID THE JOB WORK", NOT "WHAT DID IT DO". The first version
 * returned 10 for poked and 20 for headless, and both immediately showed up as
 * FAILURES in every wrapper that reads a non-zero exit — including Task
 * Scheduler's own history, where a permanent "last result: 20" would have made a
 * healthy loop look broken forever. What the turn DID belongs in the structured
 * turn record, which already exists and can hold more than an integer.
 *
 *   0  the turn completed normally — nothing to do, poked a pane, or ran headless
 *   4  the turn itself broke
 *  30  the loop is stalled — deliberately non-zero, because that IS an alert
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { latestRulingWhere } = require('../src/rulings.cjs');

const HERE = __dirname;
const REPO = path.join(HERE, '..');
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(REPO, '..', '_intel');
const TURNS = path.join(INTEL, 'turns');
const PROMPT = path.join(REPO, 'routines', 'orchestrator-turn.md');

/** Consecutive unproductive turns before the operator is told the loop is spinning. */
const STALL_LIMIT = Number(process.env.WEZBRIDGE_STALL_LIMIT) || 3;

const log = (m) => console.log(`${new Date().toISOString()} orchestrator-turn: ${m}`);

// ---------------------------------------------------------------------------
// PURE — the two decisions worth testing without a clock or a filesystem
// ---------------------------------------------------------------------------

/**
 * Classify one beacon-shaped event into a wake class. Encodes mm-d216: a
 * `permission-wait` from a pane running bypass-permissions is a TURN BOUNDARY,
 * not a gate — Claude notifies "waiting for your input" at every idle prompt
 * even when no permission can possibly be pending. Waking on it is the exact
 * "clock asking if anything needs doing" shape this script exists to kill.
 * A permission-wait from a pane that CAN block is a real gate: `exception`.
 * A results file names a completed node: `results-directed`. A bare turn-end
 * is mid-work noise (the waker's own comments say so).
 */
function classifyEvent(evt) {
  if (!evt || typeof evt !== 'object') return 'noise';
  if (evt.event === 'result-file') return 'results-directed';
  if (evt.event === 'permission-wait') return evt.bypass ? 'noise' : 'exception';
  return 'noise'; // turn-end and anything unrecognised: a boundary, not a reason
}

/**
 * Should this turn wake anything at all — and WHY, by class?
 *
 * `gateExit` is steward-gate's verdict: 0 GREEN, 1 RED, 3 UNKNOWN.
 * UNKNOWN counts as a reason. A gate that could not see is not a clean gate, and
 * a loop that treats it as one recreates the defect the gate exists to prevent.
 *
 * Every waking reason carries a class (aligned index-for-index in `classes`):
 *   results-directed — finished work is sitting there directing the turn
 *   real-stall       — work past its deadline with no ruling (gate RED)
 *   exception        — the machinery itself broke or a pane hit a REAL gate
 *   noise            — classified and deliberately NOT woken on (mm-d216);
 *                      reported in `noise` so a skip can say what it skipped
 *
 * `events` is optional: beacon-shaped `{event, repo?, bypass?}` items to
 * classify alongside the gate/review triggers. This runs BEFORE any model is
 * invoked and costs $0 — the classes land in the turn record and actions.jsonl,
 * which is what makes "% of turns with no action" a derivable number instead
 * of an anecdote.
 */
function classifyWake({ gateExit, reviewCount, reviewTasks, events = [] }) {
  const reasons = [];
  const classes = [];
  const noise = [];
  // `reviewTasks` (ids) is the shape since T-0288; `reviewCount` (a number) is
  // kept because the 91 turn records already on disk were written with it and
  // the board back-fills their classes from these very strings.
  const named = Array.isArray(reviewTasks) ? reviewTasks : null;
  const reviews = named ? named.length : (reviewCount || 0);
  if (gateExit === 1) { reasons.push('gate RED: work past deadline with no ruling'); classes.push('real-stall'); }
  if (gateExit === 3) { reasons.push('gate UNKNOWN: it could not read its own findings'); classes.push('exception'); }
  if (gateExit !== 0 && gateExit !== 1 && gateExit !== 3) { reasons.push(`gate exited ${gateExit}, which is not a verdict this loop knows`); classes.push('exception'); }
  if (reviews > 0) {
    // AC5: name them. The old poke said "1 task(s)" and made every woken turn
    // re-derive which card it was — four turns in a row did exactly that.
    // The substring "in review with finished work" is load-bearing: the board's
    // classOfReason() matches on it, and test/board-observability.test.cjs
    // generates its expectations THROUGH this function so the two cannot drift.
    reasons.push(`${reviews} task(s) in review with finished work nobody has judged${named ? `: ${named.join(', ')}` : ''}`);
    classes.push('results-directed');
  }
  for (const evt of events) {
    const cls = classifyEvent(evt);
    const desc = `${(evt && evt.event) || 'unrecognised event'}${evt && evt.repo ? ` from ${evt.repo}` : ''}`;
    if (cls === 'noise') { noise.push(desc); continue; }
    reasons.push(cls === 'results-directed' ? `${desc}: completed work to harvest` : `${desc}: pane blocked at a real gate`);
    classes.push(cls);
  }
  return { wake: reasons.length > 0, reasons, classes, noise };
}

/** Back-compat shim: the pre-classifier shape some callers/tests still use. */
function shouldWake(input) {
  const { wake, reasons } = classifyWake(input);
  return { wake, reasons };
}

/**
 * Did the previous turn actually change anything?
 *
 * Deliberately counts ARTIFACTS, not effort: rulings written, tasks touched.
 * A turn that read everything, reasoned beautifully and wrote nothing scores
 * zero here, which is the correct score.
 */
function turnWasProductive(prev, now) {
  if (!prev) return true;                       // nothing to compare against yet
  return now.rulings !== prev.rulings
      || now.taskCount !== prev.taskCount
      || now.taskMtime !== prev.taskMtime;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** A cheap deterministic fingerprint of the ledger. */
function snapshot() {
  let rulings = 0;
  try { rulings = fs.readFileSync(path.join(INTEL, 'rulings.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* none yet */ }
  let taskCount = 0;
  let taskMtime = 0;
  try {
    for (const f of fs.readdirSync(path.join(INTEL, 'tasks'))) {
      if (!f.endsWith('.json')) continue;
      taskCount += 1;
      taskMtime = Math.max(taskMtime, fs.statSync(path.join(INTEL, 'tasks', f)).mtimeMs);
    }
  } catch { /* no ledger */ }
  return { rulings, taskCount, taskMtime };
}

/**
 * Which cards in `review` still need a human turn — RULINGS INCLUDED.
 *
 * T-0288. The old `reviewCount()` did a readdir, filtered `state === 'review'`
 * and returned a LENGTH. It never opened rulings.jsonl, so a deferral — the
 * mechanism this very routine defines for parking something on purpose — could
 * not suppress anything. THE ASYMMETRY WAS THE BUG: steward-gate DOES read
 * rulings and was returning GREEN over the same ledger, so two authorities
 * disagreed about one file and the orchestrator obeyed the one that was not
 * reading it. Measured on 2026-08-27: the 22:00Z, 00:00Z, 02:00Z and 04:00Z
 * turns were all woken by T-0207, deferred until 12:30Z since 20:12Z, and the
 * only move left to a turn with nothing to do was to write another defensive
 * ruling so as not to count as silence — with rulings.jsonl being the very
 * yardstick the routine uses to measure whether a turn produced anything.
 *
 * FAILS OPEN, per T-0268. This component's failure mode is a BLIND
 * orchestrator, so suppression happens only on a positive, explicit,
 * still-in-the-future `until`. Unreadable file, corrupt line, unknown ruling
 * word, missing or unparseable `until`, wrong category — every one of those
 * pokes. Silence is never the default; it is earned by a live deferral.
 *
 * Pure: no clock, no filesystem. `rulings` that is not an array means "could
 * not be read", which suppresses nothing.
 */
function reviewWakeTargets({ tasks, rulings, now }) {
  const cards = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.state === 'review');
  if (!Array.isArray(rulings)) return cards.map((t) => t.id);   // fail open
  return cards.filter((t) => {
    // Latest applicable line wins, so a deferral is revised by appending —
    // the same rule steward-gate uses, deliberately.
    // Mismo criterio de orden que el gate y el lint, importado y no recopiado
    // (T-0294): tres copias del mismo criterio vuelven a divergir.
    const hit = latestRulingWhere(rulings, t.id, (r) => deferralIsLive(r, now));
    return !hit;
  }).map((t) => t.id);
}

/** Only a `deferred` ruling with an `until` still ahead of `now` buys silence. */
function deferralIsLive(ruling, now) {
  if (!ruling || ruling.ruling !== 'deferred') return false;
  // Category is part of the match, as in steward-gate: a card parked while
  // merely idle must not stay silent once its finished work needs judging.
  // Absent category matches anything, which is that function's own laxity.
  if (ruling.category && ruling.category !== 'review') return false;
  if (!ruling.until) return false;                 // a deferral with no end is a shrug
  const until = Date.parse(ruling.until);
  return Number.isFinite(until) && now < until;
}

/** IO shell over an explicit _intel dir, so tests never touch the live ledger. */
function reviewTargetsIn(intelDir, now = Date.now()) {
  let tasks;
  try {
    tasks = fs.readdirSync(path.join(intelDir, 'tasks'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(intelDir, 'tasks', f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }        // no ledger at all: nothing to claim about it
  let rulings = null;           // null = unreadable => fail open
  try {
    rulings = fs.readFileSync(path.join(intelDir, 'rulings.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { rulings = null; }
  return reviewWakeTargets({ tasks, rulings, now });
}

function runGate() {
  const r = spawnSync(process.execPath, [path.join(HERE, 'steward-gate.cjs')],
    { encoding: 'utf8', timeout: 180000 });
  // A gate we could not even launch is UNKNOWN, not green. Same rule as inside it.
  return r.error || r.status === null ? 3 : r.status;
}

function lastTurn() {
  try {
    const files = fs.readdirSync(TURNS).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(TURNS, files[files.length - 1]), 'utf8'));
  } catch { return null; }
}

function writeTurn(rec) {
  fs.mkdirSync(TURNS, { recursive: true });
  const name = `turn-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(TURNS, name), JSON.stringify(rec, null, 2));
  // Keep the directory bounded; the ledger is the record, this is a trail.
  const files = fs.readdirSync(TURNS).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, -200)) { try { fs.unlinkSync(path.join(TURNS, f)); } catch { /* ignore */ } }
  return name;
}

/**
 * Stable prefix for the loop-stall alert's `origin_key`. The EPISODE suffix is
 * minted the first time a stall is raised with no open card; that is what lets a
 * closed alert be raised again instead of silently resurrecting the one the
 * operator already ruled on.
 */
const STALL_ORIGIN = 'orchestrator:loop-stall';

/** First line of an error, for one-line logs. */
const firstLine = (e) => String(e && e.message).split(String.fromCharCode(10))[0];

/** The fleet ledger lives in a sibling repo; resolved late so a missing checkout is diagnosable. */
function loadLedger() {
  return require(path.join(REPO, '..', '_docs-curation', 'ledger.cjs'));
}

/**
 * Tell the operator the loop is spinning. Written as a normal ledger task so it
 * appears on his board and in the gate like anything else — a bespoke alert
 * channel is one more thing that can be ignored.
 *
 * WHY THIS GOES THROUGH ledger.cjs AND NOT fs.writeFileSync (T-0290, 2026-08-28).
 * It used to write `_intel/tasks/T-LOOP-STALL.json` by hand. `allTasks()` filters
 * `/^T-\d{4}\.json$/`, so that file was invisible to `list`, to `dashboard`, and
 * to everything derived from them — the alert of last resort reached nobody, and
 * it had ALREADY FIRED in production without anyone noticing. The alternative fix
 * (widening the regex) was rejected by consequence, not taste: `nextId()` does
 * `parseInt(id.slice(2), 10)` over `allTasks()`, so admitting `T-LOOP-STALL`
 * makes `Math.max(...)` NaN and the fleet's next card `T-NaN`. A real `T-NNNN`
 * id also buys the card the whole governed surface — update, lease, rulings,
 * blocked_by accounting — instead of a second task format nothing else speaks.
 *
 * FAIL LOUD, NEVER SILENT: if the ledger cannot be reached the alert is logged
 * and the turn still exits 30. What must never happen again is a write that
 * SUCCEEDS and is read by nobody.
 *
 * @returns the ledger task, or null when the alert could not be filed.
 */
function raiseStall(stalls, reasons) {
  const blocker = `${stalls} consecutive turns fired against a non-green gate and produced no `
    + `ruling and no task change. Latest reasons: ${reasons.join(' | ')}. This is the failure mode `
    + 'of the 2026-04 orchestrator-waker, which accumulated 55 undrained intents while looking '
    + 'healthy. It is surfaced here rather than re-poking forever.';
  let ledger;
  try { ledger = loadLedger(); } catch (e) {
    log(`CANNOT FILE THE STALL ALERT — the fleet ledger is unreachable (${firstLine(e)}). ${blocker}`);
    return null;
  }
  try {
    const open = ledger.list({ state: 'open' })
      .find((t) => typeof t.origin_key === 'string' && t.origin_key.startsWith(`${STALL_ORIGIN}:`));
    // Create and re-raise converge on the same update, so the blocker text a
    // human reads is produced by ONE path and cannot drift between them.
    const card = open || ledger.create({
      title: 'The orchestrator loop is firing and achieving nothing',
      goal: 'Decide whether the loop is broken, the work is genuinely blocked, or the trigger is wrong.',
      // `question`, no `general`. La tarjeta dice textual "a human decides", y
      // kinds.json define question como class:coordination con
      // fallback_gate:operator — "a question IS an operator decision". `general`
      // tiene fallback_gate null, así que la alarma no ganaba gate por NINGUNA
      // rama de create() y el steward la clasificaba blocked-not-gated: deadline
      // de 48h sobre un estado correcto, y fuera de la lista que el operador lee.
      // Declarar el kind honesto es lo que la pone en awaiting-operator.
      kind: 'question',
      repo: 'wezbridge',
      // `state` y `blocked-by` se declaran, y el GATE lo deriva el ledger del kind
      // con independencia de ambos. Eso ultimo no siempre fue cierto: hasta T-0269
      // las dos ramas de gate de create() estaban guardadas por
      // `!['blocked','cancelled'].includes(state)`, asi que declarar state:'blocked'
      // aca CORTOCIRCUITABA el gate y la alarma nacia con `gate: null`. Hoy el
      // ledger deriva el gate antes de mirar el estado, y hay un test que lo fija
      // (`ledger-fleet-minimum-gate.test.cjs`) — si alguien vuelve a acoplarlos,
      // ese test se pone rojo antes de que esta alarma se apague en silencio.
      state: 'blocked',
      'blocked-by': 'operator',
      origin: `${STALL_ORIGIN}:${new Date().toISOString()}`,
      criteria: 'a human decides: fix the loop, unblock the work, or change the trigger',
      next: 'read the last turn records under _intel/turns/, then rule: fix the loop, unblock the work, or change the trigger',
    });
    return ledger.update(card.id, { blocker });
  } catch (e) {
    log(`CANNOT FILE THE STALL ALERT — the ledger refused the card (${firstLine(e)}). ${blocker}`);
    return null;
  }
}

/**
 * T-0283 AC6: la alarma de stall se LIMPIA sola cuando el loop vuelve a ser
 * productivo. raiseStall() la creaba y re-levantaba, el contador `stalls` se
 * reseteaba (main), pero NADA cerraba la tarjeta: quedaba blocked para siempre
 * en el tablero del operador. Control: una tarjeta que un humano ya rulo (hay
 * lineas en rulings.jsonl para su id) o que no es de stall (origin_key ajeno) no
 * se toca — cancelar el trabajo de otro es peor que dejar una alarma vieja.
 */
function clearStall({ productive, now = new Date().toISOString(), reason = '' } = {}) {
  const out = { cleared: [], skipped: [] };
  if (!productive) return out;
  let ledger;
  try { ledger = loadLedger(); } catch (e) { log(`clearStall: ledger unreachable (${firstLine(e)})`); return out; }
  let rulings = [];
  try {
    rulings = fs.readFileSync(path.join(INTEL, 'rulings.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* sin rulings */ }
  let open = [];
  try {
    open = ledger.list({ state: 'open' })
      .filter((t) => typeof t.origin_key === 'string' && t.origin_key.startsWith(`${STALL_ORIGIN}:`));
  } catch (e) { log(`clearStall: ledger.list failed (${firstLine(e)})`); return out; }
  for (const card of open) {
    if (rulings.some((r) => r && r.task === card.id)) {
      out.skipped.push({ id: card.id, reason: 'ruling humano sobre la tarjeta: no se cierra sola' });
      continue;
    }
    try {
      ledger.update(card.id, {
        state: 'cancelled',
        evidence: `loop productivo de nuevo ${now}${reason ? ` (${reason})` : ''}: la alarma de stall se cierra sola (T-0283 AC6)`,
        note: 'clearStall: turno productivo posterior a la alarma',
      });
      out.cleared.push(card.id);
      log(`stall alert ${card.id} cleared: the loop is productive again`);
    } catch (e) {
      out.skipped.push({ id: card.id, reason: `ledger refused: ${firstLine(e)}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * A turn already in flight must not get a twin.
 *
 * Duplicate RULINGS are harmless — the latest wins. Duplicate DISPATCHES are
 * not: two panes told to do the same task is how the same work gets done twice
 * and merged twice. The lease is short and self-expiring, because a lease that
 * outlives a dead holder blocks the loop forever, which is worse than the
 * occasional overlap it prevents.
 */
const LEASE = path.join(TURNS, 'in-flight.json');
const LEASE_MINUTES = Number(process.env.WEZBRIDGE_TURN_LEASE_MIN) || 25;

function leaseHeld() {
  try {
    const l = JSON.parse(fs.readFileSync(LEASE, 'utf8'));
    return Date.parse(l.expires_at) > Date.now() ? l : null;
  } catch { return null; }
}

function takeLease(kind) {
  fs.mkdirSync(TURNS, { recursive: true });
  fs.writeFileSync(LEASE, JSON.stringify({
    kind, at: new Date().toISOString(),
    expires_at: new Date(Date.now() + LEASE_MINUTES * 60000).toISOString(),
  }));
}

async function main() {
  // W3: the orchestrator's own rotation discipline, checked before anything
  // else so THIS turn's gate already sees the verdict. Reports through the
  // routine-audit contract (run record + findings artifact) — the same chain
  // that retired pane-40 now watches the orch pane's Ctx%. The check must
  // never break the turn; --dry-run touches nothing, same as everywhere else.
  if (!process.argv.includes('--dry-run')) {
    try {
      const { runCtxCheck } = require('./orch-ctx-check.cjs');
      const ctx = runCtxCheck({});
      if (ctx.verdict !== 'clean') log(`orch-ctx-check: ${ctx.verdict}${Number.isFinite(ctx.pct) ? ` (${ctx.pct}%)` : ''}`);
    } catch (e) { log(`orch-ctx-check failed to run: ${String(e && e.message).split('\n')[0]}`); }
  }

  const gateExit = runGate();
  const reviewTasks = reviewTargetsIn(INTEL);
  const reviews = reviewTasks.length;
  const { wake, reasons, classes, noise } = classifyWake({ gateExit, reviewTasks });
  const now = snapshot();
  const prev = lastTurn();

  // Stall accounting happens BEFORE deciding what to do, so a spinning loop is
  // caught even on the turn where it would otherwise fire again.
  let stalls = 0;
  const productive = !!(prev && prev.woke && turnWasProductive(prev.snapshot, now));
  if (prev && prev.woke && !productive) stalls = (prev.stalls || 0) + 1;

  // T-0283 AC6: el contador se resetea aca desde siempre; ahora la ALARMA tambien.
  let stallCleared = null;
  if (productive && !process.argv.includes('--dry-run')) {
    const c = clearStall({ productive, reason: `rulings ${prev.snapshot && prev.snapshot.rulings}->${now.rulings}, tasks ${prev.snapshot && prev.snapshot.taskCount}->${now.taskCount}` });
    if (c.cleared.length || c.skipped.length) stallCleared = c;
  }

  const base = { at: new Date().toISOString(), gate_exit: gateExit, reviews, reasons, classes, ...(noise.length ? { noise } : {}), snapshot: now, stalls, ...(stallCleared ? { stall_cleared: stallCleared } : {}) };

  // --dry-run: evaluate and report, touch nothing. Exists so the trigger can be
  // inspected against live state without waking anyone — including from the
  // very pane it would otherwise poke.
  if (process.argv.includes('--dry-run')) {
    log(`DRY RUN | gate=${gateExit} reviews=${reviews} stalls=${stalls} wake=${wake} classes=[${classes.join(', ')}]`);
    reasons.forEach((r, i) => log(`  reason [${classes[i]}]: ${r}`));
    for (const n of noise) log(`  noise (not waking): ${n}`);
    log(`  would: ${!wake ? 'nothing, no model invoked' : stalls >= STALL_LIMIT ? 'file the loop-stall alert as a ledger card for the operator' : 'poke the wezbridge pane, or run headless if none'}`);
    return 0;
  }

  // Do not start a second turn on top of one still running. Checked only when
  // we would otherwise wake something, so a green tick never touches the lease.
  const held = leaseHeld();
  if (wake && held) {
    writeTurn({
      ...base, woke: false, action: 'lease-held',
      note: `a ${held.kind} turn taken at ${held.at} is still in flight until ${held.expires_at}`,
    });
    log(`a turn is already in flight (${held.kind}, until ${held.expires_at}) - not starting a second one`);
    return 0;
  }

  if (!wake) {
    // A skipped turn used to leave NOTHING in actions.jsonl, which made
    // "% of turns without action" underivable. One $0 line fixes that: the
    // classifier ran, found only green/noise, and no model was invoked.
    try {
      const { logAction } = require(path.join(REPO, 'src', 'action-log.cjs'));
      logAction('waker_skip', {
        why: 'gate green and nothing awaiting judgement - no model invoked',
        extra: { classes, ...(noise.length ? { noise } : {}) },
      });
    } catch { /* observability must not break the turn */ }
    writeTurn({ ...base, woke: false, action: 'none', note: 'gate green and nothing awaiting judgement - no model invoked' });
    log(`nothing to do (gate ${gateExit}, ${reviews} in review). No model invoked.`);
    return 0;
  }

  if (stalls >= STALL_LIMIT) {
    // The card id goes into the turn record and the log: an alert nobody can
    // NAME is barely better than one nobody can see.
    const card = raiseStall(stalls, reasons);
    writeTurn({
      ...base, woke: false, action: 'stall-raised', stall_task: card ? card.id : null,
      note: `${stalls} unproductive turns - handed to the operator instead of poking again`
        + (card ? '' : ' (THE ALERT COULD NOT BE FILED - see the log line above)'),
    });
    log(`STALLED: ${stalls} turns fired and changed nothing. ${card ? `Raised ${card.id} for the operator.` : 'The alert could NOT be filed.'}`);
    return 30;
  }

  // Prefer the live pane: it has context, so the turn is cheap and better.
  const msg = path.join(INTEL, 'orchestrator-turn-poke.txt');
  fs.writeFileSync(msg,
    `[orchestrator-turn] ${reasons.join(' | ')}. Read routines/orchestrator-turn.md and do that turn now. `
    + 'Output must be FILES (rulings, task edits, dispatches) - this turn is measured by what changed on disk, not by what you say.\n');

  // TARGET BY TAB TITLE, not by project. Found on the first live fire: two panes
  // sit in the wezbridge repo (this orchestrator and a codex session the
  // operator opened), so `--project wezbridge` resolved ambiguously, poke-pane
  // correctly refused to guess, and EVERY turn fell through to the expensive
  // headless path — losing the live pane's context for no reason. The tab title
  // is the operator's own stable name for a pane and survives renumbering.
  // Project is still passed as a second constraint.
  const tab = process.env.WEZBRIDGE_ORCH_TAB || 'orch';
  const poke = spawnSync(process.execPath, [path.join(HERE, 'poke-pane.cjs'),
    '--tab-title', tab, '--project', 'wezbridge', '--file', msg],
  { encoding: 'utf8', timeout: 120000 });
  const pokeCode = poke.error ? 3 : poke.status;

  if (pokeCode === 0) {
    takeLease('pane');
    writeTurn({ ...base, woke: true, action: 'poked-pane' });
    log(`poked the live orchestrator pane - ${reasons.join(' | ')}`);
    return 0;
  }

  // NOT ALL POKE FAILURES MEAN "NOBODY IS HOME", and treating them alike is how
  // two agents end up dispatching the same task to the same pane.
  //   7 = the prompt stayed in the composer, i.e. the pane is BUSY. Somebody is
  //       already there and working; the message is queued. Spawning a headless
  //       twin here would duplicate the turn. Wait for the next one.
  //   5 = ambiguous. That is a configuration problem (two panes answer to the
  //       same name) and running headless would hide it rather than fix it.
  if (pokeCode === 7 || pokeCode === 5) {
    writeTurn({ ...base, woke: false, action: 'skipped', note: `poke-pane exit ${pokeCode} - ${pokeCode === 7 ? 'pane is busy, message queued, not duplicating the turn' : 'ambiguous pane selector, fix the tab title rather than run twice'}` });
    log(`skipping this turn: poke-pane exit ${pokeCode}`);
    return 0;
  }

  // Genuinely no pane (4 = no match, 3 = wezterm unreachable). Do the turn
  // anyway. This is the half that makes "hope you are there" obsolete rather
  // than merely unlikely.
  takeLease('headless');
  const prompt = fs.readFileSync(PROMPT, 'utf8');
  // Fleet attribution (mm-7d0e): frame this turn in actions.jsonl so any
  // spawn/kill/dispatch lines between start and end are attributable to it,
  // and mark the child env so in-turn spawns carry the actor explicitly.
  let alog = null;
  try { alog = require(path.join(REPO, 'src', 'action-log.cjs')); } catch {}
  if (alog) alog.logAction('orchestrator_turn_start', { why: 'scheduled headless turn' });
  // T-0283: el hijo escribe su trabajo y a veces NO sale (medido 2026-08-26: 4
  // turnos seguidos hicieron todo a los ~5 min y spawnSync los mato a los 15
  // registrando FAILED). runHeadless vigila last-summary.txt: escrito y sin salir
  // en 120 s => se lo mata y el turno es OK (completed-no-exit); nada escrito al
  // timeout duro (que SIGUE siendo 15 min, AC2) => timeout-no-output.
  const { runHeadless } = require(path.join(REPO, 'src', 'headless-run.cjs'));
  const r = await runHeadless({
    command: 'claude', args: ['-p', '--dangerously-skip-permissions'], input: prompt,
    summaryFile: path.join(TURNS, 'last-summary.txt'),
    timeoutMs: 900000, graceMs: 120000,
    spawnOpts: { cwd: path.join(REPO, '..'), shell: true, env: { ...process.env, WEZBRIDGE_ACTOR: 'orchestrator-turn-headless' } },
  });
  const ok = r.turnExitCode === 0;
  writeTurn({
    ...base, woke: true, action: 'headless',
    headless_exit: r.status, headless_outcome: r.outcome, killed: r.killed,
    summary_written_at: r.summaryWrittenAt ? new Date(r.summaryWrittenAt).toISOString() : null,
    exited_at: new Date(r.exitedAt).toISOString(),
    exit_after_summary_ms: r.summaryWrittenAt ? r.exitedAt - r.summaryWrittenAt : null,
  });
  if (alog) alog.logAction('orchestrator_turn_end', { extra: { ok, exit: r.status, outcome: r.outcome, killed: r.killed } });
  log(`headless turn ${ok ? `completed (${r.outcome}${r.killed ? ', child killed after grace' : ''})` : `FAILED (${r.outcome}, exit ${r.status})`}`);
  return ok ? 0 : 4;
}

if (require.main === module) main().then((code) => process.exit(code), (e) => { log(`turn crashed: ${firstLine(e)}`); process.exit(4); });
module.exports = { reviewWakeTargets, reviewTargetsIn, deferralIsLive, classifyWake, classifyEvent, shouldWake, turnWasProductive, raiseStall, clearStall, STALL_LIMIT };
