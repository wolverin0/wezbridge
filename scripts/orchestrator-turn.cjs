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
function classifyWake({ gateExit, reviewCount, events = [] }) {
  const reasons = [];
  const classes = [];
  const noise = [];
  if (gateExit === 1) { reasons.push('gate RED: work past deadline with no ruling'); classes.push('real-stall'); }
  if (gateExit === 3) { reasons.push('gate UNKNOWN: it could not read its own findings'); classes.push('exception'); }
  if (gateExit !== 0 && gateExit !== 1 && gateExit !== 3) { reasons.push(`gate exited ${gateExit}, which is not a verdict this loop knows`); classes.push('exception'); }
  if (reviewCount > 0) { reasons.push(`${reviewCount} task(s) in review with finished work nobody has judged`); classes.push('results-directed'); }
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

function reviewCount() {
  try {
    return fs.readdirSync(path.join(INTEL, 'tasks'))
      .filter((f) => f.endsWith('.json'))
      .filter((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(INTEL, 'tasks', f), 'utf8')).state === 'review'; } catch { return false; }
      }).length;
  } catch { return 0; }
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
 * Tell the operator the loop is spinning. Written as a normal ledger task so it
 * appears on his board and in the gate like anything else — a bespoke alert
 * channel is one more thing that can be ignored.
 */
function raiseStall(stalls, reasons) {
  const id = 'T-LOOP-STALL';
  const file = path.join(INTEL, 'tasks', `${id}.json`);
  const now = new Date().toISOString();
  let task;
  try { task = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { task = null; }
  if (task && task.state !== 'done' && task.state !== 'cancelled') {
    task.updated_at = now;
    task.blocker = `${stalls} consecutive turns have fired and changed nothing. Latest reasons: ${reasons.join(' | ')}`;
    fs.writeFileSync(file, JSON.stringify(task, null, 2));
    return;
  }
  fs.writeFileSync(file, JSON.stringify({
    id,
    title: 'The orchestrator loop is firing and achieving nothing',
    goal: 'Decide whether the loop is broken, the work is genuinely blocked, or the trigger is wrong.',
    kind: 'general',
    repo: 'wezbridge',
    state: 'blocked',
    gate: 'operator',
    blocker: `${stalls} consecutive turns fired against a non-green gate and produced no ruling and no task change. Latest reasons: ${reasons.join(' | ')}. This is the failure mode of the 2026-04 orchestrator-waker, which accumulated 55 undrained intents while looking healthy. It is surfaced here rather than re-poking forever.`,
    acceptance_criteria: ['a human decides: fix the loop, unblock the work, or change the trigger'],
    lease: null,
    created_at: now,
    updated_at: now,
  }, null, 2));
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

function main() {
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
  const reviews = reviewCount();
  const { wake, reasons, classes, noise } = classifyWake({ gateExit, reviewCount: reviews });
  const now = snapshot();
  const prev = lastTurn();

  // Stall accounting happens BEFORE deciding what to do, so a spinning loop is
  // caught even on the turn where it would otherwise fire again.
  let stalls = 0;
  if (prev && prev.woke && !turnWasProductive(prev.snapshot, now)) stalls = (prev.stalls || 0) + 1;

  const base = { at: new Date().toISOString(), gate_exit: gateExit, reviews, reasons, classes, ...(noise.length ? { noise } : {}), snapshot: now, stalls };

  // --dry-run: evaluate and report, touch nothing. Exists so the trigger can be
  // inspected against live state without waking anyone — including from the
  // very pane it would otherwise poke.
  if (process.argv.includes('--dry-run')) {
    log(`DRY RUN | gate=${gateExit} reviews=${reviews} stalls=${stalls} wake=${wake} classes=[${classes.join(', ')}]`);
    reasons.forEach((r, i) => log(`  reason [${classes[i]}]: ${r}`));
    for (const n of noise) log(`  noise (not waking): ${n}`);
    log(`  would: ${!wake ? 'nothing, no model invoked' : stalls >= STALL_LIMIT ? 'raise T-LOOP-STALL to the operator' : 'poke the wezbridge pane, or run headless if none'}`);
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
    raiseStall(stalls, reasons);
    writeTurn({ ...base, woke: false, action: 'stall-raised', note: `${stalls} unproductive turns - handed to the operator instead of poking again` });
    log(`STALLED: ${stalls} turns fired and changed nothing. Raised T-LOOP-STALL for the operator.`);
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
  const r = spawnSync('claude', ['-p', '--dangerously-skip-permissions'], {
    input: prompt, encoding: 'utf8', cwd: path.join(REPO, '..'), timeout: 900000, shell: true,
    env: { ...process.env, WEZBRIDGE_ACTOR: 'orchestrator-turn-headless' },
  });
  const ok = !r.error && r.status === 0;
  writeTurn({ ...base, woke: true, action: 'headless', headless_exit: r.error ? null : r.status });
  if (alog) alog.logAction('orchestrator_turn_end', {
    extra: { ok, exit: r.error ? String(r.error.message) : r.status },
  });
  log(`headless turn ${ok ? 'completed' : `FAILED (${r.error ? r.error.message : r.status})`}`);
  return ok ? 0 : 4;
}

if (require.main === module) process.exit(main());
module.exports = { classifyWake, classifyEvent, shouldWake, turnWasProductive, STALL_LIMIT };
