'use strict';
/**
 * queue-drain-orca-transport.test.cjs — T-0596 paso 2: project-queue.cjs's
 * createConsumer resolves an Orca terminal via the SAME resolver a2a_send
 * uses (src/orca-target.cjs) when WezTerm has no live pane for the queued
 * project, and delivers through src/orca-send.cjs. Covers: delivery via
 * Orca, the self-send guard mirrored from a2a_send, and that an entry older
 * than the existing 24h/maxAgeMs expiry is NEVER delivered by this new path
 * (it must expire before deliverPending ever sees it — same TTL guard as the
 * WezTerm path, unmodified by this card).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pq = require('../src/project-queue.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-orca-'));
  t.after(() => { assert.equal(path.dirname(base), os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
  // T-0596 V5: pinned past the ORCA_DRAIN_NOT_BEFORE backlog-seal cutoff
  // (project-queue.cjs) — an unmocked Date.now() would fall BEFORE that
  // cutoff for a real window around 2026-09-24 and wrongly seal this test's
  // freshly-enqueued entry, which is not what this file is testing.
  let clock = Date.parse('2026-09-25T00:00:00Z');
  const orcaCalls = [];
  const config = {
    base, project: 'drillrepo', now: () => clock,
    discoverPanes: () => [], // no WezTerm panes at all — the exact precondition this card fixes
    logAction: () => {},
    send: { sendPromptDeferredEnter: async () => { throw new Error('must not use WezTerm transport in this test'); },
      verifyPromptSubmission: async () => 'submitted' },
    resolveOrcaTarget: async () => ({ handle: 'term_drill1', matchedBy: 'lane', ambiguous: [], warning: null }),
    orcaSend: {
      sendToOrcaTerminal: async (handle, body) => {
        orcaCalls.push({ handle, body });
        return { ok: true, submitted: 'submitted', delivered: 'ok', handle, retryId: null, tail: ['...'], error: null };
      },
    },
  };
  const add = (corr, body = corr) => {
    const saved = pq.enqueue({ project: 'drillrepo', corr, type: 'progress', from_pane: 9, ok: false, body }, { base });
    const entry = JSON.parse(fs.readFileSync(saved.file, 'utf8').trim());
    fs.writeFileSync(saved.file, JSON.stringify({ ...entry, time: new Date(clock).toISOString() }) + '\n');
    return saved;
  };
  return { base, orcaCalls, config, add, advance: (ms) => { clock += ms; } };
}

test('queue-drain delivers via Orca when WezTerm has no live pane for the project', async (t) => {
  const f = fixture(t);
  f.add('orca-1', 'hola via orca');
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.delivered, 1, JSON.stringify(outcome));
  assert.equal(outcome.pending, 0);
  assert.equal(f.orcaCalls.length, 1);
  assert.equal(f.orcaCalls[0].handle, 'term_drill1');
  assert.match(f.orcaCalls[0].body, /hola via orca/);
});

test('queue-drain SELF-SEND GUARD: refuses (drops, never sends) when the resolved Orca handle is this consumer\'s own terminal', async (t) => {
  const f = fixture(t);
  f.add('orca-self');
  const prior = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_drill1'; // same handle resolveOrcaTarget returns
  try {
    const consumer = pq.createConsumer(f.config);
    const outcome = await consumer.drain();
    assert.equal(outcome.delivered, 0, JSON.stringify(outcome));
    assert.equal(outcome.dropped, 1, JSON.stringify(outcome));
    assert.equal(f.orcaCalls.length, 0, 'self-send must never call the orca send primitive');
    assert.equal(outcome.pending, 0, 'a self-send is dropped, not retried');
  } finally {
    if (prior === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = prior;
  }
});

// ── T-0600: unknown ≠ delivered, through the full drain retry cycle ─────────

test('T-0600 (a): screen never shows the envelope after send -> delivered:false, stays pending, NOT recorded as delivered', async (t) => {
  const f = fixture(t);
  f.add('t0600-a', 'never lands on screen');
  f.config.orcaSend = {
    sendToOrcaTerminal: async (handle, body) => {
      f.orcaCalls.push({ handle, body });
      return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId: null, tail: ['unrelated'], error: null };
    },
  };
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.delivered, 0, JSON.stringify(outcome));
  assert.equal(outcome.pending, 1, JSON.stringify(outcome));
  assert.equal(consumer._state.delivered.includes(Object.keys(consumer._state.pending)[0]), false);
  assert.equal(f.orcaCalls.length, 1);
});

test('T-0600 (b): next drain tick the screen now shows it -> delivered:true exactly once', async (t) => {
  const f = fixture(t);
  f.add('t0600-b', 'lands on the second try');
  let attempt = 0;
  f.config.orcaSend = {
    sendToOrcaTerminal: async (handle, body) => {
      attempt += 1;
      f.orcaCalls.push({ handle, body });
      if (attempt === 1) return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId: null, tail: ['unrelated'], error: null };
      return { ok: true, submitted: 'submitted', delivered: 'ok', handle, retryId: null, tail: [body], error: null };
    },
  };
  const consumer1 = pq.createConsumer(f.config);
  const first = await consumer1.drain();
  assert.equal(first.delivered, 0, JSON.stringify(first));
  assert.equal(first.pending, 1);

  f.advance(f.config.cooldownMs || 5 * 60 * 1000); // clear the per-project cooldown so the retry is not skipped
  const consumer2 = pq.createConsumer(f.config); // fresh consumer = next drain tick, reloads persisted state
  const second = await consumer2.drain();
  assert.equal(second.delivered, 1, JSON.stringify(second));
  assert.equal(second.pending, 0);
  assert.equal(f.orcaCalls.length, 2, 'exactly one retry — no duplicate delivery');
});

test('T-0600 (c): overlay/foreign-text visible on the destination screen -> NOT sent, stays pending, attempt budget untouched', async (t) => {
  const f = fixture(t);
  f.add('t0600-c', 'must wait for the overlay to close');
  f.config.orcaSend = {
    sendToOrcaTerminal: async (handle, body) => {
      f.orcaCalls.push({ handle, body });
      return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId: null, tail: ['overlay'], error: null, deferred: true, reason: 'overlay-or-foreign-text' };
    },
  };
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.delivered, 0, JSON.stringify(outcome));
  assert.equal(outcome.pending, 1, JSON.stringify(outcome));
  const [id] = Object.keys(consumer._state.pending);
  assert.equal(consumer._state.pending[id].attempts, 0, 'a deferred (overlay) attempt must not consume the attempt budget');
});

test('T-0600 (d): attempt cap reached -> flagged and dropped (dead-letter), same as today', async (t) => {
  const f = fixture(t);
  f.config.maxAttempts = 3;
  f.add('t0600-d', 'never lands, ever');
  f.config.orcaSend = {
    sendToOrcaTerminal: async (handle, body) => {
      f.orcaCalls.push({ handle, body });
      return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId: null, tail: ['unrelated'], error: null };
    },
  };
  for (let i = 0; i < 3; i += 1) {
    const consumer = pq.createConsumer(f.config);
    await consumer.drain();
    f.advance(f.config.cooldownMs || 5 * 60 * 1000);
  }
  const finalConsumer = pq.createConsumer(f.config);
  const flags = JSON.parse(fs.readFileSync(finalConsumer._files.flags, 'utf8'));
  const [id] = Object.keys(flags);
  assert.match(flags[id].reason, /attempt cap/);
  assert.equal(Object.keys(finalConsumer._state.pending).length, 0, 'a capped entry is dropped from pending, not retried again');
  assert.equal(f.orcaCalls.length, 3);
});

test('queue-drain: an entry ALREADY older than maxAgeMs at ingest is NOT delivered via Orca (the 30 old operator-approval class must not go out)', async (t) => {
  const f = fixture(t);
  f.config.maxAgeMs = 1000;
  f.add('old-decision-relay', 'operator approval from 20-24/09 — must not go out');
  // Age the entry past maxAgeMs BEFORE the first drain ever sees it — the exact
  // shape of the 30 old operator approvals: lines already sitting >24h old the
  // first time this code reads them, not entries that expired while pending.
  f.advance(1001);
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.expired, 1, JSON.stringify(outcome));
  assert.equal(outcome.delivered, 0);
  assert.equal(outcome.pending, 0);
  assert.equal(f.orcaCalls.length, 0, 'an expired entry must never reach the orca send primitive');
});
