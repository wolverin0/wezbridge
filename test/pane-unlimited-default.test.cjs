'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMaxPanes, evaluateSpawnCap } = require('../src/lifecycle.cjs');

test('operator policy: no implicit pane-count limit', () => {
  for (const value of [undefined, '', ' ', 'banana', '-3', '2.5', '5panes']) {
    const env = value === undefined ? {} : { WEZBRIDGE_MAX_PANES: value };
    assert.equal(resolveMaxPanes(env), Infinity);
    const result = evaluateSpawnCap({ paneCount: 1000, env });
    assert.equal(result.allowed, true);
    assert.equal(result.max, null);
  }
});

test('legacy inherited limits cannot reactivate removed pane cap', () => {
  for (const value of ['1', '5', '12', '20', '0', 'off']) {
    const env = { WEZBRIDGE_MAX_PANES: value };
    assert.equal(resolveMaxPanes(env), Infinity);
    assert.equal(evaluateSpawnCap({ paneCount: 1000, env }).allowed, true);
  }
});
