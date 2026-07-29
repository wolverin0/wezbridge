'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const steward = require('../scripts/fleet-steward.cjs');

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('a gated task the operator never ruled on is the top finding', () => {
  // This is the exact shape of T-0022 (ARS 8.06M judicial disposition): born
  // blocked by its graph contract, correct to be blocked, but silently owed by
  // the operator for days while a pane waited on it. The steward exists for
  // this case above all others.
  const t = {
    id: 'T-0022', repo: 'mutual', state: 'blocked', title: 'DECIDE: judicial balances',
    contract: { gate: 'operator' }, blocker: 'operator gate (graph contract)',
    updated_at: hoursAgo(72),
  };
  const r = steward.audit([t], NOW);
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].category, 'awaiting-operator');
  assert.strictEqual(r.findings[0].age_hours, 72);
});

test('a gated task blocked only an hour is NOT stale — gating is not a defect', () => {
  // The steward must not train the operator to ignore it. A task correctly
  // waiting on a ruling made minutes ago is the system working, not a problem.
  const t = {
    id: 'T-1', repo: 'mutual', state: 'blocked', contract: { gate: 'operator' },
    updated_at: hoursAgo(1),
  };
  assert.deepStrictEqual(steward.audit([t], NOW).findings, []);
});

test('an expired lease is reported even when the task was updated recently', () => {
  // Age alone would miss this: a worker can touch a task and then die. The
  // lease expiry is the stronger signal — someone PROMISED to finish it.
  const t = {
    id: 'T-2', repo: 'wezbridge', state: 'running', title: 'batch',
    updated_at: hoursAgo(1),
    lease: { owner: 'pane-29', until: hoursAgo(3) },
  };
  const f = steward.audit([t], NOW).findings;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].category, 'abandoned-lease');
  assert.match(f[0].why, /pane-29/, 'the report must name who dropped it');
});

test('a running task with a LIVE lease is left alone', () => {
  const t = {
    id: 'T-3', repo: 'mutual', state: 'running', updated_at: hoursAgo(20),
    lease: { owner: 'pane-37', until: new Date(NOW + 3600000).toISOString() },
  };
  assert.deepStrictEqual(steward.audit([t], NOW).findings, []);
});

test('done and cancelled tasks are never reported however old', () => {
  const tasks = [
    { id: 'T-4', state: 'done', updated_at: hoursAgo(10000) },
    { id: 'T-5', state: 'cancelled', updated_at: hoursAgo(10000) },
  ];
  assert.deepStrictEqual(steward.audit(tasks, NOW).findings, []);
});

test('operator-owed items sort above everything else', () => {
  // A report that buries the one thing the operator must personally answer
  // under twenty idle tasks is the board defect all over again.
  const tasks = [
    { id: 'T-idle', repo: 'a', state: 'queued', updated_at: hoursAgo(500) },
    { id: 'T-gate', repo: 'b', state: 'blocked', contract: { gate: 'operator' }, updated_at: hoursAgo(25) },
  ];
  const f = steward.audit(tasks, NOW).findings;
  assert.strictEqual(f[0].id, 'T-gate', 'the operator-owed item must lead despite being far younger');
});

test('a clean fleet says so plainly instead of printing an empty report', () => {
  const out = steward.render(steward.audit([{ id: 'T-6', state: 'done' }], NOW));
  assert.match(out, /none stale/);
});

test('the steward never proposes closing anything', () => {
  // Guard against a future "helpful" change: auto-closing is how real work
  // disappears. Every category is a judgement call for the operator.
  const t = { id: 'T-7', repo: 'x', state: 'queued', title: 'old', updated_at: hoursAgo(999) };
  const out = steward.render(steward.audit([t], NOW));
  assert.match(out, /never closes anything/);
  assert.ok(!/closed|closing T-/i.test(out.replace(/never closes anything/, '')),
    'the report must not claim to have closed anything');
});
