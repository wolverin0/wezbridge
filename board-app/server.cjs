#!/usr/bin/env node
'use strict';
/**
 * board-app/server.cjs — the fleet board's hands. Bare node http, zero deps.
 *
 * Serves the built SPA (dist/) plus a narrow, deterministic API. No model in
 * any path. The board acts the way every fleet component acts: by APPENDING
 * to _intel files, and it holds no state of its own — _intel/ remains the only
 * truth and every payload declares its own generated_at so staleness is honest.
 *
 * ONE exception, added by T-0143 and deliberately narrow: a TERMINAL ruling
 * must move its task. Before it did, cancelling a decision appended the ruling
 * and changed nothing, so the card the operator had just killed came back on
 * every refresh. `TASK_TRANSITION` below is the complete list of task-state
 * writes this process may ever perform — a whitelist, not a door. The ruling
 * append stays FIRST and authoritative; if the task write then fails, the
 * ruling still stands and the response says so rather than claiming success.
 *
 *   GET  /api/state               full cockpit state (token required)
 *   GET  /api/activity?page=N     unified feed, 25 per page (token required)
 *   POST /api/rulings             {task, verb, until?, note} → append rulings.jsonl
 *   POST /api/orchestrator-inbox  {kind, text} → append operator-actions.jsonl
 *
 * Auth: single shared token in board-app/.env.local (generated on first boot),
 * sent as x-board-token. Binds 0.0.0.0 so LAN/WireGuard phones reach it —
 * hence no naked endpoints even though it never leaves the house.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HERE = __dirname;
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(HERE, '..', '..', '_intel');
const DIST = path.join(HERE, 'dist');
const PORT = Number(process.env.WEZBRIDGE_BOARD_PORT || 4272);
const ENV_FILE = path.join(HERE, '.env.local');

const { appendRuling } = require(path.join(HERE, '..', 'src', 'rulings.cjs'));
const { audit, loadTasks } = require(path.join(HERE, '..', 'scripts', 'fleet-steward.cjs'));
const { loadRuns, boardVerdict } = require(path.join(HERE, '..', 'scripts', 'routine-audit.cjs'));
const { evaluate, rulingCovers } = require(path.join(HERE, '..', 'scripts', 'steward-gate.cjs'));
const { gateOf } = require(path.join(HERE, '..', 'scripts', 'fleet-board.cjs'));
const { evaluateIntel: freshEvaluate } = require(path.join(HERE, '..', 'scripts', 'board-fresh-gate.cjs'));
const { buildObservability, makeCensusCache } = require(path.join(HERE, 'lib', 'observability.cjs'));
const { verifyAction, ACTION_VERBS } = require(path.join(HERE, 'lib', 'action-links.cjs'));

const VERBS = ['approved', 'deferred', 'cancelled'];
const INBOX_KINDS = ['note', 'new-task', 'call-me'];
const PAGE_SIZE = 25;
const OPEN_STATES = ['ready', 'queued', 'running', 'review', 'blocked', 'failed'];

/**
 * THE WHITELIST (T-0143 D1). Every task-state write this process is capable of
 * making is a value in this object. A verb mapped to `null` legitimately moves
 * nothing. Adding a key here is the only way to widen it, which is the point.
 *
 *   cancelled → cancelled   the work is dead; *cancelar* means what it says.
 *   approved  → ready + UN-GATE. Clearing the operator gate is not optional
 *               garnish: DECISIONES is built from open tasks with
 *               gateOf(t) === 'operator', and `ready` is an OPEN state, so a
 *               state-only move would leave the approved card on screen
 *               forever — the exact defect being fixed. Un-gating is what
 *               `_intel/templates/decision-task.md` means by "the task
 *               un-gates: state moves and the work dispatches like any other".
 *               The gate lives in EITHER `contract.gate` OR a top-level
 *               `gate`; see ungateTask() for why reading both and writing one
 *               shipped this same defect a second time.
 *   deferred  → nothing. Still legitimately gated; only the CARD hides, and
 *               only while the ruling still covers it (see buildState).
 */
const TASK_TRANSITION = {
  // `blocked_by` solo se toca donde la respuesta lo cambia. Aprobar CONTESTA al
  // operador, asi que la tarjeta deja de esperarlo: sin esto quedaba `ready`
  // con `blocked_by: operator` y seguia contando como deuda del operador en la
  // unica metrica que mide si la orquestacion funciona. Cancelar no contesta
  // nada — la tarea muere con la pregunta abierta — y ahi reescribir el campo
  // seria inventar un dato sobre una tarjeta cerrada.
  cancelled: { state: 'cancelled', ungate: false, blockedBy: null },
  approved: { state: 'ready', ungate: true, blockedBy: 'agent' },
  deferred: null,
};

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

