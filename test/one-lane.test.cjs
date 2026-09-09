'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lane = require('../src/one-lane.cjs');
const { createPinnedSend, assertPinnedTarget } = require('../src/pinned-send.cjs');
const order = { id: 'one', corr: 'lane-one', pane: 12, from_pane: 94,
  project: 'G:/Projects/crm', scope: 'read_only', body: 'Report cwd only.' };
const rootFor = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-lane-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('durable receipt precedes transport; same id never dispatches twice', async t => {
  const root = rootFor(t); let sends = 0;
  const call = async (name, args) => {
    sends++;
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'one/receipt.json'))).order.pane, 12);
    assert.equal(name, 'a2a_send'); assert.equal(args.expected_cwd, order.project);
    assert.equal(args.to_project, undefined);
    return { content: [{ text: JSON.stringify({ submitted: 'submitted', delivered: 'ok' }) }] };
  };
  assert.equal((await lane.dispatch({ root, input: order, call })).state, 'submitted');
  await assert.rejects(lane.dispatch({ root, input: order, call }), /EEXIST/);
  assert.equal(sends, 1);
});

test('transport throw remains durable and cannot be silently retried', async t => {
  const root = rootFor(t);
  const call = async () => { throw new Error('timeout after paste'); };
  assert.equal((await lane.dispatch({ root, input: order, call })).state, 'dispatch_uncertain');
  await assert.rejects(lane.dispatch({ root, input: order, call }), /EEXIST/);
  assert.match(fs.readFileSync(path.join(root, 'one/dispatch.json'), 'utf8'), /timeout after paste/);
});

test('invalid and protected scopes cannot dispatch', async t => {
  for (const scope of ['deploy', 'payments', 'outreach', 'customer', undefined]) {
    await assert.rejects(lane.dispatch({ root: rootFor(t), input: { ...order, scope },
      call: () => assert.fail('must not send') }), /invalid-order/);
  }
  assert.throws(() => lane.validateOrder({ ...order, id: '../escape' }), /invalid-order/);
});

test('unknown delivery and HTTP-like success never count as submission', () => {
  for (const response of [{ ok: true }, { content: [{ text: '{"submitted":"submitted","delivered":"unknown"}' }] }]) {
    assert.equal(lane.decodeTransport(response).state, 'dispatch_uncertain');
  }
});

test('pinned target rejects stale cwd, socket changes, empty and misleading scrollback', () => {
  const good = { paneId: 12, cwd: order.project, socket: 'a', currentSocket: 'a',
    panes: [{ pane_id: 12, cwd: 'file:///G:/Projects/crm/' }], text: 'cwd: G:\\Projects\\crm \uE0B6 Ready' };
  assert.doesNotThrow(() => assertPinnedTarget(good));
  for (const change of [{ currentSocket: 'b' }, { panes: [] }, { text: '' },
    { text: 'G:/Projects/crm in old output\ncwd: G:/Projects/infra \uE0B6 Ready' },
    { panes: [{ pane_id: 12, cwd: 'G:/Projects/other' }] }]) {
    assert.throws(() => assertPinnedTarget({ ...good, ...change }), /pinned-target-mismatch/);
  }
});

test('target changes after paste prevent Enter', async () => {
  let cwd = order.project; const writes = [];
  const wez = { currentSocket: () => 'a', invalidateListPanesCache() {}, invalidateGetTextCache() {},
    listPanes: () => [{ pane_id: 12, cwd }], getFullText: () => `cwd: ${cwd} \uE0B6 Ready\n>`,
    sendTextBracketed: () => { writes.push('paste'); cwd = 'G:/Projects/other'; },
    sendTextNoEnter: () => writes.push('enter'), sendText: () => writes.push('retry') };
  const sender = createPinnedSend({ paneId: 12, cwd: order.project, wez, sleep: async () => {} });
  await assert.rejects(sender.sendPromptDeferredEnter(12, 'read only request'), /pinned-target-mismatch/);
  assert.deepEqual(writes, ['paste']);
});

test('foreign composer refuses without paste or Enter', async () => {
  const wez = { currentSocket: () => 'a', invalidateListPanesCache() {}, invalidateGetTextCache() {},
    listPanes: () => [{ pane_id: 12, cwd: order.project }],
    getFullText: () => `cwd: ${order.project} \uE0B6 Ready\n> operator unsent text`,
    sendTextBracketed: () => assert.fail('paste'), sendTextNoEnter: () => assert.fail('enter') };
  const sender = createPinnedSend({ paneId: 12, cwd: order.project, wez });
  assert.equal((await sender.sendPromptDeferredEnter(12, 'request')).refused, 'composer-foreign-text');
});

test('result must match sender, receiver, correlation, time and criteria; receipt is not acceptance', async t => {
  const root = rootFor(t);
  const { dir } = await lane.dispatch({ root, input: order, call: async () => ({}) });
  const ledger = path.join(root, 'results.jsonl');
  const good = { corr: order.corr, from_pane: 12, to_pane: 94, time: new Date(Date.now() + 100).toISOString(),
    body: 'order: one\ncriteria:\n- cwd: pass - G:/Projects/crm\nfiles_changed: none\nnext_action: review' };
  for (const change of [{ corr: 'other' }, { from_pane: 99 }, { to_pane: 1 },
    { time: '2000-01-01' }, { body: 'done' }, { body: good.body.replace('order: one', 'order: other') }]) {
    fs.writeFileSync(ledger, JSON.stringify({ ...good, ...change }));
    assert.throws(() => lane.collect({ dir, ledger }), /no-matching-result/);
  }
  fs.writeFileSync(ledger, 'malformed\n' + JSON.stringify(good));
  assert.equal(lane.collect({ dir, ledger }).state, 'result_received_not_accepted');
});
