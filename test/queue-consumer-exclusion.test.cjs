'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
// T-0596 item 4: legacy WezTerm-pane queue delivery, gated off by default — opt in for this file.
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const q = require('../src/project-queue.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-exclusive-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let writes = 0;
  const send = { sendPromptDeferredEnter: async () => { writes++; return 'ok'; }, verifyPromptSubmission: async () => 'submitted' };
  const create = () => q.createConsumer({ project: 'wezbridge', base, cooldownMs: 0, send,
    discoverPanes: () => [{ paneId: 7, agent: 'codex', status: 'idle', project: 'G:/test/wezbridge' }], logAction: () => {} });
  q.enqueue({ project: 'wezbridge', from_pane: 8, corr: 'race-fixture', type: 'request', body: 'one logical request', ok: false }, { base });
  return { base, create, send, writes: () => writes };
}

test('two consumers constructed before the first drain cannot replay stale state', async t => {
  const f = fixture(t), first = f.create(), second = f.create();
  await first.drain();
  await second.drain();
  assert.equal(f.writes(), 1);
  assert.equal(second.status().pending, 0);
});

test('overlapping consumers have one writer and the loser remains retryable', async t => {
  const f = fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const original = f.send.sendPromptDeferredEnter;
  f.send.sendPromptDeferredEnter = async () => { const r = await original(); entered(); await blocked; return r; };
  const first = f.create(), second = f.create();
  const pass = first.drain(); await writing;
  const other = second.drain();
  release();
  await Promise.all([pass, other]);
  await f.create().drain();
  assert.equal(f.writes(), 1);
});

function child(base, mode = 'normal') {
  const proc = fork(path.join(__dirname, 'helpers/queue-exclusion-child.cjs'), [base, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ready = new Promise(resolve => proc.once('message', resolve));
  const closed = new Promise(resolve => proc.once('exit', resolve));
  return { proc, ready, closed };
}

test('two actual processes plus a restarted third produce exactly one receiver write', async t => {
  const f = fixture(t), a = child(f.base), b = child(f.base);
  await Promise.all([a.ready, b.ready]); a.proc.send('go'); b.proc.send('go');
  assert.deepEqual(await Promise.all([a.closed, b.closed]), [0, 0]);
  const c = child(f.base); await c.ready; c.proc.send('go'); assert.equal(await c.closed, 0);
  const lines = fs.readFileSync(path.join(f.base, 'receiver.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});

test('process crash after receiver write leaves visible lock and never blindly repeats', async t => {
  const f = fixture(t), a = child(f.base, 'crash'); await a.ready; a.proc.send('go');
  assert.equal(await a.closed, 27);
  const c = f.create();
  assert.equal((await c.drain()).locked, true);
  assert.equal(f.writes(), 0);
  assert.equal(c.status().pending, 1);
  assert.equal(fs.readFileSync(path.join(f.base, 'receiver.jsonl'), 'utf8').trim().split('\n').length, 1);
});