function loadToken() {
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const m = text.match(/^BOARD_TOKEN=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* first boot */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(ENV_FILE, `BOARD_TOKEN=${token}\n`, { flag: 'a' });
  return token;
}

function tokenOk(req, token) {
  const got = String(req.headers['x-board-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// reads (all derive from _intel; nothing cached, nothing owned)
// ---------------------------------------------------------------------------

function readJsonl(file, max = Infinity) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-max)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function fileAge(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function lastTurn() {
  const dir = path.join(INTEL, 'turns');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('turn-') && f.endsWith('.json')).sort();
    if (!files.length) return null;
    const f = files[files.length - 1];
    return { file: f, at: fs.statSync(path.join(dir, f)).mtimeMs };
  } catch { return null; }
}

/**
 * Routine runs for the board. The reading and the verdict wording both come
 * from routine-audit, which OWNS the findings-file contract (T-0147).
 *
 * This function used to re-implement that resolution. So did fleet-board. Both
 * copies got the cwd wrong and both were fixed separately, which is three
 * copies of four lines and two identical bugs. `test/routine-findings-single-
 * reader.test.cjs` now fails if a fourth one appears.
 */
function routineRuns() {
  const dir = path.join(INTEL, 'routine-findings');
  return loadRuns(dir)
    .map((r) => ({
      routine: r.routine,
      repo: r.repo,
      cadence_hours: r.cadence_hours,
      exit_status: r.exit_status,
      at: r.at_ms,
      verdict: boardVerdict(r),
    }))
    .sort((a, b) => b.at - a.at);
}

/**
 * Unified reverse-chron activity feed. Each entry: {at, type, title, detail}.
 * Sources are the append-only files the fleet already writes — the feed is a
 * VIEW, not a new log.
 */
function activityFeed() {
  const items = [];
  for (const r of readJsonl(path.join(INTEL, 'rulings.jsonl'), 500)) {
    items.push({ at: Date.parse(r.at) || 0, type: 'ruling', title: `${r.ruling}: ${r.task}`, detail: r.why || '' });
  }
  for (const e of readJsonl(path.join(INTEL, 'events.jsonl'), 500)) {
    const title = e.event === 'a2a.sent'
      ? `a2a ${e.from_pane}→${e.to_pane} ${e.type || ''}`.trim()
      : `${e.event}${e.task_id ? `: ${e.task_id}` : ''}`;
    items.push({ at: Date.parse(e.time) || 0, type: 'event', title, detail: e.state || e.corr || '' });
  }
  for (const a of readJsonl(path.join(INTEL, 'operator-actions.jsonl'), 200)) {
    items.push({ at: Date.parse(a.at) || 0, type: 'operator', title: `${a.kind}: ${String(a.text).slice(0, 80)}`, detail: '' });
  }
  for (const r of routineRuns().slice(0, 50)) {
    items.push({ at: r.at, type: 'routine', title: `${r.routine} (${r.repo})`, detail: `exit ${r.exit_status} · ${r.verdict}` });
  }
  return items.sort((a, b) => b.at - a.at);
}

/** Sparkline: per-hour counts over the last 24h of rulings + events + turns. */
function sparkline(now) {
  const buckets = new Array(24).fill(0);
  const add = (t) => {
    if (!t) return;
    const h = Math.floor((now - t) / 3600000);
    if (h >= 0 && h < 24) buckets[23 - h] += 1;
  };
  for (const r of readJsonl(path.join(INTEL, 'rulings.jsonl'), 500)) add(Date.parse(r.at));
  for (const e of readJsonl(path.join(INTEL, 'events.jsonl'), 1000)) add(Date.parse(e.time));
  try {
    for (const f of fs.readdirSync(path.join(INTEL, 'turns'))) {
      if (f.startsWith('turn-')) add(fs.statSync(path.join(INTEL, 'turns', f)).mtimeMs);
    }
  } catch { /* no turns dir */ }
  return buckets;
}

/**
 * Everything a task file knows that the operator needs in order to DECIDE
 * (T-0143 D3). The rows used to carry the title alone, so "T-0008 ready
 * Oversight: whatsappbot self-driving wave program" was the whole of what the
 * board could tell him about a task whose file already held the goal, the
 * blocker, five acceptance criteria and its lease. The information existed and
 * the UI threw it away.
 *
 * Only open tasks are ever projected, so this stays a small payload.
 */
function detailOf(t) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    goal: t.goal || '',
    next_action: t.next_action || '',
    blocker: t.blocker || '',
    acceptance_criteria: arr(t.acceptance_criteria),
    depends_on: arr(t.depends_on),
    context_refs: arr(t.context_refs),
    corr: t.corr || '',
    kind: t.kind || '',
    repo: t.repo || '',
    attempt: t.attempt || null,
    contract_mode: (t.contract && t.contract.mode) || null,
    lease: t.lease ? { owner: t.lease.owner || null, expires_at: t.lease.expires_at || null } : null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
  };
}

