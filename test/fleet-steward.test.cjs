'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('the lease field name matches a REAL task record, not an invented one', () => {
  // v1 read `lease.until`. The real field is `expires_at`, so the entire
  // abandoned-lease rule was dead code against every task on disk — while this
  // suite passed, because the fixture invented the same wrong name. A test
  // that validates the bug is worse than no test. This one reads the actual
  // ledger and fails if the shape ever drifts again.
  const dir = path.join(__dirname, '..', '..', '_intel', 'tasks');
  let leased = [];
  try {
    leased = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter((t) => t.lease);
  } catch { /* no live ledger in this checkout */ }
  if (!leased.length) return; // nothing to conform to; other tests still cover logic
  for (const t of leased) {
    assert.ok('expires_at' in t.lease,
      `${t.id}: real leases carry expires_at — the steward must read that name`);
  }
});

test('an expired lease plus no activity is reported, naming who dropped it', () => {
  const t = {
    id: 'T-2', repo: 'wezbridge', state: 'running', title: 'batch',
    updated_at: hoursAgo(30),
    lease: { owner: 'pane-29', expires_at: hoursAgo(24) },
  };
  const f = steward.audit([t], NOW).findings;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].category, 'abandoned-lease');
  assert.match(f[0].why, /pane-29/, 'the report must name who dropped it');
});

test('an expired lease on a task that is still ACTIVE is not abandoned', () => {
  // Leases are minute-bounded and long loops routinely outlive them without
  // harm. Expiry alone must not accuse a working owner of dying.
  const t = {
    id: 'T-2b', repo: 'wezbridge', state: 'running',
    updated_at: hoursAgo(1),
    lease: { owner: 'pane-29', expires_at: hoursAgo(20) },
  };
  assert.deepStrictEqual(steward.audit([t], NOW).findings, []);
});

test('a running task with a LIVE lease is left alone', () => {
  const t = {
    id: 'T-3', repo: 'mutual', state: 'running', updated_at: hoursAgo(20),
    lease: { owner: 'pane-37', expires_at: new Date(NOW + 3600000).toISOString() },
  };
  assert.deepStrictEqual(steward.audit([t], NOW).findings, []);
});

test('a run log counts as activity even when the ledger has not moved', () => {
  // T-0008 was at pass 50 of a live oversight loop with 38h of ledger silence,
  // because that loop reports to _intel/runs/<id>/log.md. A detector that reads
  // only the ledger is blind to the channel the work is on and will flag every
  // healthy long task — and false positives are how a steward gets ignored.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-runs-'));
  try {
    const runDir = path.join(tmp, 'runs', 'T-8');
    fs.mkdirSync(runDir, { recursive: true });
    const logFile = path.join(runDir, 'log.md');
    fs.writeFileSync(logFile, '# pass 50\n');
    const fresh = new Date(NOW - 3600000);          // one hour ago
    fs.utimesSync(logFile, fresh, fresh);

    const task = { id: 'T-8', repo: 'whatsappbot-final', state: 'running', updated_at: hoursAgo(38) };
    assert.strictEqual(steward.classify(task, NOW, tmp), null,
      'a fresh run log means the task is alive despite ledger silence');

    // ...and a STALE run log must not rescue a genuinely dead task.
    const old = new Date(NOW - 40 * 3600000);
    fs.utimesSync(logFile, old, old);
    const f = steward.classify(task, NOW, tmp);
    assert.ok(f && f.category === 'stale-running', 'an old run log must not mask a real stall');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('every finding names the lease owner, because that is the routing key', () => {
  // A staleness reconcile for T-0008 was dispatched to the whatsappbot pane
  // because the task names that repo — while the lease was held by the
  // orchestrator itself. It chased another agent about its own abandoned work,
  // and that pane rightly refused to transition a task it did not hold. A
  // report that omits the owner routes every follow-up to the wrong place.
  // Hermetic dir on purpose. An earlier version used the REAL task id T-0008
  // with the default intel dir, so lastActivity() read the live fleet's
  // _intel/runs/T-0008/log.md — and the moment that oversight log was appended
  // to, the task looked active, the finding vanished and the test failed. A
  // test coupled to mutable production state fails for reasons unrelated to the
  // behaviour it asserts.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-empty-'));
  try {
    const t = {
      id: 'T-0008', repo: 'whatsappbot-final', state: 'running', title: 'Oversight',
      updated_at: hoursAgo(40), lease: { owner: 'pane-0', expires_at: hoursAgo(30) },
    };
    const f = steward.audit([t], NOW, empty).findings[0];
    assert.ok(f, 'an expired lease with no activity must produce a finding');
    assert.strictEqual(f.owner, 'pane-0', 'the finding must carry the lease holder');
    assert.match(steward.render(steward.audit([t], NOW, empty)), /owner: pane-0/,
      'and the rendered report must show it, not just the JSON');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
