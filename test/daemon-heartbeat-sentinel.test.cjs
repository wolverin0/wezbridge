'use strict';

/**
 * daemon-heartbeat-sentinel.test.cjs — T-0186 acceptance criterion 3:
 * this suite FAILS if a dead daemon stops producing an alert.
 * Exercises evaluate() (pure decision) against assessLiveness's real output —
 * not hand-built liveness objects — so a wording change in the alerts that
 * breaks the sentinel's regex breaks these tests too (lesson of daemon-status
 * set(): tests that prove the rule but not the pipe miss real breaks).
 */

const test = require('node:test');
const assert = require('node:assert');
const { evaluate, REPOKE_MS } = require('../scripts/daemon-heartbeat-sentinel.cjs');
const { assessLiveness } = require('../src/daemon-status.cjs');

const NOW = Date.parse('2026-08-22T12:00:00Z');
const staleBeat = { ts: '2026-08-22T11:00:00Z' }; // 60 min old
const freshBeat = { ts: '2026-08-22T11:59:50Z' }; // 10s old

test('dead daemon (no HTTP, stale beat) MUST alert — the T-0186 regression guard', () => {
  const liveness = assessLiveness({ heartbeat: staleBeat, daemonReachable: false, now: NOW });
  const d = evaluate({ liveness, state: {}, now: NOW });
  assert.strictEqual(d.verdict, 'down');
  assert.strictEqual(d.alert, true, 'a dead daemon that produces no aviso is the exact defect this card exists to kill');
  assert.match(d.message, /DAEMON DOWN/);
  assert.ok(d.newState.episodeStartedAt, 'episode must open');
  assert.ok(d.newState.lastAlertAt, 'poke must be recorded');
});

test('dead daemon with NO heartbeat file ever written still alerts', () => {
  const liveness = assessLiveness({ heartbeat: null, daemonReachable: false, now: NOW });
  const d = evaluate({ liveness, state: {}, now: NOW });
  assert.strictEqual(d.alert, true);
  assert.match(d.message, /DAEMON DOWN/);
});

test('wedged daemon (HTTP up, stale beat) alerts as wedged', () => {
  const liveness = assessLiveness({ heartbeat: staleBeat, daemonReachable: true, now: NOW });
  const d = evaluate({ liveness, state: {}, now: NOW });
  assert.strictEqual(d.verdict, 'wedged');
  assert.strictEqual(d.alert, true);
  assert.match(d.message, /DAEMON WEDGED/);
});

test('healthy daemon: no alert, no episode', () => {
  const liveness = assessLiveness({ heartbeat: freshBeat, daemonReachable: true, now: NOW });
  const d = evaluate({ liveness, state: {}, now: NOW });
  assert.strictEqual(d.verdict, 'healthy');
  assert.strictEqual(d.alert, false);
  assert.strictEqual(d.recovered, false);
  assert.deepStrictEqual(d.newState, {});
});

test('cooldown: a second run inside REPOKE_MS does not re-poke, but keeps the episode', () => {
  const liveness = assessLiveness({ heartbeat: staleBeat, daemonReachable: false, now: NOW });
  const first = evaluate({ liveness, state: {}, now: NOW });
  const second = evaluate({ liveness, state: first.newState, now: NOW + 5 * 60_000 });
  assert.strictEqual(second.alert, false, '5 min later: still down, but no spam');
  assert.strictEqual(second.newState.episodeStartedAt, first.newState.episodeStartedAt);
  assert.strictEqual(second.newState.lastAlertAt, first.newState.lastAlertAt);
});

test('re-poke: after REPOKE_MS still down, it reminds', () => {
  const liveness = assessLiveness({ heartbeat: staleBeat, daemonReachable: false, now: NOW });
  const first = evaluate({ liveness, state: {}, now: NOW });
  const later = evaluate({ liveness, state: first.newState, now: NOW + REPOKE_MS + 1000 });
  assert.strictEqual(later.alert, true, 'an open episode past the cooldown re-alerts');
  assert.strictEqual(later.newState.episodeStartedAt, first.newState.episodeStartedAt, 'same episode');
});

test('recovery closes the episode and reports it', () => {
  const downLiveness = assessLiveness({ heartbeat: staleBeat, daemonReachable: false, now: NOW });
  const during = evaluate({ liveness: downLiveness, state: {}, now: NOW });
  const healthyLiveness = assessLiveness({ heartbeat: { ts: new Date(NOW + 10 * 60_000 - 5000).toISOString() }, daemonReachable: true, now: NOW + 10 * 60_000 });
  const after = evaluate({ liveness: healthyLiveness, state: during.newState, now: NOW + 10 * 60_000 });
  assert.strictEqual(after.verdict, 'healthy');
  assert.strictEqual(after.recovered, true, 'the close of an episode is itself evidence');
  assert.deepStrictEqual(after.newState, {});
});
