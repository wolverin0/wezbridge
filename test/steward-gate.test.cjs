'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gate = require('../scripts/steward-gate.cjs');

const H = 3600000;
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

const finding = (over = {}) => ({
  id: 'T-0001', repo: 'brlite', state: 'ready', title: 'a task',
  owner: null, age_hours: 100, category: 'idle', why: 'nobody has picked this up', ...over,
});

// ---------------------------------------------------------------------------
// The gate exists to CONTRADICT "nothing needs you". These prove it can.
// ---------------------------------------------------------------------------

test('RED: a past-deadline finding with no ruling', () => {
  const r = gate.evaluate({ findings: [finding()], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'RED', 'an idle task at 100h with no ruling must fail the gate');
  assert.strictEqual(r.unruled[0].id, 'T-0001');
});

test('GREEN: a finding that has not reached its deadline yet', () => {
  const r = gate.evaluate({ findings: [finding({ age_hours: 12 })], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'GREEN', 'idle for 12h is not yet owed a ruling');
});

test('GREEN: cancelled is permanent', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'cancelled', why: 'dead project', at: iso(-500 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'a cancelled task must never be raised again');
});

test('GREEN: operator-gated is permanent', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'operator-gated', at: iso(-999 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'waiting on the operator IS the correct state');
});

// ---------------------------------------------------------------------------
// THE ANTI-WOLF PROPERTY — the veto condition for shipping this at all.
// An artifact that fires on compliant behaviour is worse than none.
// ---------------------------------------------------------------------------

test('ANTI-WOLF: a deferred task stays green across many ticks and ages', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', why: 'parked', until: iso(240 * H), at: iso(0) }];
  for (let tick = 0; tick < 25; tick += 1) {
    const now = NOW + tick * 4 * H;              // a tick every 4h for ~4 days
    const r = gate.evaluate({ findings: [finding({ age_hours: 100 + tick * 4 })], rulings, now });
    assert.strictEqual(r.verdict, 'GREEN', `tick ${tick}: a correctly parked task must not fire`);
  }
});

test('a deferral RE-RAISES once its until passes', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(10 * H), at: iso(0) }];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 9 * H }).verdict, 'GREEN');
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 11 * H }).verdict, 'RED',
    'a deferral is a pause, not an erasure');
});

test('a deferral with NO until is not a ruling — a shrug must not silence anything', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'deferred', why: 'later', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
});

// ---------------------------------------------------------------------------
// Situation changes must re-open the judgement.
// ---------------------------------------------------------------------------

test('a ruling does NOT carry over when the category changes', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(500 * H), at: iso(0) }];
  const r = gate.evaluate({ findings: [finding({ category: 'abandoned-lease', age_hours: 30 })], rulings, now: NOW });
  assert.strictEqual(r.verdict, 'RED', 'parked-while-idle must not silence a crashed lease');
});

test('dispatched expires after the grace window so a swallowed dispatch resurfaces', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'dispatched', at: iso(0) }];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 5 * H }).verdict, 'GREEN');
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 30 * H }).verdict, 'RED',
    'if a dispatch never moved the task, the gate must ask again');
});

test('the LATEST ruling wins, so a decision can be revised by appending', () => {
  const rulings = [
    { task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(1 * H), at: iso(-10 * H) },
    { task: 'T-0001', category: 'idle', ruling: 'cancelled', at: iso(-1 * H) },
  ];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 50 * H }).verdict, 'GREEN');
});

test('awaiting-operator is never gated — it is the correct resting state', () => {
  const r = gate.evaluate({ findings: [finding({ category: 'awaiting-operator', age_hours: 9999 })], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'GREEN');
});

test('an unknown ruling word covers nothing', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'noted', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED', '"noted" is narration, and narration is what this gate exists to defeat');
});

test('a ruling for a DIFFERENT task does not cover this one', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-9999', category: 'idle', ruling: 'cancelled', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
});

test('mixed board: one ruled, one not — RED, and it names the unruled one', () => {
  const r = gate.evaluate({
    findings: [finding({ id: 'T-A' }), finding({ id: 'T-B' })],
    rulings: [{ task: 'T-A', category: 'idle', ruling: 'cancelled', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
  assert.strictEqual(r.unruled.length, 1);
  assert.strictEqual(r.unruled[0].id, 'T-B');
});
