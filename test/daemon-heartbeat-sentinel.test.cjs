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

// ── T-0220: contention (probe fail + fresh beat) streaks before it alerts ──
test('T-0220: one failed probe with a fresh beat is SUSPECT, not an alert', () => {
  const liveness = assessLiveness({ heartbeat: freshBeat, daemonReachable: false, now: NOW });
  const d = evaluate({ liveness, state: {}, now: NOW });
  assert.strictEqual(d.verdict, 'suspect');
  assert.strictEqual(d.alert, false, 'the 2026-08-23 false-DOWN class: contention must not poke');
  assert.strictEqual(d.newState.httpFailStreak, 1);
});

test('T-0220: the streak escalates to an alert only after 3 consecutive runs', () => {
  const mkLiveness = (ts) => assessLiveness({ heartbeat: { ts }, daemonReachable: false, now: NOW });
  const beatNear = (offsetMs) => new Date(NOW + offsetMs - 10_000).toISOString(); // always ~10s fresh
  const r1 = evaluate({ liveness: mkLiveness(beatNear(0)), state: {}, now: NOW });
  const r2 = evaluate({ liveness: mkLiveness(beatNear(0)), state: r1.newState, now: NOW });
  assert.strictEqual(r2.verdict, 'suspect');
  assert.strictEqual(r2.alert, false);
  const r3 = evaluate({ liveness: mkLiveness(beatNear(0)), state: r2.newState, now: NOW });
  assert.strictEqual(r3.verdict, 'http-unresponsive');
  assert.strictEqual(r3.alert, true, 'a listener dead for 3 runs (~15 min) is a real fault');
  assert.match(r3.message, /HTTP UNRESPONSIVE/);
  assert.doesNotMatch(r3.message, /npm run dashboard/, 'must NOT prescribe a blind restart — check contention first');
  assert.ok(r3.newState.episodeStartedAt, 'escalation opens an episode');
});

test('T-0220: a healthy run resets the streak', () => {
  const failing = assessLiveness({ heartbeat: freshBeat, daemonReachable: false, now: NOW });
  const r1 = evaluate({ liveness: failing, state: {}, now: NOW });
  const healthy = assessLiveness({ heartbeat: freshBeat, daemonReachable: true, now: NOW });
  const r2 = evaluate({ liveness: healthy, state: r1.newState, now: NOW });
  assert.strictEqual(r2.verdict, 'healthy');
  assert.deepStrictEqual(r2.newState, {}, 'streak must not survive a healthy probe');
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
