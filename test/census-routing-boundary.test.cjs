'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');

function firstCensus(mode) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '../src/pane-census-worker.cjs'), [], {
      execArgv: ['--require', path.join(__dirname, 'helpers/census-routing-preload.cjs')],
      env: { ...process.env, CENSUS_ROUTING_MODE: mode, WEZBRIDGE_CENSUS_CFG: JSON.stringify({ intervalMs: 60000, snapshotIntervalMs: 0 }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result; let stderr = ''; const reads = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`worker timeout: ${stderr}`)); }, 10000);
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('message', (message) => {
      if (message.t === 'probe') reads.push(message.socket);
      if (message.t === 'census') { result = message; child.disconnect(); }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (!result) reject(new Error(`No census: ${stderr}`));
      else resolve({ ...result, reads });
    });
  });
}

test('real census worker publishes only transport IDs despite changed GUI cursor', async () => {
  const result = await firstCensus('duplicate-view');
  assert.deepEqual(result.panes.map((pane) => pane.paneId), [94]);
  assert.deepEqual(result.reads, ['C:/fixture/sock']);
});
test('real census worker retains two actual mux agents instead of merging them', async () => {
  const result = await firstCensus('two-real');
  assert.deepEqual(result.panes.map((pane) => pane.paneId), [94, 104]);
  assert.deepEqual(result.reads, ['C:/fixture/sock', 'C:/fixture/sock']);
});
test('missing transport socket produces no foreign pane ID fallback', async () => {
  const result = await firstCensus('missing-mux');
  assert.deepEqual(result.panes, []);
  assert.deepEqual(result.reads, []);
});
