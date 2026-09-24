'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// T-0596 item 4: this file exercises legacy WezTerm-pane queue delivery
// (createConsumer with discoverPanes agent panes), gated off by default —
// opt back in for this whole file so the existing coverage still exercises it.
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const { createRelay } = require('../src/decision-relay.cjs');
const { createConsumer, enqueue } = require('../src/project-queue.cjs');
const AT = '2026-09-07T10:00:00.000Z';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-current-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'tasks'));
  fs.writeFileSync(path.join(base, 'rulings.jsonl'), '');
  const card = state => fs.writeFileSync(path.join(base, 'tasks/T-0262.json'), JSON.stringify({
    id: 'T-0262', repo: 'infra', state, gate: null, next_action: 'DELETE the old database rows' }));
  const ruling = (word, at = AT, why = word === 'approved' ? 'execute DELETE' : 'NO WRITES') => {
    fs.appendFileSync(path.join(base, 'rulings.jsonl'), JSON.stringify({ task: 'T-0262',
      ruling: word, at, why, source: 'board-app' }) + '\n');
  };
  const sends = [];
  const send = { sendPromptDeferredEnter: async (_, text) => { sends.push(text); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted' };
  const panes = [{ paneId: 9, project: 'G:/x/infra', agent: 'claude', status: 'idle', lastLines: '' }];
  const relay = (busy = false) => createRelay({ intelDir: base, send,
    discoverPanes: () => panes.map(p => ({ ...p, status: busy ? 'working' : 'idle' })) });
  const consumer = () => createConsumer({ base, project: 'infra', send, discoverPanes: () => panes, logAction: () => {} });
  card('ready');
  return { base, card, ruling, sends, send, relay, consumer };
}

test('T-0262: historical approval followed by cancellation can never execute the cancelled work', async t => {
  const f = fixture(t);
  f.ruling('approved');
  f.ruling('cancelled', '2026-09-07T10:00:16.000Z');
  f.card('cancelled');
  const out = await f.relay().relayOnce();
  assert.equal(f.sends.filter(s => s.includes('[decision] operator approved')).length, 0,
    'business consequence: no DELETE instruction may reach the worker after cancellation');
  assert.equal(f.sends.length, 1, 'the current cancellation still reaches the owner');
  assert.match(f.sends[0], /\[decision\] operator cancelled T-0262:/);
  assert.doesNotMatch(f.sends[0], /next_action: DELETE/, 'cancelled does not inherit the old execution step');
  assert.equal(out.delivered[0].ruling, 'cancelled');
  await f.relay().relayOnce();
  assert.equal(f.sends.length, 1, 'restart does not replay a discarded approval');
});

test('queue rechecks cancellation after enqueue, before send; a later valid approval still delivers once', async t => {
  const f = fixture(t);
  f.ruling('approved');
  await f.relay(true).relayOnce();
  f.ruling('cancelled', '2026-09-07T10:00:16.000Z');
  f.card('cancelled');
  await f.consumer().drain();
  assert.equal(f.sends.length, 0, 'pending historical approval must not execute');
  await f.consumer().drain();
  assert.equal(f.sends.length, 0, 'suppression survives consumer restart');
  const suppressed = JSON.parse(fs.readFileSync(path.join(f.base, 'queues/state/infra/suppressed.json')));
  assert.equal(Object.keys(suppressed).length, 1, 'suppression has its own evidence, not a delivery mark');
  f.card('ready');
  f.ruling('approved', '2026-09-07T10:05:00.000Z', 'new bounded operation');
  await f.relay(true).relayOnce();
  await f.consumer().drain();
  assert.equal(f.sends.length, 1, 'positive control reaches actual transport');
  assert.match(f.sends[0], /new bounded operation/);
  await f.consumer().drain();
  assert.equal(f.sends.length, 1, 'real consumer delivery state prevents replay despite immutable ok:false row');
});

test('queue will not trust a legacy approval without ruling identity or unreadable current authority', async t => {
  const f = fixture(t);
  f.ruling('approved');
  enqueue({ project: 'infra', corr: 'T-0262', type: 'request', from_project: 'decision-relay',
    ruling: 'approved', body: '[decision] operator approved T-0262: execute DELETE', ok: false }, { base: f.base });
  await f.consumer().drain();
  assert.equal(f.sends.length, 0, 'unproven legacy approvals are held, not guessed current');
  assert.equal(f.consumer().status().flagged, 1, 'the held decision is visible for review');
  const g = fixture(t);
  g.ruling('approved');
  await g.relay(true).relayOnce();
  fs.writeFileSync(path.join(g.base, 'rulings.jsonl'), '{broken\n');
  await g.consumer().drain();
  assert.equal(g.sends.length, 0, 'an unreadable authority file cannot authorize transport');
  fs.writeFileSync(path.join(g.base, 'rulings.jsonl'), '');
  g.ruling('approved');
  await g.consumer().drain();
  assert.equal(g.sends.length, 1, 'restored authority permits the valid pending decision');
  assert.equal(g.consumer().status().flagged, 0, 'recovery clears only the temporary decision hold');
});

test('canonical append order wins over timestamps and queue rechecks between individual sends', async t => {
  const f = fixture(t);
  f.ruling('approved', '2026-09-07T10:05:00.000Z');
  f.ruling('cancelled', AT);
  await f.relay().relayOnce();
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0], /operator cancelled/);
  const g = fixture(t);
  g.ruling('approved');
  enqueue({ project: 'infra', corr: 'ordinary', type: 'request', body: 'ordinary message', ok: false }, { base: g.base });
  await g.relay(true).relayOnce();
  g.send.sendPromptDeferredEnter = async (_, body) => {
    g.sends.push(body);
    g.ruling('cancelled', '2026-09-07T10:00:20.000Z');
    g.card('cancelled');
    return 'ok';
  };
  await g.consumer().drain();
  assert.equal(g.sends.length, 1, 'cancellation observed after the first send blocks the next decision');
  assert.match(g.sends[0], /ordinary message/);
});

test('same-verdict correction within two seconds delivers the current instructions, not the old body', async t => {
  const f = fixture(t);
  f.ruling('approved', AT, 'old unrestricted operation');
  f.ruling('approved', '2026-09-07T10:00:02.000Z', 'new read-only operation');
  await f.relay().relayOnce();
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0], /new read-only operation/);
  assert.doesNotMatch(f.sends[0], /old unrestricted operation/);
});
