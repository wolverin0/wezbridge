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
  let clock = Date.now();
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
