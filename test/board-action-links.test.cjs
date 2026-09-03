'use strict';
/**
 * board-action-links.test.cjs — signed action URLs for the tablero (T-0334).
 *
 * A decision pushed to the central de avisos carries actions the operator taps
 * from a phone. The phone has no x-board-token, so the URL itself must be the
 * credential: an HMAC over (task, verb, exp) keyed from BOARD_TOKEN. What must
 * never regress: a tampered task/verb/exp fails, an expired link fails, and an
 * unknown verb is never signed.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  signAction, verifyAction, buildActionUrl, ACTION_VERBS,
} = require('../board-app/lib/action-links.cjs');

const TOKEN = 'board-token-for-tests';
const NOW = Date.parse('2026-09-03T20:00:00Z');

test('sign/verify round-trips for every allowed verb', () => {
  for (const verb of Object.keys(ACTION_VERBS)) {
    const exp = Math.floor(NOW / 1000) + 3600;
    const sig = signAction(TOKEN, { task: 'T-0334', verb, exp });
    const v = verifyAction(TOKEN, { task: 'T-0334', verb, exp, sig }, NOW);
    assert.strictEqual(v.ok, true, `${verb}: ${v.error}`);
  }
});

test('a tampered task, verb or exp fails verification', () => {
  const exp = Math.floor(NOW / 1000) + 3600;
  const sig = signAction(TOKEN, { task: 'T-0334', verb: 'approved', exp });
  assert.strictEqual(verifyAction(TOKEN, { task: 'T-0335', verb: 'approved', exp, sig }, NOW).ok, false, 'task');
  assert.strictEqual(verifyAction(TOKEN, { task: 'T-0334', verb: 'cancelled', exp, sig }, NOW).ok, false, 'verb');
  assert.strictEqual(verifyAction(TOKEN, { task: 'T-0334', verb: 'approved', exp: exp + 1, sig }, NOW).ok, false, 'exp');
  assert.strictEqual(verifyAction('other-token', { task: 'T-0334', verb: 'approved', exp, sig }, NOW).ok, false, 'key');
});

test('an expired link fails closed with a readable reason', () => {
  const exp = Math.floor(NOW / 1000) - 1;
  const sig = signAction(TOKEN, { task: 'T-0334', verb: 'approved', exp });
  const v = verifyAction(TOKEN, { task: 'T-0334', verb: 'approved', exp, sig }, NOW);
  assert.strictEqual(v.ok, false);
  assert.match(v.error, /expir/i);
});

test('unknown verbs are refused at signing time', () => {
  assert.throws(() => signAction(TOKEN, { task: 'T-0334', verb: 'merged', exp: 1 }), /verb/);
});

test('buildActionUrl yields an absolute /act URL whose query verifies', () => {
  const url = buildActionUrl('http://192.168.1.10:4272/', TOKEN, { task: 'T-0334', verb: 'deferred', now: NOW, ttlSec: 7 * 86400 });
  const u = new URL(url);
  assert.strictEqual(u.pathname, '/act');
  const q = Object.fromEntries(u.searchParams);
  assert.strictEqual(q.task, 'T-0334');
  assert.strictEqual(q.verb, 'deferred');
  assert.strictEqual(Number(q.exp), Math.floor(NOW / 1000) + 7 * 86400);
  assert.strictEqual(verifyAction(TOKEN, q, NOW).ok, true);
  // still valid one day before expiry, dead one second after
  assert.strictEqual(verifyAction(TOKEN, q, NOW + 6 * 86400 * 1000).ok, true);
  assert.strictEqual(verifyAction(TOKEN, q, NOW + 7 * 86400 * 1000 + 1000).ok, false);
});

test('a malformed query (missing sig, non-numeric exp) fails without throwing', () => {
  assert.strictEqual(verifyAction(TOKEN, { task: 'T-1', verb: 'approved', exp: 'x', sig: 'ff' }, NOW).ok, false);
  assert.strictEqual(verifyAction(TOKEN, { task: 'T-1', verb: 'approved', exp: 1 }, NOW).ok, false);
  assert.strictEqual(verifyAction(TOKEN, null, NOW).ok, false);
});
