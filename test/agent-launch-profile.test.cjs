'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launch = require('../src/agent-launch-profile.cjs');
const restore = require('../scripts/restore-session.cjs');
const wd = require('../src/pane0-watchdog.cjs');
const SESSION = '00000000-0000-4000-8000-000000000001';
const CWD = 'G:/Fixture Apps/wezbridge';

function fixture(t, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-profile-'));
  const previous = { intel: process.env.WEZBRIDGE_INTEL_DIR, cwd: process.env.WEZBRIDGE_ORCH_CWD };
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  process.env.WEZBRIDGE_ORCH_CWD = CWD;
  if (profile !== undefined) fs.writeFileSync(path.join(dir, 'orchestrator-session.json'), JSON.stringify(profile));
  t.after(() => {
    wd._reset();
    for (const [key, value] of [['WEZBRIDGE_INTEL_DIR', previous.intel], ['WEZBRIDGE_ORCH_CWD', previous.cwd]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('missing launch selection retains legacy behavior', t => {
  fixture(t);
  assert.equal(launch.orchestratorResumeCommand(), null);
});

test('old Claude snapshot cannot duplicate the selected live Codex owner', t => {
  fixture(t, { version: 1, agent: 'codex', sessionId: SESSION, model: 'gpt-6-astra' });
  const entry = { ai: 'claude', cwd: 'file:///G:/Fixture%20Apps/wezbridge/' };
  const { keep, skipped } = restore.excludeAlreadyLive([entry], [{ agent: 'codex', cwd: CWD }]);
  assert.equal(keep.length, 0);
  assert.deepEqual(skipped, [{ ...entry, reason: 'already-live' }]);
});

test('snapshot recovery honors the selected model and exact conversation', t => {
  fixture(t, { version: 1, agent: 'codex', sessionId: SESSION, model: 'gpt-6-astra' });
  assert.ok(restore.resumeCommandFor('claude', CWD).startsWith('codex resume ' + SESSION));
  assert.match(restore.resumeCommandFor('claude', 'G:/Fixture Apps/other'), /^claude /);
});

test('literal percent paths are valid and only file URLs are decoded', t => {
  fixture(t, { version: 1, agent: 'codex', sessionId: SESSION, model: 'gpt-6-astra' });
  assert.equal(launch.isOrchestratorCwd('G:/Fixture Apps/100% coverage'), false);
  assert.match(restore.resumeCommandFor('claude', 'G:/Fixture Apps/100% coverage'), /^claude /);
  process.env.WEZBRIDGE_ORCH_CWD = 'G:/Fixture Apps/100%20 coverage';
  assert.equal(launch.isOrchestratorCwd('G:/Fixture Apps/100%20 coverage'), true);
  assert.equal(launch.isOrchestratorCwd('file:///G:/Fixture%20Apps/100%2520%20coverage'), true);
});

for (const profile of [
  { version: 1, agent: 'codex', sessionId: 'latest', model: 'gpt-6-astra' },
  { version: 1, agent: 'codex', sessionId: SESSION, model: 'gpt-6-astra; echo injected' },
  { version: 1, agent: 'codex', sessionId: SESSION, model: 'gpt-6-astra\n' },
]) test('invalid launch selection is rejected before any replacement is spawned: ' + JSON.stringify(profile), async t => {
  fixture(t, profile);
  wd._reset(); wd.start();
  let spawned = 0;
  const result = await wd.check({ now: 1_700_000_000_000, beaconMs: 0, paneExists: false,
    sleep: async () => {}, wezterm: { spawnPane: async () => { spawned++; return 73; }, sendText: async () => {} } });
  assert.equal(spawned, 0);
  assert.equal(result.action, 'failed');
});
