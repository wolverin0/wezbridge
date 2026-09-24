'use strict';
/**
 * project-queue-stale-dispatch.test.cjs — T-0354: the queue must re-read a
 * dispatch envelope's CARD before every delivery attempt, not just at
 * enqueue time. Measured 2026-09-04 with T-0262: the card moved to
 * blocked/blocked_by=operator AFTER the envelope was already pending, and
 * the queue redelivered the same stale envelope anyway (attempts=2) — the
 * infra pane had to explain twice that the card was closed. Only a
 * type=request envelope naming a task id (`corr` starting `T-XXXX`) is
 * gated; results/acks/progress/errors and envelopes with no resolvable
 * card are unaffected (AC3), and a card the ledger can't be read at all
 * fails OPEN — deliver as today (AC4). Read this before touching the card
 * re-check in deliverPending() (src/project-queue.cjs).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't0354-stale-dispatch-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP;
const pq = require('../src/project-queue.cjs');

const IDLE_PANE = { paneId: 7, agent: 'claude', status: 'idle', project: 'G:/x/wezbridge', tabTitle: null, title: null };

function fixture(t) {
  const base = fs.mkdtempSync(path.join(TMP, 'case-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const calls = [];
  const send = {
    sendPromptDeferredEnter: async (paneId, body) => { calls.push({ paneId, body }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
  };
  const writeCard = (taskId, fields) => {
    fs.mkdirSync(path.join(base, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(base, 'tasks', `${taskId}.json`), JSON.stringify({ id: taskId, repo: 'wezbridge', ...fields }));
  };
  const enqueue = ({ corr, type = 'request', body }) =>
    pq.enqueue({ project: 'wezbridge', corr, type, from_pane: 0, from_project: 'orchestrator', ok: false, body: body || `dispatch ${corr}` }, { base });
  const consumer = (extra = {}) => pq.createConsumer({ project: 'wezbridge', base,
    discoverPanes: () => [IDLE_PANE], send, cooldownMs: 0, logAction: () => {}, ...extra });
  const events = () => fs.existsSync(path.join(base, 'events.jsonl'))
    ? fs.readFileSync(path.join(base, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { base, calls, enqueue, consumer, writeCard, events };
}

// ── AC1: fail-first — a stale dispatch is dropped, not redelivered ─────────

for (const state of ['blocked', 'done', 'cancelled']) {
  test(`AC1 fail-first: a type=request dispatch whose card is ${state} is dropped, not delivered`, async t => {
    const f = fixture(t);
    f.writeCard('T-0262', { state });
    const entry = f.enqueue({ corr: 'T-0262', type: 'request', body: 'do the old scope' });
    const result = await f.consumer().drain();
    assert.equal(result.delivered, 0, 'a stale-state card must not be delivered');
    assert.equal(f.calls.length, 0, 'the pane must never receive the stale envelope');
    assert.equal(result.pending, 0, 'the dropped entry must not remain for a later replay');
    const dropped = f.events().find(e => e.event === 'queue.entry_dropped' && e.id === entry.id);
    assert.ok(dropped, 'queue.entry_dropped must be emitted');
    assert.match(dropped.reason, new RegExp(state), 'the drop reason must name the card state');
    // A second drain pass must not resurrect it (durable discard, waker rule).
    await f.consumer().drain();
    assert.equal(f.calls.length, 0, 'restart/redrain must not replay a dropped stale dispatch');
  });
}

test('AC1: a card that moves to blocked AFTER the envelope was already pending is still caught on the next drain', async t => {
  const f = fixture(t);
  f.writeCard('T-0262', { state: 'ready' });
  f.enqueue({ corr: 'T-0262', type: 'request', body: 'do the old scope' });
  // First drain: pane busy, so ingest happens but nothing delivers yet.
  const busy = pq.createConsumer({ project: 'wezbridge', base: f.base,
    discoverPanes: () => [{ ...IDLE_PANE, status: 'working' }], send: { sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' },
    cooldownMs: 0, logAction: () => {} });
  const first = await busy.drain();
  assert.equal(first.pending, 1);
  // Card is corrected/blocked between the two drains — the real-world sequence.
  f.writeCard('T-0262', { state: 'blocked', blocked_by: 'operator' });
  const second = await f.consumer().drain();
  assert.equal(second.delivered, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().find(e => e.event === 'queue.entry_dropped').reason.includes('blocked'), true);
});

// ── AC2: happy path — a still-dispatchable card delivers exactly as today ──

for (const state of ['ready', 'queued', 'running']) {
  test(`AC2 happy path: a type=request dispatch whose card is ${state} delivers normally`, async t => {
    const f = fixture(t);
    f.writeCard('T-0300', { state });
    f.enqueue({ corr: 'T-0300', type: 'request', body: 'do the current scope' });
    const result = await f.consumer().drain();
    assert.equal(result.delivered, 1);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].body, /do the current scope/);
    assert.equal(f.events().find(e => e.event === 'queue.entry_dropped'), undefined);
  });
}

// ── AC3: non-dispatch envelopes and unresolvable cards are unaffected ──────

for (const type of ['result', 'ack', 'progress', 'error']) {
  test(`AC3: a type=${type} envelope delivers even when its card is closed`, async t => {
    const f = fixture(t);
    f.writeCard('T-0400', { state: 'done' });
    f.enqueue({ corr: 'T-0400', type, body: `${type} for closed card` });
    const result = await f.consumer().drain();
    assert.equal(result.delivered, 1, `${type} envelopes are not dispatches and must not be gated on card state`);
    assert.equal(f.calls.length, 1);
  });
}

test('AC3: an envelope with no resolvable card (unknown corr) delivers as today', async t => {
  const f = fixture(t);
  // No card file written at all for this corr.
  f.enqueue({ corr: 'T-9999', type: 'request', body: 'no card on file' });
  const result = await f.consumer().drain();
  assert.equal(result.delivered, 1, 'an unresolvable card must never block delivery');
  assert.equal(f.calls.length, 1);
});

test('AC3: an envelope whose corr does not name a task id delivers as today', async t => {
  const f = fixture(t);
  f.enqueue({ corr: 'adhoc-thread-1', type: 'request', body: 'not a card-backed dispatch' });
  const result = await f.consumer().drain();
  assert.equal(result.delivered, 1);
  assert.equal(f.calls.length, 1);
});

// ── AC4: an unreadable/corrupt ledger fails OPEN ────────────────────────────

test('AC4: a corrupt card file fails open — delivers as today, logs a warning, never drops', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.base, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(f.base, 'tasks', 'T-0500.json'), '{ not valid json');
  const logs = [];
  f.enqueue({ corr: 'T-0500', type: 'request', body: 'card unreadable' });
  const result = await f.consumer({ log: (msg) => logs.push(msg) }).drain();
  assert.equal(result.delivered, 1, 'a parse error on the card must not block delivery');
  assert.equal(f.calls.length, 1);
  assert.equal(f.events().find(e => e.event === 'queue.entry_dropped'), undefined);
  assert.ok(logs.some(l => /T-0500/.test(l)), 'a warning naming the card must be logged');
});

test('AC4: a missing tasks directory entirely fails open — delivers as today', async t => {
  const f = fixture(t);
  // No tasks/ directory at all under this base.
  f.enqueue({ corr: 'T-0600', type: 'request', body: 'no ledger present' });
  const result = await f.consumer().drain();
  assert.equal(result.delivered, 1);
  assert.equal(f.calls.length, 1);
});