const RESULT_EXCERPT_CAP = 500;

/**
 * Evidence join (slice 4). The fleet already persists the two work signals —
 * result bodies in a2a-results.jsonl (by corr) and commit identity in
 * head_moved beacon lines (by repo) — but the board never joined them onto the
 * cards, so "¿está actualizado?" was asked out loud instead of read off the
 * screen. Latest line wins on both sides: the files are append-only, so file
 * order IS time order.
 */
function evidenceIndex() {
  const resultByCorr = new Map();
  for (const r of readJsonl(path.join(INTEL, 'a2a-results.jsonl'), 1000)) {
    if (r.event === 'a2a.result' && r.corr) resultByCorr.set(r.corr, r);
  }
  const commitByRepo = new Map();
  for (const e of readJsonl(path.join(INTEL, 'pane-events.jsonl'), 5000)) {
    if (e.event === 'turn-end' && e.head_moved === true && e.repo) commitByRepo.set(e.repo, e);
  }
  return { resultByCorr, commitByRepo };
}

/** The evidence block a decision/in-flight card carries. Nulls are honest: no
 *  join is "nothing recorded", never a stray match from another task. */
function evidenceOf(t, { resultByCorr, commitByRepo }) {
  const r = t.corr ? resultByCorr.get(t.corr) : null;
  const c = commitByRepo.get(t.repo);
  const body = r ? String(r.body || '') : '';
  return {
    last_result: r ? {
      corr: r.corr,
      at: r.time || null,
      from_pane: r.from_pane ?? null,
      v2: r.v2 || null,
      excerpt: body.slice(0, RESULT_EXCERPT_CAP),
      truncated: r.body_truncated === true || body.length > RESULT_EXCERPT_CAP,
    } : null,
    last_commit: c ? { sha: c.head || null, at: c.time || null } : null,
  };
}

function buildState(now = Date.now()) {
  const tasks = loadTasks();
  const report = audit(tasks, now, INTEL);
  const rulings = readJsonl(path.join(INTEL, 'rulings.jsonl'));
  const { unruled, verdict } = evaluate({ findings: report.findings, rulings, now });

  const open = tasks.filter((t) => OPEN_STATES.includes(t.state));
  const evidence = evidenceIndex();
  // Freshness verdict, in-process through the SAME evaluate the 09:05 gate
  // runs (steward-gate pattern): pill and gate can never disagree. Fail-soft:
  // a broken evaluation reports UNKNOWN, never a calm green.
  let freshness;
  try {
    freshness = freshEvaluate({ intelDir: INTEL, tasks, now });
  } catch (e) {
    freshness = { verdict: 'UNKNOWN', stale: [], reason: String(e.message || e).slice(0, 120) };
  }
  const findingByTask = {};
  for (const f of report.findings) findingByTask[f.id] = f;

  // Latest ruling per task — the deferral check below needs the CURRENT
  // judgement, not any historical one.
  const latestRuling = new Map();
  for (const r of rulings) if (r && r.task) latestRuling.set(r.task, r);

  const categoryOf = (t) => (findingByTask[t.id] && findingByTask[t.id].category) || 'awaiting-operator';

  /**
   * A deferred card hides while its ruling still covers it, using the gate's
   * own `rulingCovers` rather than a second, divergent date rule.
   *
   * Scoped to `deferred` ON PURPOSE. `dispatched` also covers (24h grace), and
   * honouring that here would silently hide a live operator gate for a day
   * because someone else dispatched something — making a decision vanish is a
   * worse defect than the one being fixed. Hidden cards are counted back into
   * the payload below so "hidden" never means "gone".
   */
  const deferredHidden = [];
  const isDeferredNow = (t) => {
    const r = latestRuling.get(t.id);
    if (!r || r.ruling !== 'deferred') return false;
    if (!rulingCovers(r, { id: t.id, category: categoryOf(t) }, now)) return false;
    deferredHidden.push({ id: t.id, repo: t.repo, title: t.title, until: r.until || null, why: r.why || '' });
    return true;
  };

  // DECISIONES: operator-gated open tasks — the reason this app exists.
  const decisions = open.filter((t) => gateOf(t) === 'operator').filter((t) => !isDeferredNow(t)).map((t) => ({
    id: t.id,
    repo: t.repo,
    title: t.title,
    state: t.state,
    updated_at: t.updated_at || t.created_at || null,
    question: t.blocker || (t.contract && t.contract._note) || t.next_action
      || (findingByTask[t.id] && findingByTask[t.id].why) || '',
    category: categoryOf(t),
    detail: detailOf(t),
    evidence: evidenceOf(t, evidence),
  })).sort((a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0));

  const lastRuling = rulings.length ? rulings[rulings.length - 1] : null;

  const inFlight = open.filter((t) => ['running', 'review'].includes(t.state)).map((t) => ({
    id: t.id, repo: t.repo, title: t.title, state: t.state,
    owner: (t.lease && t.lease.owner) || null, updated_at: t.updated_at || null,
    detail: detailOf(t),
    evidence: evidenceOf(t, evidence),
  }));

  const rest = open.filter((t) => gateOf(t) !== 'operator' && !['running', 'review'].includes(t.state));
  const byRepo = {};
  for (const t of rest) {
    (byRepo[t.repo] = byRepo[t.repo] || []).push({
      id: t.id, title: t.title, state: t.state, updated_at: t.updated_at || t.created_at || null,
      detail: detailOf(t),
    });
  }

  const gateLog = path.join(INTEL, 'steward-gate-latest.txt');
  const gateAt = fileAge(gateLog);
  let gateText = '';
  try { gateText = fs.readFileSync(gateLog, 'utf8').trim().split('\n')[0]; } catch { /* absent */ }

  const turn = lastTurn();
  const snapshotAt = fileAge(path.join(HERE, '..', 'vault', '_wezbridge', 'session-snapshot.jsonl'));

  return {
    generated_at: new Date(now).toISOString(),
    gate: {
      // Verdict from the LIVE evaluation, age from the last scheduled run.
      verdict,
      unruled: unruled.length,
      last_run_at: gateAt ? new Date(gateAt).toISOString() : null,
      last_run_text: gateText,
    },
    // Slice 4: "¿está actualizado?" answered by the payload, not the operator.
    freshness,
    // Every steward finding that is NOT an operator gate (those are decision
    // cards already), marked ruled/unruled — so a ruling can be made where the
    // problem is seen, before OR after the deadline forces it.
    findings_list: report.findings
      .filter((f) => f.category !== 'awaiting-operator')
      .map((f) => ({
        id: f.id, repo: f.repo, title: f.title || '', category: f.category,
        age_hours: f.age_hours, why: f.why || '',
        unruled: unruled.some((u) => u.id === f.id),
      })),
    last_turn_at: turn ? new Date(turn.at).toISOString() : null,
    snapshot_at: snapshotAt ? new Date(snapshotAt).toISOString() : null,
    decisions,
    // Hidden, not gone: a deferral the operator forgot he made must still be
    // countable from the screen he made it on.
    deferred_hidden: deferredHidden,
    last_ruling: lastRuling,
    in_flight: inFlight,
    by_repo: byRepo,
    routines: routineRuns().slice(0, 12),
    sparkline: sparkline(now),
    open_count: open.length,
  };
}

