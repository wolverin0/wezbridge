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

const ageMs = (task, now) => now - new Date(task.updated_at || task.created_at || 0).getTime();
const hours = (ms) => Math.round(ms / 3600000);

/**
 * Classify one task. Returns null when it needs no attention.
 * `now` is injected so this is testable without clock mocking.
 */
function classify(task, now) {
  const age = ageMs(task, now);
  const gated = Boolean(task.contract && task.contract.gate === 'operator');
  const common = { id: task.id, repo: task.repo, state: task.state, title: task.title, age_hours: hours(age) };

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
      const until = task.lease && task.lease.until ? new Date(task.lease.until).getTime() : null;
      if (until !== null) {
        return until < now
          ? { ...common, category: 'abandoned-lease', why: `lease expired ${hours(now - until)}h ago (owner ${task.lease.owner || '?'})` }
          : null;
      }
      if (age > HOURS(RULES.staleRunning)) return { ...common, category: 'stale-running', why: 'running with no lease and no state change — worker may have died' };
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

function audit(tasks, now = Date.now()) {
  const findings = tasks.map((t) => classify(t, now)).filter(Boolean);
  // Operator-owed items first: those are the ones that block other people's work.
  const rank = { 'awaiting-operator': 0, 'abandoned-lease': 1, 'stale-running': 2, 'stale-review': 3, 'stale-failed': 4, 'blocked-not-gated': 5, idle: 6 };
  findings.sort((a, b) => (rank[a.category] - rank[b.category]) || (b.age_hours - a.age_hours));
  const byCategory = {};
  for (const f of findings) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.state)).length;
  return { generated_at: new Date(now).toISOString(), open, findings, byCategory };
}

function render(report) {
  if (!report.findings.length) {
    return `fleet-steward: ${report.open} open tasks, none stale. Nothing owed.`;
  }
  const lines = [`fleet-steward: ${report.findings.length} of ${report.open} open tasks need a look.`, ''];
  let last = null;
  for (const f of report.findings) {
    if (f.category !== last) { lines.push(`[${f.category}]`); last = f.category; }
    lines.push(`  ${f.id} | ${f.repo} | ${f.age_hours}h | ${String(f.title || '').slice(0, 58)}`);
    lines.push(`      ${f.why}`);
  }
  lines.push('', 'The steward never closes anything — every line above is yours to rule on.');
  return lines.join('\n');
}

module.exports = { classify, audit, render, RULES, loadTasks };

if (require.main === module) {
  const report = audit(loadTasks());
  process.stdout.write(process.argv.includes('--json')
    ? JSON.stringify(report, null, 2) + '\n'
    : render(report) + '\n');
  // Non-zero only when the operator personally owes something, so a scheduled
  // run's exit code is a useful signal rather than always-green noise.
  process.exit(report.byCategory['awaiting-operator'] ? 1 : 0);
}
