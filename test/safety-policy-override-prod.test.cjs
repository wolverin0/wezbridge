'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { evaluate, setSelfPaneIds } = require(path.resolve(__dirname, '..', 'src', 'safety-policy.cjs'));

function withEnv(pairs, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(pairs)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(pairs)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('WEZBRIDGE_SAFETY_OVERRIDE=1 throws in production', () => {
  setSelfPaneIds([42]);
  withEnv({ WEZBRIDGE_SAFETY_OVERRIDE: '1', NODE_ENV: 'production' }, () => {
    assert.throws(
      () => evaluate({ action: 'kill_session', paneId: 42 }),
      /not allowed in production/
    );
  });
});

test('WEZBRIDGE_SAFETY_OVERRIDE=1 allows in dev and emits critical stack log', () => {
  setSelfPaneIds([42]);
  const writes = [];
  const realWrite = process.stderr.write;
  process.stderr.write = function write(chunk, ...args) {
    writes.push(String(chunk));
    if (typeof args.at(-1) === 'function') args.at(-1)();
    return true;
  };

  try {
    withEnv({ WEZBRIDGE_SAFETY_OVERRIDE: '1', NODE_ENV: 'test' }, () => {
      const result = evaluate({ action: 'kill_session', paneId: 42 });
      assert.equal(result.allowed, true);
      assert.match(result.reason, /WEZBRIDGE_SAFETY_OVERRIDE=1/);
    });
  } finally {
    process.stderr.write = realWrite;
  }

  const log = writes.join('');
  assert.match(log, /CRITICAL: WEZBRIDGE_SAFETY_OVERRIDE=1 bypassed safety rules/);
  assert.match(log, /WEZBRIDGE_SAFETY_OVERRIDE bypass stack/);
  assert.match(log, /at evaluate/);
});
