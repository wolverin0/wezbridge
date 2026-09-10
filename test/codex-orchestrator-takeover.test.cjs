'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverPanes } = require('../src/pane-discovery.cjs');
const { createWaker } = require('../src/orchestrator-waker.cjs');
const watchdog = require('../src/pane0-watchdog.cjs');

const SESSION = '00000000-0000-4000-8000-000000000001';
const CWD = 'G:/Fixture Apps/wezbridge';
const ready = '\u203a Ask Codex to do anything\n' +
  'gpt-6-astra high \u00b7 G:/Fixture Apps/wezbridge \u00b7 Ready \u00b7 Full Access \u00b7 Context 52% left';

function discover(text) {
  return discoverPanes({ wez: {
    listSockets: () => [{ socket: 'fixture-sock', panes: [{ pane_id: 0, cwd: CWD, title: 'wezbridge' }] }],
    currentSocket: () => 'fixture-sock',
    getFullText: () => text,
  } })[0];
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-takeover-'));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('Astra ready can receive work through the real discovery output', () => {
  const pane = discover(ready);
  assert.equal(pane.agent, 'codex');
  assert.equal(pane.status, 'idle', 'Ready must be eligible for the idle-gated waker');
});

test('Astra working is never eligible for an idle-gated dispatch', () => {
  const pane = discover('\u2022 Working (2s \u2022 esc to interrupt)\n' + ready.replace('Ready', 'Working'));
  assert.equal(pane.status, 'working');
});

test('Codex compact composer still owns the pane while its model footer is hidden', () => {
  const compact = '\u203a pending operator text\n tab to queue message                 80% context left';
  const pane = discover('\u2022 Working (2s \u2022 esc to interrupt)\n' + compact);
  assert.equal(pane.agent, 'codex');
  assert.equal(pane.status, 'working');
  assert.equal(discover(compact).status, 'idle');
  assert.equal(discover(compact + '\nPS G:\\Fixture Apps\\wezbridge> ').agent, null);
});

test('a shell after Codex exits is not an active agent from old scrollback', () => {
  const pane = discover(ready + '\n$ ');
  assert.equal(pane.agent, null, 'old model/footer must not suppress orchestrator recovery');
  assert.equal(pane.isCodex, false);
});

test('shell commands after exit cannot receive an agent wake from stale Codex scrollback', () => {
  for (const prompt of ['$ pwd', 'PS G:\\Fixture Apps\\wezbridge> dir', 'G:\\Fixture Apps\\wezbridge>dir']) {
    const pane = discover(ready + '\n' + prompt);
    assert.equal(pane.agent, null, prompt);
    assert.equal(pane.status, 'unknown');
  }
});

test('Codex presence prevents a second orchestrator from being spawned', async (t) => {
  watchdog._reset();
  t.after(() => watchdog._reset());
  watchdog.start({ discoverPanes: () => [{ project: CWD, agent: 'codex', isCodex: true, isClaude: false }] });
  let recoveries = 0;
  const result = await watchdog.check({ now: 1_700_000_000_000, beaconMs: 0,
    recover: async () => { recoveries++; return 73; } });
  assert.equal(recoveries, 0, 'a present Codex is not a missing Claude');
  assert.equal(result.action, 'stale-but-present');
});

test('default waker delivers once to Codex while excluding a shell in the same repo', async (t) => {
  const dir = temporary(t);
  const eventsPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const calls = [];
  const now = Date.now();
  const waker = createWaker({ eventsPath, stateDir: path.join(dir, 'state'), watchRepos: ['fixture'],
    settleTicks: 1, debounceMs: 0, now: () => now,
    discoverPanes: () => [
      { paneId: 0, project: CWD, agent: 'codex', isCodex: true, isClaude: false, status: 'idle' },
      { paneId: 1, project: CWD, agent: null, isCodex: false, isClaude: false, status: 'idle' },
    ],
    send: {
      sendPromptDeferredEnter: async (id) => { calls.push(id); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted',
    },
  });
  fs.appendFileSync(eventsPath, JSON.stringify({ repo: 'fixture', session: 's', time: new Date(now).toISOString(), event: 'turn-end' }) + '\n');
  await waker.tick();
  await waker.tick();
  assert.deepEqual(calls, [0], 'one event produces one effect in the current Codex owner');
  assert.equal(Object.keys(waker._state.pending).length, 0);
});

test('watchdog recovery uses the selected exact Codex session and Astra model', async (t) => {
  const dir = temporary(t);
  const previous = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  fs.writeFileSync(path.join(dir, 'orchestrator-session.json'), JSON.stringify({ version: 1, agent: 'codex', sessionId: SESSION, model: 'gpt-6-astra' }));
  watchdog._reset();
  watchdog.start();
  t.after(() => { watchdog._reset(); if (previous === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = previous; });
  const commands = [];
  const result = await watchdog.check({ now: 1_700_000_000_000, beaconMs: 0, paneExists: false,
    sleep: async () => {}, wezterm: { spawnPane: async () => 73, sendText: async (_, command) => commands.push(command) } });
  assert.equal(result.action, 'recovered');
  assert.equal(commands.length, 1);
  assert.ok(commands[0].startsWith('codex resume ' + SESSION + ' '));
  assert.match(commands[0], /-m gpt-6-astra/);
  assert.doesNotMatch(commands[0], /claude|--last|--yolo/);
});
