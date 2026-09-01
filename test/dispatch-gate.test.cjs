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

// ── R2 (2026-08-24): result-shape enforcement — validate the draft before transport ──

const { checkResultShape, takeDispatchLease } = require('../src/a2a-intel.cjs');

test('R2: a type=result WITHOUT a criteria block is refused with an actionable template', () => {
  const r = checkResultShape({ type: 'result', body: 'todo listo, quedó andando, saludos' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.shape, 'missing');
  assert.match(r.reason, /criteria:/, 'the refusal must show the sender the exact block to add');
});

test('R2: a criteria block without pass|fail verdicts is refused as partial', () => {
  const r = checkResultShape({ type: 'result', body: 'criteria:\n- deploy: quedó bien\n- tests: corrieron' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.shape, 'partial');
  assert.match(r.reason, /pass\|fail/);
});

test('R2: a well-formed v2 result passes; non-results are never shape-checked', () => {
  const ok = checkResultShape({ type: 'result', body: 'criteria:\n- deploy: pass — health 200\n- tests: pass — 88/88' });
  assert.strictEqual(ok.allowed, true);
  assert.strictEqual(checkResultShape({ type: 'request', body: 'hacé X' }).allowed, true);
  assert.strictEqual(checkResultShape({ type: 'ack', body: 'recibido' }).allowed, true);
});

test('R2: WEZBRIDGE_RESULT_SHAPE_ENFORCE=0 reverts to warn-only', () => {
  process.env.WEZBRIDGE_RESULT_SHAPE_ENFORCE = '0';
  try {
    assert.strictEqual(checkResultShape({ type: 'result', body: 'prosa sin criteria' }).allowed, true);
  } finally {
    delete process.env.WEZBRIDGE_RESULT_SHAPE_ENFORCE;
  }
});

// ── M1 (2026-08-24): lease-on-dispatch — running-without-owner dies here ──

test('M1: a request on a task corr takes the lease for the executor', () => {
  const calls = [];
  const r = takeDispatchLease({ corr: 'T-0231', type: 'request', owner: 'infra', runLease: (id, own, min) => { calls.push([id, own, min]); return '{}'; } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, [['T-0231', 'infra', 90]]);
  assert.deepStrictEqual(r.leased, { corr: 'T-0231', owner: 'infra', minutes: 90 });
});

test('M1: a PROVABLE lease conflict refuses the dispatch, naming the current owner', () => {
  const r = takeDispatchLease({
    corr: 'T-0222', type: 'request', owner: 'infra',
    runLease: () => { throw new Error('task T-0222 already leased by mutual until 2026-08-25T00:00:00Z'); },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /already leased by mutual/);
});

test('M1: lease plumbing failure fails OPEN — comms never die with the ledger', () => {
  const r = takeDispatchLease({ corr: 'T-0231', type: 'request', owner: 'infra', runLease: () => { throw new Error('ENOENT: ledger.cjs not found'); } });
  assert.strictEqual(r.ok, true);
  assert.match(r.warning, /lease not taken/);
});

test('M1: non-requests and non-task corrs never touch the ledger', () => {
  const boom = () => { throw new Error('must not be called'); };
  assert.strictEqual(takeDispatchLease({ corr: 'T-0222', type: 'result', owner: 'x', runLease: boom }).ok, true);
  assert.strictEqual(takeDispatchLease({ corr: 'grill-rulings', type: 'request', owner: 'x', runLease: boom }).ok, true);
});

// ── W2 (2026-09-01): UN solo parser de corr para gate, lease y linker ──────
//
// Convención Eve: `<T-id>:<slug>:<yyyymmdd>`, mutada a `:rN` en revisiones. El
// gate y la lease matcheaban `^T-\d{4}$` pelado, así que TODA tarjeta despachada
// con la convención nueva salía sin gate y sin dueño — el agujero exacto que
// T-0238 y M1 existen para tapar, reabierto por un prefijo.

const { taskIdFromCorr } = require('../src/a2a-intel.cjs');

test('W2: taskIdFromCorr recorta la revisión y acepta el prefijo; el guion NO matchea', () => {
  assert.strictEqual(taskIdFromCorr('T-0301'), 'T-0301');
  assert.strictEqual(taskIdFromCorr('T-0301:eve-graph-gate:20260901'), 'T-0301');
  assert.strictEqual(taskIdFromCorr('T-0301:eve-graph-gate:20260901:r2'), 'T-0301', 'una revisión sigue siendo la misma tarjeta');
  assert.strictEqual(taskIdFromCorr('T-0301:r12'), 'T-0301');
  // DELIBERADO: los corrs con guion nunca fueron gateados y matchearlos ahora
  // gatearía retroactivamente hilos vivos que nadie declaró como tarjeta.
  assert.strictEqual(taskIdFromCorr('T-0121-foo'), null, 'corr con guion: NO es una tarjeta');
  assert.strictEqual(taskIdFromCorr('traza-prod-live-20260823'), null);
  assert.strictEqual(taskIdFromCorr(''), null);
  assert.strictEqual(taskIdFromCorr(null), null);
});

test('W2: prefixed corr still hits the gate — una tarjeta bloqueada sigue bloqueada con corr de Eve', () => {
  const read = cardReader({ 'T-0301': { state: 'blocked', blocker: 'operator gate: rotar la key' } });
  const g = checkDispatchGate({ corr: 'T-0301:x:20260901', type: 'request', readFile: read });
  assert.strictEqual(g.allowed, false, 'el prefijo no puede ser una puerta trasera al gate');
  assert.match(g.reason, /UNRESOLVED blocker/);
  assert.match(g.reason, /rotar la key/);
});

test('W2: prefixed corr still takes the lease — nadie despacha a Eve sin dueño', () => {
  const calls = [];
  const r = takeDispatchLease({
    corr: 'T-0301:eve-graph-gate:20260901', type: 'request', owner: 'finalorchestra',
    runLease: (id, own, min) => { calls.push([id, own, min]); return '{}'; },
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, [['T-0301', 'finalorchestra', 90]],
    'la lease se toma sobre el ID de la tarjeta, no sobre el corr crudo (ledger.cjs solo conoce T-NNNN)');
});

test('W2: un corr con guion no toca el ledger ni el gate (fail-open explícito)', () => {
  const boom = () => { throw new Error('must not be called'); };
  assert.strictEqual(takeDispatchLease({ corr: 'T-0121-foo', type: 'request', owner: 'x', runLease: boom }).ok, true);
  const read = cardReader({ 'T-0121': { state: 'blocked', blocker: 'operator gate' } });
  assert.strictEqual(checkDispatchGate({ corr: 'T-0121-foo', type: 'request', readFile: read }).allowed, true);
});
