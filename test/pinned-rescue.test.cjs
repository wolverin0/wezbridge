'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { call } = require('../scripts/one-lane.cjs');

async function send(t, mode, pinned = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-rescue-'));
  const old = { intel: process.env.WEZBRIDGE_INTEL_DIR, options: process.env.NODE_OPTIONS, failure: process.env.PINNED_TEST_FAILURE };
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  t.after(() => {
    restore('WEZBRIDGE_INTEL_DIR', old.intel); restore('NODE_OPTIONS', old.options); restore('PINNED_TEST_FAILURE', old.failure);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  process.env.PINNED_TEST_FAILURE = mode;
  const preload = path.resolve(__dirname, 'fixtures/pinned-rescue-preload.cjs').replace(/\\/g, '/');
  process.env.NODE_OPTIONS = `${old.options || ''} --require="${preload}"`;
  const response = await call('a2a_send', { from_pane: 99, to_pane: 1, type: 'request',
    corr: 'pinned-rescue-regression', body: 'Read-only test; no external actions.',
    ...(pinned ? { expected_cwd: '/wrong-project' } : {}) });
  return { response: response.result, queue: path.join(dir, 'queues/tmp.jsonl') };
}

test('pinned identity rejection must not be rescued into an unpinned queue', async t => {
  const { response, queue } = await send(t, 'guard');
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /pinned-target-mismatch/);
  assert.equal(fs.existsSync(queue), false, 'refused order must never become a later queue delivery');
  assert.doesNotMatch(response.content[0].text, /RESCUED/);
});

test('pinned transport exception after paste must not trigger automatic replay', async t => {
  const { response, queue } = await send(t, 'after-paste');
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /transport failed after paste/);
  assert.equal(fs.existsSync(queue), false, 'uncertain pinned send needs explicit reconciliation, not replay');
});

test('ordinary unpinned transport keeps existing durable rescue', async t => {
  const { response, queue } = await send(t, 'legacy', false);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /RESCUED/);
  assert.equal(fs.existsSync(queue), true);
});
