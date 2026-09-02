#!/usr/bin/env node
'use strict';
/**
 * fleet-steward.cjs — periodic staleness audit of the fleet ledger.
 *
 * Why this exists: on 2026-07-29 the operator's board carried five tasks that
 * were finished, superseded, or answered weeks of session-time earlier and had
 * simply never been closed. Their question was the right one — "how can we
 * prevent this? maybe a steward who checks it periodically?" A human (or a
 * reasoning pane) noticing is not a mechanism: panes die, sessions compact, and
 * the one thing guaranteed not to notice a forgotten task is the process that
 * forgot it.
 *
 * What it does NOT do, deliberately: close anything. Every category below is a
 * judgement call — a task idle for three days may be correctly parked, and a
 * gated task waiting on the operator is waiting BY DESIGN. Auto-closing is how
 * real work disappears silently, which is the same defect family as the board
 * that showed "Needs Attention: 0". The steward's whole job is to make the
 * backlog impossible to forget, and to leave the deciding to the operator.
 *
 * Usage:
 *   node fleet-steward.cjs               # report to stdout
 *   node fleet-steward.cjs --json        # machine-readable
 *   node fleet-steward.cjs --notify      # also A2A the report to the reasoner pane
 *
 * Durable scheduling: register with Windows Task Scheduler (see --install-hint).
 * ScheduleWakeup/CronCreate/loop are all session-bound and die with the pane.
 */
const fs = require('node:fs');
const path = require('node:path');
const { taskIdFromCorr } = require('../src/a2a-intel.cjs');
const { auditRoutines } = require('./routine-audit.cjs');
const { reconcileLeases, liveCensus: reconcilerCensus } = require('./lease-reconcile.cjs');
const { lintSpecRefs, lintRulings } = require('./dispatch-lint.cjs');
const { FINDING_CATEGORY } = require('../src/rulings.cjs');

const HOURS = (h) => h * 3600 * 1000;

/** Thresholds, in hours. Deliberately generous — a noisy steward gets ignored. */
const RULES = {
  idleQueued: 48,      // queued/ready, nobody picked it up
  staleRunning: 6,     // running with no update — worker probably died
  staleReview: 24,     // finished work waiting on a reviewer
  awaitingOperator: 24, // gated + blocked: the operator owes an answer
  staleFailed: 12,     // failed and not retried or triaged
  // Hard ceiling on the sibling-corr channel (added 2026-08-18 after an
  // independent review). Sibling activity may DEFER the abandonment alarm; it
  // may never cancel it. Without this, a task whose corr stays busy is
  // suppressed forever — the reviewer reproduced one dead for 208 days still
  // reporting clean. Trading a false RED for a permanent false GREEN is a
  // strictly worse defect, because the gate exists to contradict a false
  // all-clear and silence is the one direction it must never fail in.
  siblingCeiling: 168, // 7 days with no sign of life of the task's OWN
};

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR
    || path.join(__dirname, '..', '..', '_intel');
}

/**
 * What the LEDGER counts as a task file — `_docs-curation/ledger.cjs ::
 * allTasks()`. Mirrored here so the steward can name the difference between
 * the two views instead of merely having one.
 *
 * WHY THE TWO LOADERS DELIBERATELY DIFFER (T-0290, 2026-08-28). The ledger MUST
 * be strict: `nextId()` does `parseInt(id.slice(2), 10)` over everything
 * `allTasks()` returns, so admitting a non-numeric id mints `T-NaN` for the
 * whole fleet. The steward MUST stay lax: it is the fleet's alarm, and an alarm
 * that narrows its own input fails GREEN on exactly the files nobody else can
 * see — the one direction this gate must never fail in.
 *
 * So they differ, on purpose, in the safe direction: the steward's view is a
 * SUPERSET of the ledger's, and every file in the gap is reported as an
 * `ungoverned-task-file` finding. That is the fix for the real defect, which was
 * never "two criteria" but "the gap was silent": `raiseStall` wrote
 * `T-LOOP-STALL.json`, the ledger never listed it, the steward read it without
 * comment, and the alert of last resort reached nobody for three days.
 */
const TASK_FILE = /^T-\d{4}\.json$/;

