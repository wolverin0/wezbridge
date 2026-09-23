'use strict';
/**
 * T-0472 — a ruling that SAYS nobody is working the card must not count as
 * proof someone is. Channel 3 of lastProgress() (ownProgress -> buildContext)
 * pushed `ctx.rulingAt.get(task.id)` from ANY ruling line on the task,
 * regardless of what the ruling actually said. `operator-gated` and
 * `deferred` are, by construction, the orchestrator recording that the card
 * is EXPLICITLY parked — waiting on the operator, or pushed to later. Reading
 * that as liveness let the orchestrator's own act of writing "nobody is on
 * this" reset the quiet clock 24h+ into the future every time it fired,
 * silencing the exact category (abandoned-lease / stale-running) that exists
 * to catch a dead worker. Census of the live board (2026-09-18): 31 cards
 * suppressed this way, 28 of them by operator-gated/deferred, 31 of 31 by
 * source=orchestrator-pane. Same defect family as T-0144 (annotation is not
 * movement) at the neighbouring channel.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

function intelWithRuling(rulingLine) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-ruling-liveness-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  if (rulingLine) fs.writeFileSync(path.join(d, 'rulings.jsonl'), `${JSON.stringify(rulingLine)}\n`);
  return d;
}

// ─── AC1: an operator-gated ruling is not evidence the worker is alive ─────

test('a running card with an expired lease whose ONLY progress is an operator-gated ruling from the orchestrator pane is abandoned-lease', () => {
  const dir = intelWithRuling({
    task: 'T-STUCK', category: 'abandoned-lease', ruling: 'operator-gated',
    source: 'orchestrator-pane', by: 'operator', at: hoursAgo(1),
  });
  try {
    const t = {
      id: 'T-STUCK', repo: 'wezbridge', state: 'running', title: 'stuck behind its own gate ruling',
      created_at: hoursAgo(40), state_changed_at: hoursAgo(30),
      lease: { owner: 'pane-7', expires_at: hoursAgo(20) },
    };
    const f = steward.audit([t], NOW, dir).findings.filter((x) => x.id === 'T-STUCK');
    assert.strictEqual(f.length, 1,
      'a ruling that says "nobody is on this" must not silence the abandoned-lease alarm');
    assert.strictEqual(f[0].category, 'abandoned-lease');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same shape with a deferred ruling from the orchestrator pane is also abandoned-lease', () => {
  const dir = intelWithRuling({
    task: 'T-STUCK-2', category: 'abandoned-lease', ruling: 'deferred',
    source: 'orchestrator-pane', by: 'operator', at: hoursAgo(1),
  });
  try {
    const t = {
      id: 'T-STUCK-2', repo: 'wezbridge', state: 'running', title: 'deferred does not mean alive',
      created_at: hoursAgo(40), state_changed_at: hoursAgo(30),
      lease: { owner: 'pane-8', expires_at: hoursAgo(20) },
    };
    const f = steward.audit([t], NOW, dir).findings.filter((x) => x.id === 'T-STUCK-2');
    assert.strictEqual(f.length, 1, 'deferred is a parking slip, not a heartbeat');
    assert.strictEqual(f[0].category, 'abandoned-lease');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the categories that legitimately DO count as liveness stay green ─────

test('a resolved ruling still counts as progress', () => {
  const dir = intelWithRuling({
    task: 'T-RESOLVED', category: 'abandoned-lease', ruling: 'resolved',
    source: 'orchestrator-pane', by: 'operator', at: hoursAgo(1),
  });
  try {
    const t = {
      id: 'T-RESOLVED', repo: 'wezbridge', state: 'running', title: 'resolved an hour ago',
      created_at: hoursAgo(40), state_changed_at: hoursAgo(30),
      lease: { owner: 'pane-9', expires_at: hoursAgo(20) },
    };
    assert.deepStrictEqual(steward.audit([t], NOW, dir).findings, [],
      'resolved is a real closing act, not a parking slip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dispatched ruling still counts as progress (unchanged from before this fix)', () => {
  // Deliberate scope limit: `dispatched` asserts a handoff actually happened,
  // which is a different claim from operator-gated/deferred explicitly saying
  // nobody is working the card. Narrowing the filter to those two words (not
  // to "any non-terminal ruling") keeps this existing, already-tested contract
  // intact — see test/fleet-steward-progress.test.cjs:133 ("a ruling recorded
  // against the task counts as progress", fixture uses ruling: 'dispatched').
  const dir = intelWithRuling({
    task: 'T-DISPATCHED', category: 'abandoned-lease', ruling: 'dispatched',
    source: 'orchestrator-pane', by: 'operator', at: hoursAgo(1),
  });
  try {
    const t = {
      id: 'T-DISPATCHED', repo: 'wezbridge', state: 'running', title: 'dispatched an hour ago',
      created_at: hoursAgo(40), state_changed_at: hoursAgo(30),
      lease: { owner: 'pane-10', expires_at: hoursAgo(20) },
    };
    assert.deepStrictEqual(steward.audit([t], NOW, dir).findings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
