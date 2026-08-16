'use strict';
/**
 * Tests for the orchestrator turn's two decisions.
 *
 * These encode the corrections that came out of six failed orchestrators:
 *   - a clock that asks "anything to do?" is the failure; a trigger must carry
 *     a specific, already-identified reason, so shouldWake returns REASONS
 *   - "I could not see" is a reason to wake, never a reason to rest
 *   - productivity is measured in artifacts, never in effort
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldWake, turnWasProductive } = require('../scripts/orchestrator-turn.cjs');

// --- when to wake ----------------------------------------------------------

test('a green gate with nothing in review does NOT wake a model', () => {
  const r = shouldWake({ gateExit: 0, reviewCount: 0 });
  assert.equal(r.wake, false);
  assert.deepEqual(r.reasons, []);
});

test('a RED gate wakes, and says why', () => {
  const r = shouldWake({ gateExit: 1, reviewCount: 0 });
  assert.equal(r.wake, true);
  assert.match(r.reasons[0], /RED/);
});

test('UNKNOWN wakes too — a gate that could not see is not a clean gate', () => {
  const r = shouldWake({ gateExit: 3, reviewCount: 0 });
  assert.equal(r.wake, true);
  assert.match(r.reasons.join(' '), /could not read/);
});

test('an unrecognised gate exit wakes rather than being assumed fine', () => {
  // The whole family of bugs this repo keeps finding is an unhandled case
  // falling through to "clean". 137 (OOM-killed) must not read as green.
  for (const code of [2, 4, 137, -1]) {
    assert.equal(shouldWake({ gateExit: code, reviewCount: 0 }).wake, true, `exit ${code} was treated as fine`);
  }
});

test('finished work awaiting judgement wakes even when the gate is green', () => {
  // stale-review only fires at 72h. Fresh results deserve judging now, not in
  // three days, and the gate being green says nothing about them.
  const r = shouldWake({ gateExit: 0, reviewCount: 2 });
  assert.equal(r.wake, true);
  assert.match(r.reasons[0], /2 task/);
});

test('every wake carries at least one specific reason, never a bare "check things"', () => {
  for (const input of [{ gateExit: 1, reviewCount: 0 }, { gateExit: 3, reviewCount: 0 }, { gateExit: 0, reviewCount: 5 }]) {
    const r = shouldWake(input);
    assert.ok(r.reasons.length > 0 && r.reasons.every((x) => x.length > 12));
  }
});

// --- was the last turn real work? -----------------------------------------

const snap = (o = {}) => ({ rulings: 10, taskCount: 129, taskMtime: 1000, ...o });

test('a turn that wrote a ruling counts as productive', () => {
  assert.equal(turnWasProductive(snap(), snap({ rulings: 11 })), true);
});

test('a turn that edited a task counts as productive', () => {
  assert.equal(turnWasProductive(snap(), snap({ taskMtime: 2000 })), true);
  assert.equal(turnWasProductive(snap(), snap({ taskCount: 130 })), true);
});

test('a turn that changed NOTHING is unproductive, however much it did', () => {
  // The exact shape of attempt #5: awake, poked, reasoning, zero artifacts.
  assert.equal(turnWasProductive(snap(), snap()), false);
});

test('the first turn is never judged unproductive — there is nothing to compare', () => {
  assert.equal(turnWasProductive(null, snap()), true);
});
