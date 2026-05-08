'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createRegistry, DEFAULT_MAX } = require(path.resolve(__dirname, '..', 'src', 'grades-registry.cjs'));

test('record + get roundtrip', () => {
  const reg = createRegistry();
  reg.record('pane-12', { result: 'satisfied', explanation: 'ok' });
  const got = reg.get('pane-12');
  assert.equal(got.key, 'pane-12');
  assert.equal(got.grade.result, 'satisfied');
});

test('record: ignores invalid input', () => {
  const reg = createRegistry();
  reg.record('', { result: 'satisfied' });
  reg.record('k', null);
  reg.record('k', 'not-an-object');
  assert.equal(reg.size(), 0);
});

test('record: re-recording same key updates + bumps recency', () => {
  const reg = createRegistry();
  reg.record('k', { result: 'satisfied' });
  reg.record('k', { result: 'needs_revision' });
  assert.equal(reg.size(), 1);
  assert.equal(reg.get('k').grade.result, 'needs_revision');
});

test('LRU evicts oldest at max', () => {
  const reg = createRegistry({ max: 3 });
  reg.record('a', { result: 'satisfied' });
  reg.record('b', { result: 'satisfied' });
  reg.record('c', { result: 'satisfied' });
  reg.record('d', { result: 'satisfied' });
  assert.equal(reg.size(), 3);
  assert.equal(reg.get('a'), null); // evicted
  assert.ok(reg.get('d'));
});

test('LRU: re-inserting bumps key to most-recent slot', () => {
  const reg = createRegistry({ max: 3 });
  reg.record('a', { result: 'satisfied' });
  reg.record('b', { result: 'satisfied' });
  reg.record('a', { result: 'needs_revision' });   // bump a
  reg.record('c', { result: 'satisfied' });
  reg.record('d', { result: 'satisfied' });
  // b should be evicted (oldest after a's bump), a should remain
  assert.ok(reg.get('a'));
  assert.equal(reg.get('b'), null);
});

test('list: returns entries newest-first', async () => {
  const reg = createRegistry();
  reg.record('a', { result: 'satisfied' });
  await new Promise((r) => setTimeout(r, 5));
  reg.record('b', { result: 'satisfied' });
  await new Promise((r) => setTimeout(r, 5));
  reg.record('c', { result: 'satisfied' });
  const all = reg.list();
  assert.equal(all[0].key, 'c');
  assert.equal(all[2].key, 'a');
});

test('broadcast: invoked with outcome_grade event on record', () => {
  const events = [];
  const reg = createRegistry({ broadcast: (e) => events.push(e) });
  reg.record('pane-12', { result: 'satisfied', explanation: 'all good' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'outcome_grade');
  assert.equal(events[0].key, 'pane-12');
  assert.equal(events[0].grade.result, 'satisfied');
});

test('broadcast errors do not crash record', () => {
  const reg = createRegistry({ broadcast: () => { throw new Error('boom'); } });
  // Should not throw
  reg.record('k', { result: 'satisfied' });
  assert.equal(reg.size(), 1);
});

test('clear empties the registry', () => {
  const reg = createRegistry();
  reg.record('a', { result: 'satisfied' });
  reg.clear();
  assert.equal(reg.size(), 0);
});

test('DEFAULT_MAX is exported and reasonable', () => {
  assert.equal(typeof DEFAULT_MAX, 'number');
  assert.ok(DEFAULT_MAX >= 50 && DEFAULT_MAX <= 1000);
});
