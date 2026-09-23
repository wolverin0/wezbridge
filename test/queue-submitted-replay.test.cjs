'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const q = require('../src/project-queue.cjs');

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-replay-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const calls = [];
  const entry = { project: 'wezbridge', from_pane: 158, corr: 'reparto-pilot-fixture', type: 'progress', body: 'already received but integrity reported truncated' };
  const create = (send = {}) => q.createConsumer({ base, project: 'wezbridge', cooldownMs: 0,
    discoverPanes: () => [{ paneId: 94, agent: 'codex', status: 'idle', project: 'G:/test/wezbridge' }],
    send: { sendPromptDeferredEnter: async () => { calls.push('write'); return 'ok'; }, verifyPromptSubmission: async () => 'submitted', ...send },
    logAction: () => {} });
  return { base, calls, entry, create };
}

test('submitted+truncated source survives three drains and restart without a second reception', async t => {
  const f = setup(t);
  const { id } = q.enqueue({ ...f.entry, ok: false, submitted: 'submitted', delivered: 'truncated' }, { base: f.base });
  for (let i = 0; i < 3; i++) await f.create().drain();
  assert.equal(f.calls.length, 0, 'original submission already happened; zero repeat writes');
  const c = f.create();
  assert.equal(c.status().uncertain, 1, 'uncertainty remains visible, not falsely delivered');
  assert.equal(c._state.delivered.includes(id), false);
  assert.equal(c._state.pending[id].attempts, 0);
});

test('a submitted retry with truncated integrity is held before the next drain', async t => {
  const f = setup(t);
  q.enqueue({ ...f.entry, ok: false }, { base: f.base });
  await f.create({ sendPromptDeferredEnter: async () => { f.calls.push('write'); return 'truncated'; } }).drain();
  await f.create().drain();
  await f.create().drain();
  assert.equal(f.calls.length, 1);
  assert.equal(f.create().status().uncertain, 1);
});

test('legacy pending lost submitted metadata: source reconciliation prevents migration replay', async t => {
  const f = setup(t);
  const { id } = q.enqueue({ ...f.entry, ok: false, submitted: 'submitted', delivered: 'truncated' }, { base: f.base });
  const c = f.create(); c.ingest();
  const pending = JSON.parse(fs.readFileSync(c._files.pending));
  delete pending[id].submitted;
  delete pending[id].submission_uncertain;
  fs.writeFileSync(c._files.pending, JSON.stringify(pending));
  await f.create().drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.create().status().uncertain, 1);
});

test('never-submitted source can still deliver normally', async t => {
  const f = setup(t);
  q.enqueue({ ...f.entry, ok: false, submitted: null }, { base: f.base });
  assert.equal((await f.create().drain()).delivered, 1);
  assert.equal(f.calls.length, 1);
});

test('scheduled CLI exposes held uncertainty without claiming delivered or touching a pane', t => {
  const f = setup(t);
  q.enqueue({ ...f.entry, ok: false, submitted: 'submitted', delivered: 'truncated' }, { base: f.base });
  const out = execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/queue-drain.cjs'), '--project', 'wezbridge'],
    { encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: f.base } });
  assert.match(out, /delivered=0/);
  assert.match(out, /pending=1/);
  assert.match(out, /uncertain=1/);
});

test('verified-only ingestion persists its receipt across restart and a later failed copy', async t => {
  const f = setup(t);
  const { id } = q.enqueue({ ...f.entry, ok: true, submitted: 'submitted', delivered: 'ok' }, { base: f.base });
  await f.create().drain();
  assert.equal(f.create()._state.delivered.includes(id), true, 'verified receipt must survive a fresh consumer');
  q.enqueue({ ...f.entry, ok: false, submitted: null }, { base: f.base });
  await f.create().drain();
  assert.equal(f.calls.length, 0, 'later failed copy cannot resurrect an already received entry');
});
