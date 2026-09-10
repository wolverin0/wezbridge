'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ipc = require('../src/dashboard-server-ipc.cjs');
const { createWaker } = require('../src/orchestrator-waker.cjs');

function fixture(t, source) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-async-census-'));
  const previousIntel = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = base;
  ipc.setPaneSource(source);
  t.after(() => {
    ipc.setPaneSource(null);
    if (previousIntel === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = previousIntel;
    assert.equal(path.dirname(base), os.tmpdir());
    fs.rmSync(base, { recursive: true, force: true });
  });
  const eventsPath = path.join(base, 'pane-events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const calls = []; const logs = [];
  const waker = createWaker({ eventsPath, stateDir: path.join(base, 'state'),
    watchRepos: ['synthetic-source'], discoverPanes: ipc.discoverPanes, settleTicks: 1, debounceMs: 0, cooldownMs: 0,
    send: { sendPromptDeferredEnter: async (pane, body) => { calls.push({ pane, body }); return 'ok'; }, verifyPromptSubmission: async () => 'submitted' },
    log: (message) => logs.push(message),
  });
  fs.appendFileSync(eventsPath, JSON.stringify({ repo: 'synthetic-source', session: 'probe', event: 'turn-end', time: new Date().toISOString() }) + '\n');
  return { waker, calls, logs };
}

test('real daemon async census: busy preserves work, idle delivers once, later ticks do not replay', async (t) => {
  let status = 'working';
  const { waker, calls } = fixture(t, () => [{ paneId: 94, project: 'G:/synthetic/wezbridge', status }]);
  await waker.tick();
  assert.equal(waker.status().pending, 1);
  assert.equal(calls.length, 0);
  status = 'idle';
  await waker.tick(); await waker.tick(); await waker.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pane, 94);
  assert.match(calls[0].body, /synthetic-source/);
  assert.equal(waker.status().pending, 0);
  assert.equal(waker.status().cursorLagBytes, 0);
});

test('real daemon rejected census: retain event with zero sends and recover on a later tick', async (t) => {
  let failed = true;
  const { waker, calls, logs } = fixture(t, () => failed ? Promise.reject(new Error('synthetic census unavailable'))
    : [{ paneId: 94, project: 'G:/synthetic/wezbridge', status: 'idle' }]);
  await waker.tick();
  assert.equal(waker.status().pending, 1);
  assert.equal(calls.length, 0);
  assert.ok(logs.some((line) => line.includes('discovery failed: synthetic census unavailable')));
  failed = false;
  await waker.tick();
  assert.equal(calls.length, 1);
  assert.equal(waker.status().pending, 0);
});
