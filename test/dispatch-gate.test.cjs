'use strict';

/**
 * dispatch-gate.test.cjs — T-0238: a type=request on a task corr whose ledger
 * card is blocked/gated is REFUSED at the sender, citing the card's real state.
 * Born from 2026-08-24: three envelopes claimed operator authorization while
 * the cards still showed intact blockers; executors caught all three by
 * reading the card (mm-6dbc). The card is the authority, not the envelope.
 */

const test = require('node:test');
const assert = require('node:assert');
const { checkDispatchGate } = require('../src/a2a-intel.cjs');

const cardReader = (cards) => (p) => {
  const m = p.match(/T-\d{4}/);
  if (!m || !cards[m[0]]) { const e = new Error('ENOENT'); throw e; }
  return JSON.stringify(cards[m[0]]);
};

test('T-0238: request on a BLOCKED card with an operator blocker is refused, citing the blocker', () => {
  const read = cardReader({ 'T-0222': { state: 'blocked', blocker: 'operator gate: rotar la service_role — decision requerida' } });
  const g = checkDispatchGate({ corr: 'T-0222', type: 'request', readFile: read });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /UNRESOLVED blocker/);
  assert.match(g.reason, /operator gate: rotar/, 'the refusal must cite the card, so the sender learns the real state');
});

test('T-0238: request on a READY card with empty blocker is allowed', () => {
  const read = cardReader({ 'T-0222': { state: 'ready', blocker: null } });
  const g = checkDispatchGate({ corr: 'T-0222', type: 'request', readFile: read });
  assert.strictEqual(g.allowed, true);
});

test('T-0238: a dispatchable STATE with a lingering blocker text still refuses — the race that fooled the night', () => {
  // The exact 2026-08-24 shape: state moved to running but the blocker text
  // was cleared LATE; the executor read blocker-intact and declined correctly.
  const read = cardReader({ 'T-0231': { state: 'running', blocker: 'operator gate: instalar lib en la NAS' } });
  const g = checkDispatchGate({ corr: 'T-0231', type: 'request', readFile: read });
  assert.strictEqual(g.allowed, false, 'state alone is not authorization while the blocker text stands');
});

test('T-0238: done/cancelled cards are not dispatchable', () => {
  const read = cardReader({ 'T-0220': { state: 'done', blocker: null } });
  const g = checkDispatchGate({ corr: 'T-0220', type: 'request', readFile: read });
  assert.strictEqual(g.allowed, false);
  assert.match(g.reason, /"done"/);
});

test('T-0238: fail-open where there is nothing provable — non-task corr, missing card, results/acks', () => {
  const read = cardReader({});
  assert.strictEqual(checkDispatchGate({ corr: 'traza-prod-live-20260823', type: 'request', readFile: read }).allowed, true, 'non-task corr is not gated');
  assert.strictEqual(checkDispatchGate({ corr: 'T-9999', type: 'request', readFile: read }).allowed, true, 'a missing card is not a gate');
  const blocked = cardReader({ 'T-0222': { state: 'blocked', blocker: 'operator gate' } });
  assert.strictEqual(checkDispatchGate({ corr: 'T-0222', type: 'result', readFile: blocked }).allowed, true, 'results/acks on a gated corr must flow — only new REQUESTS are gated');
});