/**
 * Kitchen chain pill. Only probed when the operator configures the URL —
 * an unconfigured probe reports 'unconfigured', never a guessed 'down'.
 */
async function kitchenHealth() {
  const url = process.env.BOARD_KITCHEN_HEALTH_URL;
  if (!url) return { status: 'unconfigured' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok ? { status: 'up' } : { status: 'down', detail: `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'down', detail: String(e.message || e).slice(0, 80) };
  }
}

// ---------------------------------------------------------------------------
// writes — appends ONLY, schema-exact
// ---------------------------------------------------------------------------

/**
 * Validate a ruling request. Returns {error} or {line} — the EXACT object that
 * will be appended, in the schema the gate and every reader already parse:
 * {task, category, ruling, why, at, source} (+`by` cuando el cliente lo manda).
 * Verb maps 1:1 to `ruling`.
 *
 * `source` es CONSTANTE aca y no viene del body a proposito: es procedencia, no
 * un dato del cliente. Un campo que el que aprieta el boton puede elegir no
 * prueba nada sobre quien escribio la linea. `by` SI viene del cliente porque
 * responde otra pregunta — quien decidio, no que programa escribio — y se
 * declara como lo que es: un dicho, no una prueba.
 *
 * La linea sale de aca y despues pasa por `appendRuling`, que es el unico
 * escritor: este validador arma, el otro valida. Dos schemas sobre el mismo
 * archivo es el defecto T-0294, y el test lo afirma cruzando los dos.
 */
function validateRuling(body, findings, now = Date.now(), tasks = []) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const { task, verb, until, note, by } = body;
  if (by !== undefined && (typeof by !== 'string' || !by.trim() || by.length > 80)) {
    return { error: '`by`, when present, must be a non-empty string (<=80 chars)' };
  }
  if (typeof task !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(task)) return { error: 'invalid task id' };
  if (!VERBS.includes(verb)) return { error: `verb must be one of ${VERBS.join('|')}` };
  if (typeof note !== 'string' || !note.trim() || note.length > 2000) return { error: 'note is required (≤2000 chars)' };
  const line = {
    task,
    category: null,
    ruling: verb,
    why: note.trim(),
    at: new Date(now).toISOString(),
    source: 'board-app',
  };
  // T-0312 (AC2 de FinalOrchestra): toda decision del tablero lleva ACTOR. El
  // tablero es la superficie del operador (token en .env.local, loopback), asi
  // que un tap sin `by` explicito ES del operador: se persiste 'operator', no se
  // omite. Medido 2026-09-02 12:57Z: la linea approved de T-0310 salio sin `by`
  // y el lector canonico de FO (OriginRulingSchema exige actor) la descarto.
  line.by = by !== undefined ? by.trim() : 'operator';
  // T-0312: el corr lo dice la TARJETA, nunca el cliente HTTP. Es lo que
  // deja correlacionar una aprobacion gate=operator con el job que la espera
  // en FinalOrchestra (una decision, dos superficies). Sin corr en la carta,
  // la linea sale sin corr — no se inventa.
  const card = Array.isArray(tasks) ? tasks.find((t) => t && t.id === task) : null;
  if (card && typeof card.corr === 'string' && card.corr.trim()) line.corr = card.corr.trim();
  const finding = findings.find((f) => f.id === task);
  // Un approve responde LA PREGUNTA DEL OPERADOR, no el hallazgo bajo el que el
  // steward archivo la tarjeta ese dia (medido 2026-09-01: un approve previo la
  // deja en decision-unheard y el validador central rechaza approved con esa
  // categoria). deferred/cancelled si siguen la categoria del hallazgo.
  line.category = verb === 'approved' ? 'awaiting-operator' : (finding ? finding.category : 'awaiting-operator');
  if (verb === 'deferred') {
    const t = Date.parse(until);
    if (!Number.isFinite(t)) return { error: 'deferred requires a valid `until` ISO date' };
    if (t <= now) return { error: '`until` must be in the future — a deferral into the past is a shrug' };
    line.until = new Date(t).toISOString();
  }
  return { line };
}

function validateInboxNote(body) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const { kind, text } = body;
  if (!INBOX_KINDS.includes(kind)) return { error: `kind must be one of ${INBOX_KINDS.join('|')}` };
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return { error: 'text is required (≤4000 chars)' };
  return { line: { type: 'operator-action', kind, text: text.trim(), at: new Date().toISOString(), source: 'board-app' } };
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

/**
 * The audit trail the transition leaves IN the task file. A state change whose
 * cause is only in another file is the same defect class as a ruling that never
 * lands: readable from one side only. WHO, WHAT, WHEN and WHY, in the record
 * that changed. Wording follows the line pane-0 wrote by hand on T-0126.
 */
function transitionNote(line, rule) {
  const verb = line.ruling === 'cancelled' ? 'Cancelled' : 'Approved';
  const tail = rule.ungate
    ? ' Un-gated (operator gate cleared) — dispatchable as ordinary ready work.'
    : '';
  return `${verb} by the operator via the fleet board ${line.at}: "${line.why}".${tail}`;
}

/**
 * Remove the operator gate WHEREVER IT LIVES, and prove it is gone using the
 * same predicate that put the card on screen.
 *
 * Found in production 2026-08-16 on the first real approve: T-0145 carries
 * `contract.gate: null` AND a TOP-LEVEL `gate: "operator"`. `gateOf()` reads
 * both (`(t.contract && t.contract.gate) || t.gate`), the original transition
 * wrote only `contract.gate`, so the task moved to `ready` and the card stayed.
 * Reading through one predicate and writing through another is the whole bug.
 * On the live ledger that day: 13 gated tasks used contract.gate, 3 used the
 * top-level field, and 2 used both.
 *
 * fleet-steward paid for the identical mistake on 2026-08-14 — see the "gate
 * lives in EITHER place" comment in its classify(). This is that bug a second
 * time in a second component, which is why the fix below is not just "clear
 * both fields".
 *
 * THE POST-CONDITION IS THE REAL FIX. `ungated` is derived from `gateOf` rather
 * than from which assignments ran, so the writer can never again disagree with
 * the reader: if someone adds a third gate location tomorrow, this reports
 * `ungated: false` and the caller surfaces it, instead of silently leaving an
 * approved card on the board.
 */
function ungateTask(task) {
  const wasGated = gateOf(task) === 'operator';
  const next = { ...task };
  if (next.contract && next.contract.gate === 'operator') {
    next.contract = { ...next.contract, gate: null };
  }
  if (next.gate === 'operator') next.gate = null;
  return { next, wasGated, ungated: wasGated && gateOf(next) !== 'operator' };
}

/**
 * Apply the whitelisted transition for an already-appended ruling.
 *
 * Read-modify-write of the single task JSON: every other field is preserved by
 * spread, so a field this file has never heard of survives untouched. NEVER
 * throws — the caller has already written the ruling, and a thrown error there
 * would turn "the ruling stands, the task did not move" into a 500 that tells
 * the operator nothing about which half happened.
 */
function applyTransition(taskId, line) {
  const rule = TASK_TRANSITION[line.ruling];
  if (!rule) return { applied: false, reason: `${line.ruling} moves no task state` };

  const dir = path.resolve(path.join(INTEL, 'tasks'));
  const file = path.resolve(path.join(dir, `${taskId}.json`));
  // validateRuling already whitelists the id charset, but a whitelist enforced
  // only upstream is one refactor away from being a traversal.
  if (path.dirname(file) !== dir) return { applied: false, error: 'task path outside the tasks directory' };

  try {
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    const from = task.state;
    let next = { ...task, state: rule.state, updated_at: line.at, next_action: transitionNote(line, rule) };
    if (rule.blockedBy) next.blocked_by = rule.blockedBy;
    let ungated = false;
    let stillGated = false;
    if (rule.ungate) {
      const out = ungateTask(next);
      next = out.next;
      ungated = out.ungated;
      // Gated going in, still gated coming out: the state moved but the card
      // will NOT leave the board. That is a half-success and must be reported
      // as one — the operator has to know his approval did not fully land.
      stillGated = out.wasGated && !out.ungated;
    }
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    const result = { applied: true, from, to: rule.state, ungated };
    if (stillGated) result.still_gated = true;
    return result;
  } catch (e) {
    return { applied: false, error: String(e.message || e) };
  }
}

/**
 * Per-IP sliding-window limiter for the append endpoints. rulings.jsonl is the
 * fleet control plane; a stuck retry loop must not be able to flood it.
 */
function makeRateLimiter(max = 10, windowMs = 60000) {
  const hits = new Map();
  return function allow(ip, now = Date.now()) {
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    return true;
  };
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  let file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('SPA not built yet: run `npm run build` in board-app/');
    return;
  }
  const ext = path.extname(file);
  // The SW must never be cached hard or updates wedge; the shell is cached BY the SW.
  const cache = (ext === '.html' || file.endsWith('sw.js')) ? 'no-cache' : 'public, max-age=86400';
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
  fs.createReadStream(file).pipe(res);
}

function log(line) {
  const stamp = new Date().toISOString();
  console.log(`${stamp} ${line}`);
}

/**
 * The census cache is per-SERVER, not per-module, so importing this file never
 * shells out to schtasks — the test suite imports it and must stay hermetic.
 * `censusCache: null` turns the panel off entirely (it then reports `disabled`,
 * which is honest, rather than an empty table that reads as "no tasks").
 */
/**
 * T31 W3 (2026-09-01): tras una transicion terminal el tablero AVISA al dueño
 * inline via el relay de decisiones (src/decision-relay.cjs). Es inyectable y
 * por defecto NULL: los tests no descubren panes ni tocan el _intel vivo, y
 * main() pasa el relay real. Un relay que explota nunca deshace el ruling —
 * el aviso es un mejor esfuerzo; el steward (decision-unheard) es el que grita.
 */
/**
 * THE ruling write path, shared by /api/rulings (tablero, token) and /act
 * (central de avisos, signed link). Returns {status, payload}; never throws.
 */
async function applyRulingBody(body, { relay } = {}) {
  const tasks = loadTasks();
  const report = audit(tasks, Date.now(), INTEL);
  const { error, line } = validateRuling(body, report.findings, Date.now(), tasks);
  if (error) return { status: 400, payload: { error } };
  // ORDER IS THE CONTRACT: the ruling is the source of truth, so it lands
  // before anything else is attempted. Everything below may fail without
  // unwriting it.
  // UN solo escritor de rulings.jsonl (src/rulings.cjs): valida el
  // vocabulario, exige `source` y nunca deja media linea. Si rechaza, la
  // decision NO ocurrio y se dice — nada abajo llego a correr.
  try {
    appendRuling(INTEL, line);
  } catch (e) {
    log(`RULING REFUSED: ${String(e.message)}`);
    return { status: 400, payload: { error: String(e.message) } };
  }
  log(`ruling appended: ${JSON.stringify(line)}`);

  const transition = applyTransition(line.task, line);
  if (transition.applied) {
    log(`task transitioned: ${line.task} ${transition.from} → ${transition.to}${transition.ungated ? ' (un-gated)' : ''}`);
    if (transition.still_gated) {
      log(`STILL GATED: ${line.task} moved to ${transition.to} but gateOf() still reads 'operator' — the card will NOT leave the board`);
    }
  } else if (transition.error) {
    log(`TASK NOT MOVED: ${line.task} — ${transition.error} (the ruling stands)`);
  }

  // Approvals are a GO the orchestrator must act on, so they ALSO land in
  // the inbox its monitor watches. Deferrals/cancellations are complete
  // in themselves — the gate reads them directly.
  if (line.ruling === 'approved') {
    appendLine(path.join(INTEL, 'operator-actions.jsonl'), {
      type: 'operator-action', kind: 'approval',
      text: `Operator approved ${line.task} from the board: ${line.why}`,
      task: line.task, at: line.at, source: 'board-app',
      task_transition: transition,
    });
  }
  let relayOut = null;
  if (transition.applied && typeof relay === 'function') {
    try {
      relayOut = await relay({ intelDir: INTEL, log });
      log(`relay: delivered=${(relayOut.delivered || []).length} queued=${(relayOut.queued || []).length} undeliverable=${(relayOut.undeliverable || []).length}`);
    } catch (e) {
      relayOut = { error: String(e && e.message || e) };
      log(`relay FAILED (the ruling stands): ${relayOut.error}`);
    }
  }
  return { status: 200, payload: { ok: true, line, transition, relay: relayOut } };
}

// ---------------------------------------------------------------------------
// /act — signed action links from the central de avisos (T-0334)
// ---------------------------------------------------------------------------

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sendHtml(res, code, title, inner) {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
main{max-width:520px;margin:0 auto}h1{font-size:20px}p{line-height:1.45}label{display:block;margin:14px 0 6px}
input,textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;background:#181b22;color:#eee}
button{margin-top:18px;width:100%;padding:14px;font-size:17px;border:0;border-radius:10px;background:#3b82f6;color:#fff}
a{color:#8ab4ff}.muted{color:#999;font-size:14px}</style></head><body><main>${inner}</main></body></html>`;
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/** Confirmation page: the tap that arrives from the bandeja never rules by itself. */
function actConfirmPage(res, v, task) {
  const label = ACTION_VERBS[v.verb];
  const title = task ? task.title : '(tarjeta no encontrada en el ledger)';
  const question = task && task.blocker ? `<p>${escHtml(task.blocker)}</p>` : '';
  const untilField = v.verb === 'deferred'
    ? `<label for="until">Hasta (fecha)</label><input id="until" name="until" type="date" required value="${new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10)}">`
    : '';
  const hidden = ['task', 'verb', 'exp', 'sig'].map((k) => `<input type="hidden" name="${k}" value="${escHtml(v[k])}">`).join('');
  sendHtml(res, 200, `${label} ${v.task}`, `<h1>${escHtml(label)} ${escHtml(v.task)}</h1>
<p class="muted">${escHtml(task ? task.repo || '' : '')}</p><p>${escHtml(title)}</p>${question}
<form method="post" action="/act">${hidden}${untilField}
<label for="note">Nota (se guarda como el porqué de la decisión)</label>
<textarea id="note" name="note" rows="3" required>${escHtml(`${label} desde la bandeja`)}</textarea>
<button type="submit">${escHtml(label)} ${escHtml(v.task)}</button></form>
<p class="muted">Enlace firmado por el tablero; vence ${new Date(v.exp * 1000).toLocaleString('es-AR')}.</p>`);
}

async function handleAct(req, res, url, token, { rateLimiter, relay }) {
  let fields;
  if (req.method === 'GET') {
    fields = Object.fromEntries(url.searchParams);
  } else if (req.method === 'POST') {
    if (!rateLimiter(req.socket.remoteAddress || '?')) return sendHtml(res, 429, 'Demasiados intentos', '<h1>Demasiados intentos</h1><p>Esperá un minuto.</p>');
    fields = Object.fromEntries(new URLSearchParams(await readBody(req)));
  } else {
    return sendHtml(res, 405, 'Método no permitido', '<h1>Método no permitido</h1>');
  }
  const v = verifyAction(token, fields);
  if (!v.ok) {
    log(`act REFUSED (${req.method}): ${v.error} task=${fields.task || '?'} verb=${fields.verb || '?'}`);
    return sendHtml(res, 403, 'Enlace inválido', `<h1>Enlace inválido</h1><p>${escHtml(v.error)}. Abrí la decisión desde el tablero.</p>`);
  }
  const task = loadTasks().find((t) => t && t.id === v.task) || null;
  if (req.method === 'GET') return actConfirmPage(res, { ...v, sig: fields.sig }, task);

  const body = { task: v.task, verb: v.verb, note: String(fields.note || '') };
  if (v.verb === 'deferred' && fields.until) {
    // A bare date from the phone form means 09:00 ART (12:00Z) of that day.
    body.until = /^\d{4}-\d{2}-\d{2}$/.test(fields.until) ? `${fields.until}T12:00:00.000Z` : fields.until;
  }
  const out = await applyRulingBody(body, { relay });
  const label = ACTION_VERBS[v.verb];
  if (out.status !== 200) {
    return sendHtml(res, out.status, 'No se aplicó', `<h1>No se aplicó</h1><p>${escHtml(out.payload.error || 'error')}</p><p><a href="javascript:history.back()">Volver</a></p>`);
  }
  const tr = out.payload.transition || {};
  const moved = tr.applied ? `La tarjeta pasó de <b>${escHtml(tr.from)}</b> a <b>${escHtml(tr.to)}</b>.` : 'La decisión quedó registrada.';
  return sendHtml(res, 200, `Listo: ${v.task}`, `<h1>Listo: ${escHtml(label)} ${escHtml(v.task)}</h1><p>${moved}</p>
<p class="muted">Ruling ${escHtml(out.payload.line.ruling)} · by ${escHtml(out.payload.line.by)} · source board-app · ${escHtml(out.payload.line.at)}</p>`);
}

function createServer(token, { rateLimiter = makeRateLimiter(), censusCache = makeCensusCache(), relay = null } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // Signed action links (T-0334): the signature is the credential, so this
      // path sits BEFORE the token check and outside the static SPA.
      if (url.pathname === '/act') return await handleAct(req, res, url, token, { rateLimiter, relay });
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

      if (!tokenOk(req, token)) return sendJson(res, 401, { error: 'missing or wrong x-board-token' });

      if (req.method === 'POST' && !rateLimiter(req.socket.remoteAddress || '?')) {
        return sendJson(res, 429, { error: 'rate limited — appends are capped per minute' });
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = buildState();
        state.kitchen = await kitchenHealth();
        // Six observability sources, each fail-soft and each carrying its own
        // generated_at. Never awaited: the only expensive one (schtasks) is
        // served from an async cache, so this stays a file-reading endpoint.
        state.observability = buildObservability(INTEL, { censusCache });
        return sendJson(res, 200, state);
      }

      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const page = Math.max(0, Number(url.searchParams.get('page') || 0) | 0);
        const all = activityFeed();
        return sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          page,
          page_size: PAGE_SIZE,
          total: all.length,
          items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/rulings') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const out = await applyRulingBody(body, { relay });
        return sendJson(res, out.status, out.payload);
      }

      if (req.method === 'POST' && url.pathname === '/api/orchestrator-inbox') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const { error, line } = validateInboxNote(body);
        if (error) return sendJson(res, 400, { error });
        appendLine(path.join(INTEL, 'operator-actions.jsonl'), line);
        log(`inbox appended: ${JSON.stringify(line)}`);
        return sendJson(res, 200, { ok: true, line });
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    } catch (e) {
      log(`ERROR ${req.method} ${url.pathname}: ${e.message}`);
      return sendJson(res, 500, { error: 'internal error', detail: String(e.message) });
    }
  });
}

