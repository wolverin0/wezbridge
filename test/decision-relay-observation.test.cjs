'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { measureObservation } = require('../scripts/observe-decision-relay.cjs');
const start = Date.parse('2026-09-07T10:00:00Z');
const fixture = () => ({ registeredAt: new Date(start).toISOString(), now: start + 86400000,
  events: [{ event: 'decision.delivered', task: 'T-0335', ruling: 'approved', time: new Date(start + 60000).toISOString() }],
  rulings: [{ task: 'T-0335', ruling: 'approved', source: 'ledger-cli', at: new Date(start - 60000).toISOString() }], findings: [] });
test('AC3 cannot pass before 24h or with no actual delivered cohort', () => {
  assert.equal(measureObservation({ ...fixture(), now: start + 86399999 }).status, 'PENDING');
  assert.equal(measureObservation({ ...fixture(), events: [] }).status, 'INCOMPLETE');
  assert.equal(measureObservation({ ...fixture(), rulings: [{ ...fixture().rulings[0], source: 'drill' }] }).status, 'INCOMPLETE');
});
test('AC3 distinguishes an unheard delivered task from unrelated findings', () => {
  const good = measureObservation({ ...fixture(), findings: [{ id: 'T-9999', category: 'decision-unheard' }] });
  assert.equal(good.status, 'PASS');
  assert.deepEqual(good.delivered_tasks, ['T-0335']);
  assert.equal(measureObservation({ ...fixture(), findings: [{ id: 'T-0335', category: 'decision-unheard' }] }).status, 'FAIL');
});
