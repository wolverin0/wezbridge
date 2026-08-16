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
const { auditRoutines } = require('./routine-audit.cjs');
const { lintSpecRefs, lintRulings } = require('./dispatch-lint.cjs');

const HOURS = (h) => h * 3600 * 1000;

/** Thresholds, in hours. Deliberately generous — a noisy steward gets ignored. */
const RULES = {
  idleQueued: 48,      // queued/ready, nobody picked it up
  staleRunning: 6,     // running with no update — worker probably died
  staleReview: 24,     // finished work waiting on a reviewer
  awaitingOperator: 24, // gated + blocked: the operator owes an answer
  staleFailed: 12,     // failed and not retried or triaged
};

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR
    || path.join(__dirname, '..', '..', '_intel');
}

function loadTasks() {
  const dir = path.join(intelDir(), 'tasks');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip unreadable */ }
  }
  return out;
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

/**
 * When this task last showed a sign of life.
 *
 * The ledger is NOT the only channel work is reported on: long-running
 * oversight loops append to _intel/runs/<id>/log.md and may go many hours
 * between ledger state transitions. A staleness detector that reads only the
 * ledger is blind to the channel where the work actually shows up, so it flags
 * healthy long tasks every single run — and a steward that cries wolf is a
 * steward the operator stops reading. Diagnosed by pane-5 on T-0008, which was
 * at pass 50 of an active loop while the ledger had not moved in 38h.
 */
function lastActivity(task, dir = intelDir()) {
  const stamps = [new Date(task.updated_at || task.created_at || 0).getTime()];
  try {
    stamps.push(fs.statSync(path.join(dir, 'runs', task.id, 'log.md')).mtimeMs);
  } catch { /* no run log — ledger timestamp stands alone */ }
  return Math.max(...stamps.filter(Number.isFinite));
}

const ageMs = (task, now, dir) => now - lastActivity(task, dir);

/**
 * Classify one task. Returns null when it needs no attention.
 * `now` is injected so this is testable without clock mocking.
 */
function classify(task, now, dir = intelDir()) {
  const age = ageMs(task, now, dir);
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
      // An expired lease alone is NOT proof of abandonment: leases are minute-
      // bounded and owners routinely outlive them on long loops without harm.
      // Only an expired lease AND no recent sign of life on either channel
      // means the owner is actually gone.
      if (until !== null && until < now) {
        return age > HOURS(RULES.staleRunning)
          ? { ...common, category: 'abandoned-lease', why: `lease expired ${hours(now - until)}h ago (owner ${task.lease.owner || '?'}) and no activity since` }
          : null;
      }
      if (until !== null) return null;   // live lease: someone is on it
      if (age > HOURS(RULES.staleRunning)) return { ...common, category: 'stale-running', why: 'running with no lease and no activity on ledger or run log' };
      return null;
    }
    case 'review':
      return age > HOURS(RULES.staleReview)
        ? { ...common, category: 'stale-review', why: 'work finished, review never happened' } : null;
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

function audit(tasks, now = Date.now(), dir = intelDir()) {
  // Two sources, one findings stream. Scheduled routines write evidence files
  // that nothing used to read; merging them here means they inherit the gate
  // rather than needing a second enforcement chain that could rot separately.
  const findings = [
    ...tasks.map((t) => classify(t, now, dir)).filter(Boolean),
    ...auditRoutines(dir, now),
    // W1/W2 hygiene lints (2026-08-16 retro): unspecced dispatches and rulings
    // whose value never landed in a file. Epoch-gated inside the module so the
    // pre-existing backlog is never retro-flagged.
    ...lintSpecRefs(tasks, now),
    ...lintRulings(loadRulings(dir), now),
  ];
  // Operator-owed items first: those are the ones that block other people's work.
  // routine-silent ranks high because a routine that stopped firing invalidates
  // every later "clean" reading, the way a dead sensor does.
  const rank = {
    'awaiting-operator': 0, 'abandoned-lease': 1, 'routine-silent': 2, 'stale-running': 3,
    'routine-void': 4, 'routine-findings': 5, 'stale-review': 6, 'stale-failed': 7,
    // Hygiene before backlog-idle: an unspecced dispatch is about to waste a
    // builder session; an unlanded value is a live near-miss. Both outrank
    // "nobody picked this up yet".
    'dispatch-unspecced': 8, 'ruling-unlanded': 9,
    'blocked-not-gated': 10, idle: 11,
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

module.exports = { classify, audit, render, RULES, loadTasks, loadRulings };

if (require.main === module) {
  const report = audit(loadTasks());
  process.stdout.write(process.argv.includes('--json')
    ? JSON.stringify(report, null, 2) + '\n'
    : render(report) + '\n');
  // Non-zero only when the operator personally owes something, so a scheduled
  // run's exit code is a useful signal rather than always-green noise.
  process.exit(report.byCategory['awaiting-operator'] ? 1 : 0);
}
