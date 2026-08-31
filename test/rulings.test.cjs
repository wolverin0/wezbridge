'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rulingsFor,
  latestRulingWhere,
  latestRuling,
  taskIds,
} = require('../src/rulings.cjs');

test('rulingsFor filters malformed and other-task entries without changing order', () => {
  const first = { task: 'T-1', ruling: 'first' };
  const second = { task: 'T-1', ruling: 'second' };
  const rulings = [null, first, { ruling: 'taskless' }, { task: 'T-2' }, second];

  assert.deepEqual(rulingsFor(rulings, 'T-1'), [first, second]);
  assert.deepEqual(rulingsFor(null, 'T-1'), []);
});

test('latestRulingWhere returns the last predicate match or null when none matches', () => {
  const olderMatch = { task: 'T-1', ruling: 'accepted', sequence: 1 };
  const latestMatch = { task: 'T-1', ruling: 'accepted', sequence: 2 };
  const laterNonMatch = { task: 'T-1', ruling: 'rejected', sequence: 3 };
  const rulings = [
    olderMatch,
    { task: 'T-2', ruling: 'accepted', sequence: 99 },
    latestMatch,
    laterNonMatch,
  ];

  assert.equal(
    latestRulingWhere(rulings, 'T-1', (ruling) => ruling.ruling === 'accepted'),
    latestMatch,
  );
  assert.equal(latestRulingWhere(rulings, 'T-1', () => false), null);
});

test('latestRuling returns the latest matching record and null for absent input', () => {
  const first = { task: 'T-1', ruling: 'first' };
  const latest = { task: 'T-1', ruling: 'latest' };
  const rulings = [first, { task: 'T-2', ruling: 'other' }, null, latest];

  assert.equal(latestRuling(rulings, 'T-1'), latest);
  assert.equal(latestRuling(rulings, 'missing'), null);
  assert.equal(latestRuling(undefined, 'T-1'), null);
});

test('taskIds ignores malformed values and keeps unique ids in first-seen order', () => {
  const rulings = [
    null,
    { task: 'T-2' },
    { ruling: 'taskless' },
    { task: 'T-1' },
    { task: 'T-2', ruling: 'duplicate' },
    undefined,
    { task: 'T-3' },
    { task: '' },
  ];

  assert.deepEqual(taskIds(rulings), ['T-2', 'T-1', 'T-3']);
  assert.deepEqual(taskIds('not an array'), []);
});
