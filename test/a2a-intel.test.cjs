'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the module at a temp intel dir BEFORE requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-intel-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP;
const intel = require('../src/a2a-intel.cjs');

test('detectV2: ok when criteria block with pass/fail verdicts present', () => {
  const body = 'Done.\ncriteria:\n- tokens expire: pass — tests/auth.test.ts\n- single-use: fail — see notes\nfiles_changed:\n- src/auth.ts';
  assert.strictEqual(intel.detectV2(body), 'ok');
});

test('detectV2: ok with acceptance_criteria spelling', () => {
  assert.strictEqual(intel.detectV2('acceptance_criteria:\n- build green: passed'), 'ok');
});

test('detectV2: missing for free-prose result', () => {
  assert.strictEqual(intel.detectV2('All done, everything works, deployed fine.'), 'missing');
});

test('detectV2: missing when verdict words appear without a criteria block', () => {
  assert.strictEqual(intel.detectV2('tests pass, lint passes'), 'missing');
});

test('recordEvent appends metadata lines to events.jsonl', () => {
  intel.recordEvent({ from_pane: 1, to_pane: 2, corr: 'evt-t1', type: 'request' });
  intel.recordEvent({ from_pane: 2, to_pane: 1, corr: 'evt-t1', type: 'result', v2: 'ok' });
  const lines = fs.readFileSync(path.join(TMP, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.event, 'a2a.sent');
  assert.strictEqual(last.corr, 'evt-t1');
  assert.strictEqual(last.v2, 'ok');
  assert.ok(last.time);
});

test('thread lifecycle: request opens, result awaits ack, ack closes', () => {
  const file = path.join(TMP, 'a2a-threads.json');
  intel.updateThreads({ fromPane: 10, toPane: 20, corr: 'th-1', type: 'request' });
  let threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-1'].state, 'open');
  assert.strictEqual(threads['th-1'].requester, 10);

  intel.updateThreads({ fromPane: 20, toPane: 10, corr: 'th-1', type: 'result' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-1'].state, 'awaiting-ack');
  assert.strictEqual(threads['th-1'].result_to, 10);

  intel.updateThreads({ fromPane: 10, toPane: 20, corr: 'th-1', type: 'ack' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-1'], undefined);
});

test('updateThreads returns corrs awaiting THIS pane\'s ack', () => {
  // pane 30 requests, pane 40 results back to 30 -> pane 30 owes an ack.
  intel.updateThreads({ fromPane: 30, toPane: 40, corr: 'th-2', type: 'request' });
  intel.updateThreads({ fromPane: 40, toPane: 30, corr: 'th-2', type: 'result' });
  // Next send BY pane 30 (any thread) must surface th-2 as unacked inbound.
  const owed = intel.updateThreads({ fromPane: 30, toPane: 99, corr: 'other', type: 'request' });
  assert.ok(owed.includes('th-2'));
  // Pane 40 sending again does NOT see th-2 (it is owed BY 30, not 40).
  const notOwed = intel.updateThreads({ fromPane: 40, toPane: 99, corr: 'other2', type: 'request' });
  assert.ok(!notOwed.includes('th-2'));
  // Cleanup: ack closes it.
  intel.updateThreads({ fromPane: 30, toPane: 40, corr: 'th-2', type: 'ack' });
});

test('gate line: progress body starting GATE:<kind>:<state> is recorded on the thread', () => {
  const file = path.join(TMP, 'a2a-threads.json');
  intel.updateThreads({ fromPane: 50, toPane: 60, corr: 'th-g1', type: 'request' });
  intel.updateThreads({
    fromPane: 60, toPane: 50, corr: 'th-g1', type: 'progress',
    body: 'GATE:customer-send:waiting — 5 staged sends need operator command\nmore detail below',
  });
  let threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g1'].gate.kind, 'customer-send');
  assert.strictEqual(threads['th-g1'].gate.state, 'waiting');
  assert.match(threads['th-g1'].gate.detail, /5 staged sends/);

  // A later gate line updates the state; case-insensitive, hyphen separator ok.
  intel.updateThreads({ fromPane: 60, toPane: 50, corr: 'th-g1', type: 'progress', body: 'gate:customer-send:cleared - operator approved' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g1'].gate.state, 'cleared');

  // A plain progress body PRESERVES the last gate, does not clear it.
  intel.updateThreads({ fromPane: 60, toPane: 50, corr: 'th-g1', type: 'progress', body: 'still working, 60% done' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g1'].gate.state, 'cleared');
  intel.updateThreads({ fromPane: 50, toPane: 60, corr: 'th-g1', type: 'ack' });
});

test('gate line: prose mentioning GATE mid-body is NOT parsed as a gate', () => {
  const file = path.join(TMP, 'a2a-threads.json');
  intel.updateThreads({ fromPane: 70, toPane: 80, corr: 'th-g2', type: 'request' });
  intel.updateThreads({ fromPane: 80, toPane: 70, corr: 'th-g2', type: 'progress', body: 'discussing the GATE:deploy:waiting convention in docs' });
  const threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g2'].gate, undefined);
  intel.updateThreads({ fromPane: 70, toPane: 80, corr: 'th-g2', type: 'ack' });
});

test('fail-soft: unwritable intel dir never throws', () => {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = path.join(TMP, 'no\0valid');
  assert.doesNotThrow(() => intel.recordEvent({ corr: 'x', type: 'request' }));
  assert.doesNotThrow(() => intel.updateThreads({ fromPane: 1, toPane: 2, corr: 'x', type: 'request' }));
  process.env.WEZBRIDGE_INTEL_DIR = prev;
});
