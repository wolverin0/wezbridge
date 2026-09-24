'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// T-0596 item 4: legacy WezTerm-pane queue delivery, gated off by default — opt in for this file.
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const pq = require('../src/project-queue.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-expiry-'));
  t.after(() => { assert.equal(path.dirname(base), os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
  let clock = Date.now();
  const calls = [];
  const idle = { paneId: 73, agent: 'codex', status: 'idle', project: 'G:/apps/wezbridge' };
  const config = { base, project: 'wezbridge', maxAgeMs: 1000, now: () => clock,
    discoverPanes: () => [{ ...idle, status: 'working' }], logAction: () => {},
    send: { sendPromptDeferredEnter: async (_, body) => { calls.push(body); return 'ok'; }, verifyPromptSubmission: async () => 'submitted' } };
  const add = corr => {
    const saved = pq.enqueue({ project: 'wezbridge', corr, type: 'progress', from_pane: 9, ok: false, body: corr }, { base });
    const entry = JSON.parse(fs.readFileSync(saved.file, 'utf8').trim());
    fs.writeFileSync(saved.file, JSON.stringify({ ...entry, time: new Date(clock).toISOString() }) + '\n');
    return saved;
  };
  return { base, calls, config, idle, add, advance: ms => { clock += ms; } };
}

for (const state of ['idle', 'working', 'absent']) {
  test(`pending expiry killer: previously ingested message expires with ${state} target and stays absent after restart`, async t => {
    const f = fixture(t);
    const saved = f.add('old');
    const first = pq.createConsumer(f.config);
    assert.equal((await first.drain()).pending, 1);
    f.advance(1001);
    const discoverPanes = () => state === 'absent' ? [] : [{ ...f.idle, status: state }];
    const restarted = pq.createConsumer({ ...f.config, discoverPanes });
    const outcome = await restarted.drain();
    assert.equal(outcome.pending, 0, 'an ingested message cannot outlive the TTL');
    assert.equal(outcome.expiredPending, 1);
    assert.equal(outcome.delivered, 0);
    assert.equal(f.calls.length, 0, 'stale work must never reach a live composer');
    assert.ok(JSON.parse(fs.readFileSync(restarted._files.delivered, 'utf8')).includes(saved.id));
    const again = pq.createConsumer({ ...f.config, discoverPanes: () => [f.idle] });
    assert.equal((await again.drain()).pending, 0);
    assert.equal(f.calls.length, 0);
  });
}

test('pending expiry control: fresh message still delivers', async t => {
  const f = fixture(t);
  f.add('fresh');
  await pq.createConsumer(f.config).drain();
  f.advance(500);
  // Redirect advisory thread/result bookkeeping to the fixture too.
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = f.base;
  try {
    const outcome = await pq.createConsumer({ ...f.config, discoverPanes: () => [f.idle] }).drain();
    assert.equal(outcome.delivered, 1);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0], /fresh/);
  } finally { if (prior === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prior; }
});

test('pending expiry dry-run reports stale work without writing or sending', async t => {
  const f = fixture(t);
  f.add('old');
  const consumer = pq.createConsumer(f.config);
  await consumer.drain();
  const before = Object.fromEntries(Object.entries(consumer._files).filter(([,file]) => fs.existsSync(file)).map(([k,file]) => [k, fs.readFileSync(file, 'utf8')]));
  f.advance(1001);
  const outcome = await consumer.drain({ dryRun: true });
  assert.equal(outcome.wouldExpire, 1);
  assert.equal(outcome.wouldDeliver, 0);
  assert.equal(outcome.pending, 1);
  assert.equal(f.calls.length, 0);
  for (const [key, value] of Object.entries(before)) assert.equal(fs.readFileSync(consumer._files[key], 'utf8'), value);
});

test('listQueues killer: dead-letter archives are retained on disk but never treated as projects', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.base, 'queues'), { recursive: true });
  const names = ['wezbridge.jsonl', 'mutual.jsonl', '_dead-letter.jsonl', '_dead-letter.leido-20260825.jsonl', '_dead-letter-backup.jsonl'];
  for (const name of names) fs.writeFileSync(path.join(f.base, 'queues', name), 'archive');
  assert.deepEqual(pq.listQueues({ base: f.base }).sort(), ['mutual', 'wezbridge']);
  for (const name of names) assert.equal(fs.readFileSync(path.join(f.base, 'queues', name), 'utf8'), 'archive');
});
