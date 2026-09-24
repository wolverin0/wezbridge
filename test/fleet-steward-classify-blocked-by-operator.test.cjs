'use strict';
/**
 * T-0486 — classify() decided `gated` by reading ONLY contract.gate / the
 * top-level gate field. auditUnrecordedDecisions() (same file) and
 * fleet-board.cjs's isOperatorWaiting already treat `blocked_by === 'operator'`
 * as an equally valid signal. The result: a blocked card whose KIND is
 * ungated, with blocked_by='operator' and a real stated blocker, was
 * classified `blocked-not-gated` (48h deadline, WILL expire and nag) instead
 * of `awaiting-operator` (no deadline — waiting on the operator by design).
 * Fail-first: before the fix this test asserts the WRONG (buggy) category
 * returned today, so the red run documents the bug rather than a typo.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const steward = require('../scripts/fleet-steward.cjs');

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test('AC1: blocked_by=operator with a real blocker, no gate anywhere, at 60h => awaiting-operator', () => {
  const t = {
    id: 'T-9001', repo: 'wezbridge', state: 'blocked', title: 'needs a call',
    contract: { gate: null }, gate: null,
    blocked_by: 'operator', blocker: 'need the operator to pick option A or B',
    state_changed_at: hoursAgo(60),
  };
  const r = steward.classify(t, NOW);
  assert.equal(r.category, 'awaiting-operator', 'blocked_by=operator with a stated blocker must be treated the same as an explicit gate');
});

test('AC2a: blocked_by=agent, at 60h, stays blocked-not-gated (no false positive from the fix)', () => {
  const t = {
    id: 'T-9002', repo: 'wezbridge', state: 'blocked', title: 'stuck on a dependency',
    contract: { gate: null }, gate: null,
    blocked_by: 'agent', blocker: 'waiting on T-9000 to land',
    state_changed_at: hoursAgo(60),
  };
  const r = steward.classify(t, NOW);
  assert.equal(r.category, 'blocked-not-gated', 'blocked_by=agent is not an operator wait, gate or no gate');
});

test('AC2b: blocked_by=operator with an EMPTY blocker, at 60h, stays blocked-not-gated', () => {
  const t = {
    id: 'T-9003', repo: 'wezbridge', state: 'blocked', title: 'no stated question',
    contract: { gate: null }, gate: null,
    blocked_by: 'operator', blocker: '',
    state_changed_at: hoursAgo(60),
  };
  const r = steward.classify(t, NOW);
  assert.equal(r.category, 'blocked-not-gated', 'an empty blocker does not buy the awaiting-operator exemption');
});

test('AC2b: blocked_by=operator with a MISSING blocker field, at 60h, stays blocked-not-gated', () => {
  const t = {
    id: 'T-9004', repo: 'wezbridge', state: 'blocked', title: 'no blocker field at all',
    contract: { gate: null }, gate: null,
    blocked_by: 'operator',
    state_changed_at: hoursAgo(60),
  };
  const r = steward.classify(t, NOW);
  assert.equal(r.category, 'blocked-not-gated', 'a missing blocker does not buy the awaiting-operator exemption either');
});
