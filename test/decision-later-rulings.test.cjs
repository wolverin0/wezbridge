'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRelay } = require('../src/decision-relay.cjs');
const { createConsumer, enqueue } = require('../src/project-queue.cjs');
const { decisionDisposition } = require('../src/decision-authority.cjs');
const cases = require('./fixtures/decision-later-rulings.json');

function setup(t, c) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'later-ruling-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'tasks'));
  fs.writeFileSync(path.join(base, 'tasks', `${c.task}.json`), JSON.stringify(c.card));
  fs.writeFileSync(path.join(base, 'rulings.jsonl'), c.history.map(r => JSON.stringify(r)).join('\n') + '\n');
  return base;
}

for (const c of cases) {
  test(`${c.task} real sequence: later non-neutral ruling blocks historical approval in producer AND queue`, async t => {
    const base = setup(t, c);
    const sent = [];
    const send = { sendPromptDeferredEnter: async (_, body) => { sent.push(body); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted' };
    const discoverPanes = () => [{ paneId: 9, project: `G:/x/${c.card.repo}`, agent: 'claude', status: 'idle', lastLines: '' }];
    await createRelay({ intelDir: base, send, discoverPanes }).relayOnce();
    assert.equal(sent.length, 0, 'no obsolete approval instruction reaches transport');
    enqueue({ project: c.card.repo, corr: c.task, type: 'request', from_project: 'decision-relay',
      ruling: 'approved', decision_at: c.history[0].at, ok: false,
      body: `[decision] operator approved ${c.task}: historical WRITE` }, { base });
    await createConsumer({ project: c.card.repo, base, send, discoverPanes, logAction: () => {} }).drain();
    assert.equal(sent.length, 0, 'queue must not revive the obsolete approval either');
  });
}

test('dispatched is explicitly neutral; later gate still wins; unknown future verbs never authorize', t => {
  const original = cases[0];
  const approval = original.history[0];
  const c = { ...original, history: [approval, { ...approval, ruling: 'dispatched' }] };
  const base = setup(t, c);
  const check = () => decisionDisposition({ intel: base, task: c.task, ruling: 'approved', at: approval.at });
  assert.equal(check().status, 'allow', 'assigning a worker does not revoke operator approval');
  for (const word of ['operator-gated', 'deferred', 'resolved', 'future-verdict']) {
    fs.appendFileSync(path.join(base, 'rulings.jsonl'), JSON.stringify({ ...approval, ruling: word }) + '\n');
    fs.appendFileSync(path.join(base, 'rulings.jsonl'), JSON.stringify({ ...approval, ruling: 'dispatched' }) + '\n');
    assert.notEqual(check().status, 'allow', `${word} must not be skipped to find an old approval`);
  }
  assert.equal(check().status, 'unknown', 'an unrecognized directive stays held for review');
});
