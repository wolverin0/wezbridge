'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const heartbeat = require(path.resolve(__dirname, '..', 'src', 'a2a-heartbeat.cjs'));
const { isA2ASilent, findSilentEntries, startWatcher } = heartbeat;

const NOW = Date.parse('2026-05-07T20:00:00Z');
const T = 5 * 60 * 1000;

// isA2ASilent ----------------------------------------------------------

test('isA2ASilent: active + lastProgressAt > threshold ago = silent', () => {
  const info = { status: 'active', firstSeen: NOW - 10*60*1000, lastSeen: NOW - 6*60*1000, lastProgressAt: NOW - 6*60*1000 };
  assert.equal(isA2ASilent(info, NOW, T), true);
});

test('isA2ASilent: active + recent lastProgressAt = NOT silent', () => {
  const info = { status: 'active', firstSeen: NOW - 10*60*1000, lastProgressAt: NOW - 30*1000 };
  assert.equal(isA2ASilent(info, NOW, T), false);
});

test('isA2ASilent: resolved status = NOT silent', () => {
  const info = { status: 'resolved', firstSeen: NOW - 10*60*1000, lastProgressAt: NOW - 10*60*1000 };
  assert.equal(isA2ASilent(info, NOW, T), false);
});

test('isA2ASilent: orphaned status = NOT silent', () => {
  const info = { status: 'orphaned', firstSeen: NOW - 10*60*1000 };
  assert.equal(isA2ASilent(info, NOW, T), false);
});

test('isA2ASilent: missing lastProgressAt falls back to lastSeen', () => {
  const info = { status: 'active', firstSeen: NOW - 10*60*1000, lastSeen: NOW - 7*60*1000 };
  assert.equal(isA2ASilent(info, NOW, T), true);
});

test('isA2ASilent: null/undefined info safe', () => {
  assert.equal(isA2ASilent(null, NOW, T), false);
  assert.equal(isA2ASilent(undefined, NOW, T), false);
});

// findSilentEntries ----------------------------------------------------

test('findSilentEntries: returns only active+stale+un-notified entries', () => {
  const state = new Map([
    ['c1', { corr: 'c1', status: 'active', lastProgressAt: NOW - 6*60*1000 }],     // silent
    ['c2', { corr: 'c2', status: 'active', lastProgressAt: NOW - 30*1000 }],         // fresh
    ['c3', { corr: 'c3', status: 'resolved', lastProgressAt: NOW - 10*60*1000 }],    // resolved
    ['c4', { corr: 'c4', status: 'active', lastProgressAt: NOW - 6*60*1000, notified_silent: true }], // already notified
  ]);
  const out = findSilentEntries(state, NOW, T);
  assert.equal(out.length, 1);
  assert.equal(out[0].corr, 'c1');
});

test('findSilentEntries: empty map returns []', () => {
  const out = findSilentEntries(new Map(), NOW, T);
  assert.deepEqual(out, []);
});

test('findSilentEntries: null state returns []', () => {
  const out = findSilentEntries(null, NOW, T);
  assert.deepEqual(out, []);
});

// startWatcher ---------------------------------------------------------

test('startWatcher: throws if a2aState missing', () => {
  assert.throws(() => startWatcher({ broadcastSSE: () => {} }), /a2aState and broadcastSSE/);
});

test('startWatcher: throws if broadcastSSE missing', () => {
  assert.throws(() => startWatcher({ a2aState: new Map() }), /a2aState and broadcastSSE/);
});

test('startWatcher: emits one event per silent entry, then marks notified', async () => {
  const state = new Map([
    ['c1', { corr: 'c1', status: 'active', from: 7, to: 3, lastProgressAt: Date.now() - 10*60*1000 }],
  ]);
  const events = [];
  const stop = startWatcher({
    a2aState: state,
    broadcastSSE: (e) => events.push(e),
    intervalMs: 30,
    thresholdMs: 5 * 60 * 1000,
  });
  await new Promise((r) => setTimeout(r, 100)); // 3 ticks
  stop();
  assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
  assert.equal(events[0].type, 'a2a_silent');
  assert.equal(events[0].corr, 'c1');
  assert.equal(events[0].from, 7);
  assert.equal(events[0].to, 3);
  assert.equal(state.get('c1').notified_silent, true);
});

test('startWatcher: stop fn halts subsequent emissions', async () => {
  const state = new Map([
    ['c1', { corr: 'c1', status: 'active', lastProgressAt: Date.now() - 10*60*1000 }],
    ['c2', { corr: 'c2', status: 'active', lastProgressAt: Date.now() - 10*60*1000 }],
  ]);
  const events = [];
  const stop = startWatcher({
    a2aState: state,
    broadcastSSE: (e) => events.push(e),
    intervalMs: 20,
    thresholdMs: 5 * 60 * 1000,
  });
  await new Promise((r) => setTimeout(r, 50));
  stop();
  const countAtStop = events.length;
  // Add a third silent entry AFTER stop — should NOT be emitted
  state.set('c3', { corr: 'c3', status: 'active', lastProgressAt: Date.now() - 10*60*1000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.length, countAtStop);
});