if (require.main === module) {
  // Daemon precedent (wezbridge v3.4.3): a non-loopback bind REQUIRES a token.
  // loadToken() self-provisions one, but if that fails for any reason we fall
  // back to loopback rather than ever exposing naked endpoints on the LAN.
  let token = null;
  try { token = loadToken(); } catch (e) { log(`token unavailable (${e.message})`); }
  const bind = token ? '0.0.0.0' : '127.0.0.1';
  const server = createServer(token || crypto.randomBytes(24).toString('base64url'), { relay: liveRelay });
  server.listen(PORT, bind, () => {
    log(`fleet-board-app listening on ${bind}:${PORT} (intel: ${INTEL})`);
    log(token ? `token file: ${ENV_FILE}` : 'NO TOKEN FILE — loopback only, API unusable until .env.local exists');
  });
}

/**
 * El relay real: pane-discovery + verified-send + ledger CLI, mismas piezas que
 * scripts/decision-relay.cjs --once. Se arma perezosamente para que requerir
 * este modulo (tests) no cargue la discovery.
 */
async function liveRelay({ intelDir, log: relayLog = log }) {
  const { relayOnceWith } = require(path.join(HERE, '..', 'src', 'decision-relay.cjs'));
  const discovery = require(path.join(HERE, '..', 'src', 'pane-discovery.cjs'));
  const send = require(path.join(HERE, '..', 'src', 'verified-send.cjs'));
  const { execFileSync } = require('node:child_process');
  const ledgerBin = path.join(process.env.WEZBRIDGE_LEDGER_DIR || path.join(intelDir, '..', '_docs-curation'), 'ledger.cjs');
  const runLedger = (args) => {
    const out = execFileSync(process.execPath, [ledgerBin, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    try { return JSON.parse(out); } catch { return out; }
  };
  return relayOnceWith({ intelDir, discoverPanes: discovery.discoverPanes, send, runLedger, log: relayLog });
}

module.exports = {
  createServer, liveRelay, loadToken, buildState, activityFeed, makeRateLimiter,
  validateRuling, validateInboxNote, applyTransition, ungateTask, detailOf, applyRulingBody,
  VERBS, INBOX_KINDS, PAGE_SIZE, TASK_TRANSITION,
};