function taskFiles(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function loadTasks() {
  const dir = path.join(intelDir(), 'tasks');
  const out = [];
  for (const f of taskFiles(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * The gap between the two views: files the steward reads that the ledger cannot
 * govern. Never silent — that silence WAS the defect.
 */
function auditTaskFiles(dir = intelDir(), now = Date.now()) {
  const tasksDir = path.join(dir, 'tasks');
  const findings = [];
  for (const f of taskFiles(tasksDir)) {
    if (!f.endsWith('.json') || TASK_FILE.test(f)) continue;
    let age = 0;
    try { age = hours(now - fs.statSync(path.join(tasksDir, f)).mtimeMs); } catch { /* unstattable */ }
    findings.push({
      category: 'ungoverned-task-file',
      id: f.replace(/\.json$/, ''),
      repo: 'fleet',
      age_hours: age,
      owner: null,
      title: f,
      why: `tasks/${f} is not a T-NNNN.json card, so the ledger cannot list, update, lease or rule on it. `
        + 'Whatever wrote it bypassed ledger.cjs create; re-file it as a real card or delete it.',
    });
  }
  return findings;
}

/** Rulings feed the W2 lint. Unparseable lines are skipped, absent file is zero. */
function loadRulings(dir = intelDir()) {
  try {
    return fs.readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const hours = (ms) => Math.round(ms / 3600000);

/**
 * Lease expiry, or null when unleased.
 *
 * The field is `expires_at`. v1 read `lease.until`, a name invented to match a
 * hand-written fixture, so the abandoned-lease rule was dead code against every
 * real task while its unit test passed — the test validated the bug. Any field
 * read here must be confirmed against a record on disk, never assumed.
 */
function leaseExpiry(task) {
  const raw = task.lease && task.lease.expires_at;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

const ms = (v) => { const t = new Date(v || 0).getTime(); return Number.isFinite(t) ? t : 0; };

/**
 * When this task last MOVED — a real FSM transition, nothing else.
 *
 * Deliberately does NOT read `updated_at`, except as a last resort for records
 * so old they predate both other fields. `updated_at` means "the file was
 * written", and reading it as movement is what let annotation clear the gate:
 * on 2026-08-16 writing triage notes onto 8 stale tasks dropped their measured
 * idle age from 300-478h to ~0h and the findings fell 13 -> 3 with no work done
 * (T-0144).
 *
 * The trap this avoids in the other direction: measuring from `created_at`
 * outright would flag legitimately reopened work (done -> ready) as instantly
 * ancient. `state_changed_at` is stamped by ledger.cjs on the reopen, so the
 * clock restarts where it should. `created_at` is only the fallback for legacy
 * records that have never transitioned since the stamp was introduced — for a
 * task sitting untouched in `ready` since it was filed, that is the right
 * answer anyway.
 */
function lastTransition(task) {
  return Math.max(ms(task.state_changed_at), 0)
    || Math.max(ms(task.created_at), 0)
    || ms(task.updated_at);
}

/**
 * When someone last showed a sign of LIFE on this work — a different question
 * from `lastTransition`, and the two must not be collapsed.
 *
 * "Has this card moved?" and "is the worker alive?" have different right
 * answers, and answering the second with the first is what made the steward go
 * RED on healthy work: on 2026-08-17 T-0146 was reported as an abandoned lease
 * at 14h while fifteen PRs were being reviewed and merged under it, because
 * nothing renews a lease during continuous work (T-0164). abandoned-lease was
 * carrying two meanings — the owner died, and the owner is alive and busy — and
 * only the first deserves an alarm. Every false RED spends the credibility of
 * the one gate whose job is to contradict a false all-clear.
 *
 * The four channels progress is legible on, all already on disk:
 *   1. the task's own FSM transitions
 *   2. _intel/runs/<id>/log.md — long oversight loops report here and can go
 *      many hours between ledger transitions (T-0008, at pass 50 with 38h of
 *      ledger silence)
 *   3. a ruling recorded against the task
 *   4. DECLARED CHILD tasks transitioning — a parent is worked THROUGH its
 *      children, which is precisely how T-0146 looked dead while eleven of
 *      them closed under it. Sharing a corr is NOT the relationship (T-0167).
 *
 * Channel 4 is scoped to this question ON PURPOSE. It must never suppress
 * `idle`, because "a sibling moved" is not evidence that anyone picked THIS one
 * up — letting it count there would hide a live programme's own untouched
 * backlog behind its siblings' progress.
 */
/**
 * Channels 1-3: signs of life belonging to THIS task. Kept separate from the
 * sibling channel because only these can hold the alarm off indefinitely — they
 * are evidence about the task itself, not about its neighbours.
 */
function ownProgress(task, dir = intelDir(), ctx = null) {
  const stamps = [lastTransition(task)];
  try {
    stamps.push(fs.statSync(path.join(dir, 'runs', task.id, 'log.md')).mtimeMs);
  } catch { /* no run log — the other channels stand alone */ }
  const c = ctx || buildContext([task], dir);
  stamps.push(c.rulingAt.get(task.id) || 0);
  return Math.max(...stamps.filter(Number.isFinite));
}

function lastProgress(task, now, dir = intelDir(), ctx = null) {
  const own = ownProgress(task, dir, ctx);
  // A PARENT is worked THROUGH its children, so its children's transitions are
  // evidence its owner is alive. Nothing else is.
  //
  // v1 keyed this on a shared `corr`, which conflated two different things: an
  // umbrella genuinely worked through its children (T-0146, dead-looking while
  // eleven children closed under it) and a task that merely SHARES a corr with
  // an active thread. The second got its alarm suppressed by work it had no
  // relationship to — a reviewer reproduced one dead 208 days still reading
  // clean (T-0164), and a 168h ceiling was added as a net.
  //
  // T-0167 removes the guess instead of bounding it: children now DECLARE their
  // parent, so the relationship is a fact rather than an inference. A task with
  // no declared children gets no sibling credit at all, which fails toward more
  // alarms and never toward silence.
  //
  // The ceiling STAYS as defence in depth. If a parent's own channels go silent
  // past it, its children's noise no longer covers for it.
  if (!ctx) return own;
  const childAt = ctx.childAt.get(task.id) || 0;
  if (!childAt) return own;
  if (now - own > HOURS(RULES.siblingCeiling)) return own;
  return Math.max(own, childAt);
}

/**
 * Pre-index the two cross-record channels once per audit rather than per task:
 * rulings are one file scan, children are one pass over the task list.
 *
 * `childAt` is keyed by PARENT id, not by corr. A task earns its children's
 * liveness only if those children point back at it with `parent`. Sharing a
 * corr is no longer enough, because a corr is a conversation thread and a
 * parent is a work relationship — they were never the same claim.
 */
function buildContext(tasks, dir = intelDir()) {
  const rulingAt = new Map();
  for (const r of loadRulings(dir)) {
    const at = ms(r.at);
    if (r.task && at > (rulingAt.get(r.task) || 0)) rulingAt.set(r.task, at);
  }
  const childAt = new Map();
  for (const t of tasks) {
    if (!t.parent) continue;
    const at = lastTransition(t);
    if (at > (childAt.get(t.parent) || 0)) childAt.set(t.parent, at);
  }
  return { rulingAt, childAt };
}

const ageMs = (task, now) => now - lastTransition(task);

/**
 * proposal-unledgered (2026-08-20): a report that proposes work emits
 * `PROPOSAL:<slug>` in its final turn (the beacon captures it into
 * pane-events.jsonl, same convention as GATE:). Two of four artifact proposals
 * were lost on 2026-08-18 because nothing checked they ever became ledger
 * tasks — an idea that lives only in an HTML file is forgotten by design.
 *
 * The check: a PROPOSAL marker within the last 72h with NO `task.created`
 * event for the same repo at-or-after the marker time is a finding. It flows
 * through the existing loop entirely — steward report, 24h gate deadline,
 * board findings, rulings clear it. No new surface, no new file.
 *
 * The 72h window bounds the SCAN, the gate bounds the RESPONSE: past the
 * window the marker is history, and re-flagging forever would train everyone
 * to ignore the category. Absent/unreadable streams yield zero findings —
 * same fail-soft posture as loadRulings.
 */
const PROPOSAL_WINDOW_HOURS = 72;
const PROPOSAL_MARKER = /^PROPOSAL:([a-z0-9-]+)$/i;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function auditProposals(dir = intelDir(), now = Date.now()) {
  // Earliest in-window emission per repo+slug: re-emits must not reset the
  // clock, and a task created after the FIRST ask covers the later echoes too.
  const proposals = new Map();
  for (const e of readJsonl(path.join(dir, 'pane-events.jsonl'))) {
    if (!e || !Array.isArray(e.markers) || !e.repo) continue;
    const at = ms(e.time);
    if (!at || at > now || now - at > HOURS(PROPOSAL_WINDOW_HOURS)) continue;
    for (const marker of e.markers) {
      const hit = PROPOSAL_MARKER.exec(String(marker));
      if (!hit) continue;
      const slug = hit[1].toLowerCase();
      const key = `${e.repo}|${slug}`;
      const prev = proposals.get(key);
      if (!prev || at < prev.at) proposals.set(key, { repo: e.repo, slug, at });
    }
  }
  if (!proposals.size) return [];

  const createdAt = new Map();   // repo -> latest task.created time
  for (const e of readJsonl(path.join(dir, 'events.jsonl'))) {
    if (!e || e.event !== 'task.created' || !e.repo) continue;
    const at = ms(e.time);
    if (at > (createdAt.get(e.repo) || 0)) createdAt.set(e.repo, at);
  }

  const findings = [];
  for (const p of proposals.values()) {
    if ((createdAt.get(p.repo) || 0) >= p.at) continue;   // it became a task
    findings.push({
      id: `proposal:${p.slug}`, repo: p.repo, state: null,
      title: `PROPOSAL:${p.slug}`, owner: null, age_hours: hours(now - p.at),
      category: 'proposal-unledgered',
      why: `a report proposed work (PROPOSAL:${p.slug}) and no task has been created for ${p.repo} since — file it or rule it dead`,
    });
  }
  return findings;
}

/**
 * result-unlinked (W2, 2026-09-01): un `type=result` llego, se registro en
 * a2a-results.jsonl, y NO pudo moverse a ninguna tarjeta — corr ambiguo, sin
 * tarjeta, tarjeta en un estado que no admite el movimiento, o el ledger fallo.
 * El linker (src/result-linker.cjs) emite `result.unlinked {corr, reason}`; sin
 * esto ese evento vive en events.jsonl, que nadie mira, y la consecuencia es la
 * peor de todas: trabajo TERMINADO que el tablero sigue mostrando como en curso
 * (o directamente no muestra). Misma forma que proposal-unledgered — ventana de
 * 72h para el SCAN, el gate acota la RESPUESTA — y el mismo fail-soft: streams
 * ausentes o ilegibles dan cero hallazgos.
 *
 * El repo sale de la tarjeta cuando el corr resuelve a una; si no, 'unknown'.
 * Inventarle un dueno seria peor: lo mandaria al board de otro.
 */
const RESULT_UNLINKED_WINDOW_HOURS = 72;

function auditResultLinks(dir = intelDir(), now = Date.now()) {
  // Primer intento fallido por corr: los reintentos del cursor no reinician el
  // reloj ni multiplican el item.
  const first = new Map();
  for (const e of readJsonl(path.join(dir, 'events.jsonl'))) {
    if (!e || e.event !== 'result.unlinked' || !e.corr) continue;
    const at = ms(e.time);
    if (!at || at > now || now - at > HOURS(RESULT_UNLINKED_WINDOW_HOURS)) continue;
    const prev = first.get(e.corr);
    if (!prev || at < prev.at) first.set(e.corr, { corr: e.corr, at, reason: e.reason || 'sin razon declarada' });
  }
  if (!first.size) return [];

  const findings = [];
  for (const r of first.values()) {
    const id = taskIdFromCorr(r.corr);
    let card = null;
    if (id) {
      try { card = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', `${id}.json`), 'utf8')); } catch { card = null; }
    }
    findings.push({
      id: `result:${r.corr}`,
      repo: (card && card.repo) || 'unknown',
      state: card ? card.state : null,
      title: card ? card.title : `result corr=${r.corr}`,
      owner: (card && card.lease && card.lease.owner) || null,
      age_hours: hours(now - r.at),
      category: 'result-unlinked',
      why: `un type=result llego y NO movio ninguna tarjeta (${r.reason}) — el trabajo puede estar terminado y el tablero no lo sabe; nombra la tarjeta en el corr o corregi el estado`,
    });
  }
  return findings;
}

/**
 * decision-unheard (W3, 2026-09-01): el operador DECIDIO y nadie se entero.
 *
 * El tablero escribe el ruling y des-gatea la tarjeta, pero hasta W3 nada le
 * avisaba al pane dueno ni a Eve: la decision quedaba en rulings.jsonl, que es
 * un archivo que nadie mira en vivo. Una autoridad que se ejerce y no llega es
 * indistinguible de una que nunca se ejercio, y esa es la razon por la que el
 * operador terminaba repitiendo aprobaciones por el composer.
 *
 * La regla: ruling "approved" o "cancelled", CON procedencia (campo `source`),
 * sobre un task T-NNNN, posterior a la EPOCA — y sin ningun evento
 * `decision.delivered` del mismo task con `time >= ruling.at`.
 *
 * Esa comparacion `>=` es el corazon del guard y no es cosmetica: sin ella un
 * delivered viejo cubriria para siempre cada re-aprobacion de la misma tarjeta,
 * y el hallazgo se apagaria solo justo en el caso que existe para cazar. Es la
 * misma leccion que closingRulingAfterMove: comparar contra un HECHO fechado,
 * nunca contra la mera existencia de un evento.
 *
 * Las lineas legacy (338, sin `source`) no disparan nada: la epoca y el campo
 * de procedencia son los dos frenos que impiden retro-marcar el historial.
 */
const DECISION_EPOCH = Date.parse('2026-09-01T00:00:00.000Z');
const ACTIONABLE_RULINGS = new Set(['approved', 'cancelled']);

function auditDecisions(dir = intelDir(), now = Date.now()) {
  // Por task, el ruling sin cubrir MAS VIEJO: el reloj del hallazgo cuenta
  // desde la primera decision que nadie escucho, no desde la ultima.
  const pending = new Map();
  for (const r of loadRulings(dir)) {
    if (!r || !r.source || !ACTIONABLE_RULINGS.has(r.ruling)) continue;
    if (!/^T-[0-9]{4}$/.test(String(r.task || ""))) continue;
    const at = ms(r.at);
    if (!at || at < DECISION_EPOCH || at > now) continue;
    const prev = pending.get(r.task);
    if (!prev || at < prev.at) pending.set(r.task, { task: r.task, at, ruling: r.ruling, source: r.source, rawAt: r.at });
  }
  if (!pending.size) return [];

  const deliveredAt = new Map();   // task -> ultimo decision.delivered
  for (const e of readJsonl(path.join(dir, "events.jsonl"))) {
    if (!e || e.event !== "decision.delivered" || !e.task) continue;
    const at = ms(e.time);
    if (at > (deliveredAt.get(e.task) || 0)) deliveredAt.set(e.task, at);
  }

  const findings = [];
  for (const d of pending.values()) {
    if ((deliveredAt.get(d.task) || 0) >= d.at) continue;   // alguien la entrego DESPUES: cubierta
    let card = null;
    try { card = JSON.parse(fs.readFileSync(path.join(dir, "tasks", d.task + ".json"), "utf8")); } catch { card = null; }
    findings.push({
      id: d.task,
      repo: (card && card.repo) || "unknown",
      state: card ? card.state : null,
      title: card ? card.title : d.task,
      owner: (card && card.lease && card.lease.owner) || null,
      age_hours: hours(now - d.at),
      category: "decision-unheard",
      why: d.ruling + " by " + d.source + " at " + d.rawAt + "; no decision.delivered since — el dueno (y Eve) no se enteraron: corre scripts/decision-relay.cjs --once o avisale a mano",
    });
  }
  return findings;
}

/**
 * Classify one task. Returns null when it needs no attention.
 * `now` is injected so this is testable without clock mocking.
 */
function classify(task, now, dir = intelDir(), ctx = null) {
  const age = ageMs(task, now);
  // The gate lives in EITHER place, and reading one is a real bug found
  // 2026-08-14 by rendering the board: T-0072 (pather) carries a top-level
  // `gate: "operator"` with `contract: null`, so it was classified
  // `blocked-not-gated` — a category with a 48h deadline — when it is in fact
  // waiting on the operator BY DESIGN and should never expire. The effect was
  // doubly wrong: it nagged about a correct state, and it stayed out of the
  // "waiting on you" list where the operator would have seen the question.
  const gated = (task.contract && task.contract.gate) === 'operator' || task.gate === 'operator';
  // `owner` is the lease holder, and it is the correct routing key for any
  // follow-up — NOT the repo. A staleness reconcile for T-0008 was sent to the
  // whatsappbot pane because the task names that repo, while the lease was held
  // by the orchestrator itself: it chased another agent about its own abandoned
  // work. A pane cannot transition a task it holds no lease on, so a report
  // that omits the owner routes every follow-up to the wrong place.
  const common = {
    id: task.id, repo: task.repo, state: task.state, title: task.title,
    owner: (task.lease && task.lease.owner) || null, age_hours: hours(age),
  };

  switch (task.state) {
    case 'blocked':
      if (gated && age > HOURS(RULES.awaitingOperator)) {
        return { ...common, category: 'awaiting-operator', why: task.blocker || 'operator gate, no ruling recorded' };
      }
      if (!gated && age > HOURS(RULES.idleQueued)) {
        return { ...common, category: 'blocked-not-gated', why: task.blocker || 'blocked with no gate and no stated blocker' };
      }
      return null;
    case 'running': {
      // The lease outranks age in BOTH directions. Expired means the worker
      // that promised to finish this is gone — stronger evidence than any
      // amount of quiet. Still live means someone is on it, and a long-running
      // batch that simply has not hit a checkpoint is not a problem: flagging
      // it would train the operator to ignore the steward, which costs more
      // than the occasional missed stall.
      const until = leaseExpiry(task);
      // THIS is the "is the worker alive" question, and the ONLY branch that
      // asks it — so it is the only branch that reads progress rather than
      // movement. An expired lease alone is NOT proof of abandonment: leases
      // are minute-bounded and owners routinely outlive them on long loops
      // without harm. Only an expired lease AND silence on every progress
      // channel means the owner is actually gone.
      const quiet = now - lastProgress(task, now, dir, ctx);
      if (until !== null && until < now) {
        // The alarm is narrowed, never softened into silence: with no progress
        // evidence anywhere this still goes RED, because a genuinely dead
        // worker is exactly what this category is for.
        return quiet > HOURS(RULES.staleRunning)
          ? { ...common, age_hours: hours(quiet), category: 'abandoned-lease', why: `lease expired ${hours(now - until)}h ago (owner ${task.lease.owner || '?'}) and no progress on any channel since: no FSM transition, no run log, no ruling, no declared child task moved` }
          : null;
      }
      if (until !== null) return null;   // live lease: someone is on it
      if (quiet > HOURS(RULES.staleRunning)) return { ...common, age_hours: hours(quiet), category: 'stale-running', why: 'running with no lease and no progress on ledger, run log, rulings or declared child tasks' };
      return null;
    }
    case 'review':
      return age > HOURS(RULES.staleReview)
        ? { ...common, category: FINDING_CATEGORY.staleReview, why: 'work finished, review never happened' } : null;
    case 'failed':
      return age > HOURS(RULES.staleFailed)
        ? { ...common, category: 'stale-failed', why: 'failed and neither retried nor triaged' } : null;
    case 'queued':
    case 'ready':
      return age > HOURS(RULES.idleQueued)
        ? { ...common, category: 'idle', why: 'nobody has picked this up' } : null;
    default:
      return null; // done / cancelled are terminal
  }
}

function audit(tasks, now = Date.now(), dir = intelDir(), opts = {}) {
  // Two sources, one findings stream. Scheduled routines write evidence files
  // that nothing used to read; merging them here means they inherit the gate
  // rather than needing a second enforcement chain that could rot separately.
  // Built once from the whole task list: the sibling-corr channel is a property
  // of the SET, so a per-task classify() cannot derive it alone.
  const ctx = buildContext(tasks, dir);
  const findings = [
    ...tasks.map((t) => classify(t, now, dir, ctx)).filter(Boolean),
    ...auditRoutines(dir, now),
    // W1/W2 hygiene lints (2026-08-16 retro): unspecced dispatches and rulings
    // whose value never landed in a file. Epoch-gated inside the module so the
    // pre-existing backlog is never retro-flagged.
    ...lintSpecRefs(tasks, now),
    ...lintRulings(loadRulings(dir), now),
    // Proposals that never became tasks (2026-08-20): same enforcement loop,
    // read from the beacon stream instead of the ledger.
    ...auditProposals(dir, now),
    // Results que llegaron y no movieron nada (W2, 2026-09-01): el gemelo del
    // anterior por el otro extremo del loop — aquel mira trabajo que nunca se
    // abrio, este mira trabajo que se cerro y nadie registro.
    ...auditResultLinks(dir, now),
    // Decisiones del operador que no llegaron a nadie (W3): el otro extremo del
    // mismo loop — aquel mira results que no movieron nada, este mira ordenes
    // que no salieron del archivo.
    ...auditDecisions(dir, now),
    // Files in tasks/ that neither loader governs (T-0290).
    ...auditTaskFiles(dir, now),
    // T-0272: ¿el owner de cada lease abierta sigue existiendo? El vencimiento
    // (abandoned-lease, arriba) pregunta "¿tardó demasiado?"; esto pregunta
    // "¿el pane que la sostiene existe y es la misma sesión?" — pane-39 murió
    // con la lease de T-0199 viva y el tablero mintió "running" 22 horas.
    // El censo se INYECTA (opts.census): el camino auto (main/steward-gate) lo
    // mide en vivo; una llamada de librería sin censo no reconcilia, porque un
    // censo medido a medias es peor que declarar que no se midió.
    ...('census' in opts ? reconcileLeases(tasks, opts.census, now, { executorLiveness: opts.executorLiveness }) : []),
  ];
  // Operator-owed items first: those are the ones that block other people's work.
  // routine-silent ranks high because a routine that stopped firing invalidates
  // every later "clean" reading, the way a dead sensor does.
  const rank = {
    // result-unlinked va arriba a proposito: trabajo TERMINADO que el tablero no
    // registro es una mentira activa del instrumento, no backlog.
    'awaiting-operator': 0, 'decision-unheard': 1, 'result-unlinked': 1, 'dead-owner-lease': 1, 'lease-census-unavailable': 1, 'lease-owner-unverifiable': 1,
    'abandoned-lease': 2, 'routine-silent': 2, 'stale-running': 3,
    'routine-void': 4, 'routine-findings': 5, 'stale-review': 6, 'stale-failed': 7,
    // Hygiene before backlog-idle: an unspecced dispatch is about to waste a
    // builder session; an unlanded value is a live near-miss. Both outrank
    // "nobody picked this up yet".
    'dispatch-unspecced': 8, 'ruling-unlanded': 9, 'proposal-unledgered': 10,
    // An ungoverned file outranks backlog noise: it is invisible to the board
    // by construction, so nothing else will ever raise it.
    'ungoverned-task-file': 11,
    'blocked-not-gated': 12, idle: 13,
  };
  const order = (f) => (rank[f.category] === undefined ? 99 : rank[f.category]);
  findings.sort((a, b) => (order(a) - order(b)) || (b.age_hours - a.age_hours));
  const byCategory = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.state)).length;
  return { generated_at: new Date(now).toISOString(), open, findings, byCategory };
}

function render(report) {
  if (!report.findings.length) {
    return `fleet-steward: ${report.open} open tasks, none stale. No routine output pending. Nothing owed.`;
  }
  // Not "N of M open tasks" any more: routine findings are not tasks, and a
  // count that mixes them would misreport the backlog in both directions.
  const lines = [`fleet-steward: ${report.findings.length} item(s) need a look (${report.open} open tasks).`, ''];
  let last = null;
  for (const f of report.findings) {
    if (f.category !== last) { lines.push(`[${f.category}]`); last = f.category; }
    lines.push(`  ${f.id} | ${f.repo} | ${f.age_hours}h | owner: ${f.owner || 'unleased'} | ${String(f.title || '').slice(0, 44)}`);
    lines.push(`      ${f.why}`);
  }
  lines.push('', 'The steward never closes anything — every line above is yours to rule on.');
  return lines.join('\n');
}

module.exports = {
  classify, audit, render, RULES, loadTasks, loadRulings, auditTaskFiles, TASK_FILE,
  lastTransition, lastProgress, ownProgress, buildContext, auditProposals, auditResultLinks, auditDecisions,
};

if (require.main === module) {
  // El camino que corre solo (schtask + steward-gate) SIEMPRE reconcilia
  // leases contra el censo vivo. liveCensus() puede devolver null (mux caido):
  // eso se pasa igual, y el reconciliador lo convierte en hallazgo ruidoso.
  // T31 check 8: las leases eve:<job> se verifican contra el control plane; sin el, unverifiable.
  const report = audit(loadTasks(), Date.now(), intelDir(), { census: reconcilerCensus(), executorLiveness: require('./lease-reconcile.cjs').eveLivenessFromControlPlane() });
  process.stdout.write(process.argv.includes('--json')
    ? JSON.stringify(report, null, 2) + '\n'
    : render(report) + '\n');
  // Non-zero only when the operator personally owes something, so a scheduled
  // run's exit code is a useful signal rather than always-green noise.
  process.exit(report.byCategory['awaiting-operator'] ? 1 : 0);
}
