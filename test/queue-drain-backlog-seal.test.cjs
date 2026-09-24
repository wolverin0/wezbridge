'use strict';
/**
 * queue-drain-backlog-seal.test.cjs — T-0596 paso 2 FIX-UP (V5). Operator
 * decision 24/09: none of the decision-relay approvals queued BEFORE the
 * Orca drain existed may be re-delivered ("ya estan en el ledger y
 * ejecutadas") — the plain 24h/maxAgeMs expiry alone does not stop them,
 * because several are still under 24h old at the moment this fix lands.
 * project-queue.cjs seals any entry whose queue `time` is before
 * ORCA_DRAIN_NOT_BEFORE (overridable via WEZBRIDGE_DRAIN_NOT_BEFORE): it is
 * tombstoned via the SAME expiry/anti-replay accounting maxAgeMs already
 * uses (deliveredSet ring) — never delivered, never re-queued, no new store.
 * Fixtures below are modeled on the real backlog: pedrito T-0587
 * (decision_at 2026-09-24T12:11:42Z) and whatsappbot-final T-0482
 * (2026-09-23T18:59:13Z).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pq = require('../src/project-queue.cjs');

function fixture(t, { nowIso } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-seal-'));
  t.after(() => { assert.equal(path.dirname(base), os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
  const clock = Date.parse(nowIso || '2026-09-24T17:00:00Z');
  const orcaCalls = [];
  const config = {
    base, project: 'pedrito', now: () => clock,
    discoverPanes: () => [], // no WezTerm panes live — forces the Orca path, same as production right now
    logAction: () => {},
    send: { sendPromptDeferredEnter: async () => { throw new Error('must not use WezTerm transport in this test'); },
      verifyPromptSubmission: async () => 'submitted' },
    resolveOrcaTarget: async () => ({ handle: 'term_pedrito1', matchedBy: 'lane', ambiguous: [], warning: null }),
    orcaSend: {
      sendToOrcaTerminal: async (handle, body) => {
        orcaCalls.push({ handle, body });
        return { ok: true, submitted: 'submitted', delivered: 'ok', handle, retryId: null, tail: ['...'], error: null };
      },
    },
  };
  // Enqueue then rewrite the line's `time` to the real enqueue timestamp —
  // enqueue() always stamps `new Date().toISOString()`, the fixtures need the
  // historical decision_at-adjacent time instead (same idiom as the existing
  // queue-drain-orca-transport.test.cjs fixture). Reads only the LAST line so
  // a second add() for the same project queue file doesn't clobber the first.
  // from_project deliberately stays unset (not 'decision-relay'): that value
  // only applies to real `[decision] operator ...` bodies (decision-authority.cjs
  // queuedDecision) — these fixtures model the queued TIME/shape, not the
  // decision-screening gate, which is out of this fix's scope.
  const add = (corr, body, time) => {
    const saved = pq.enqueue({ project: 'pedrito', corr, type: 'progress', from_pane: null,
      ok: false, body, decision_at: time }, { base });
    const lines = fs.readFileSync(saved.file, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    lines[lines.length - 1] = JSON.stringify({ ...last, time });
    fs.writeFileSync(saved.file, lines.join('\n') + '\n');
    return saved;
  };
  return { base, orcaCalls, config, add };
}

test('backlog seal: T-0587/T-0482-shaped pre-cutoff entries are NOT delivered by the drain (mocked now=2026-09-24T17:00Z)', async (t) => {
  const f = fixture(t, { nowIso: '2026-09-24T17:00:00Z' });
  // Real shapes from the operator's blocking list — both under 24h old at
  // this mocked "now", so plain maxAgeMs alone would NOT stop them.
  f.add('T-0587', 'pedrito decision relay: card review ruling', '2026-09-24T12:11:42Z');
  f.add('T-0482', 'whatsappbot-final decision relay: pwo panel2 GO', '2026-09-23T18:59:13Z');
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.delivered, 0, JSON.stringify(outcome));
  assert.equal(outcome.pending, 0, JSON.stringify(outcome));
  assert.equal(f.orcaCalls.length, 0, 'sealed backlog must never reach the orca send primitive');
  assert.equal(outcome.sealed, 2, JSON.stringify(outcome));
});

test('backlog seal: an entry enqueued AFTER the cutoff IS delivered via the orca double', async (t) => {
  const f = fixture(t, { nowIso: '2026-09-24T19:00:00Z' });
  f.add('T-0600', 'fresh post-cutoff dispatch', '2026-09-24T18:30:00Z');
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.delivered, 1, JSON.stringify(outcome));
  assert.equal(outcome.sealed, 0, JSON.stringify(outcome));
  assert.equal(f.orcaCalls.length, 1);
  assert.match(f.orcaCalls[0].body, /fresh post-cutoff dispatch/);
});

test('backlog seal: WEZBRIDGE_DRAIN_NOT_BEFORE env override moves the cutoff', async (t) => {
  const f = fixture(t, { nowIso: '2026-09-25T00:00:00Z' });
  const prior = process.env.WEZBRIDGE_DRAIN_NOT_BEFORE;
  process.env.WEZBRIDGE_DRAIN_NOT_BEFORE = '2026-09-24T20:00:00Z';
  try {
    f.add('T-0601', 'entry between default cutoff and overridden cutoff', '2026-09-24T19:00:00Z');
    const consumer = pq.createConsumer(f.config);
    const outcome = await consumer.drain();
    assert.equal(outcome.delivered, 0, JSON.stringify(outcome));
    assert.equal(outcome.sealed, 1, JSON.stringify(outcome));
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_DRAIN_NOT_BEFORE; else process.env.WEZBRIDGE_DRAIN_NOT_BEFORE = prior;
  }
});
