'use strict';

/**
 * daemon-heartbeat-sentinel-finding.test.cjs — T-0598 Fase B-2: DaemonSentinel
 * must emit exactly ONE automation-router finding per daemon outage that
 * survives DOWN_FINDING_THRESHOLD consecutive sentinel ticks, never on a
 * single transient blip, never twice for the same outage, and a new finding
 * for a genuinely new outage after recovery. Pure evaluateFinding() unit
 * tests exercise the decision in isolation; the last test drives the real
 * scripts/daemon-heartbeat-sentinel.cjs main() across several spawned runs
 * sharing one WEZBRIDGE_INTEL_DIR to prove the wiring actually writes a file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  evaluateFinding, emitDaemonFinding, DOWN_FINDING_THRESHOLD,
} = require('../scripts/daemon-heartbeat-sentinel.cjs');

// ── Pure evaluateFinding() ──────────────────────────────────────────────

test('below threshold: consecutive down ticks under the threshold emit nothing', () => {
  let findingState = {};
  const decision = { verdict: 'down', message: 'DAEMON DOWN', recovered: false, newState: { episodeStartedAt: '2026-09-24T00:00:00Z' } };
  for (let i = 0; i < DOWN_FINDING_THRESHOLD - 1; i += 1) {
    const r = evaluateFinding({ decision, findingState });
    assert.equal(r.emit, null, `tick ${i + 1} must not emit yet`);
    findingState = r.newFindingState;
  }
  assert.equal(findingState.ticks, DOWN_FINDING_THRESHOLD - 1);
});

test('at threshold: exactly the Nth consecutive down tick emits exactly one finding', () => {
  let findingState = {};
  const decision = { verdict: 'down', message: 'DAEMON DOWN', recovered: false, newState: { episodeStartedAt: '2026-09-24T00:00:00Z' } };
  let emits = 0;
  for (let i = 0; i < DOWN_FINDING_THRESHOLD; i += 1) {
    const r = evaluateFinding({ decision, findingState });
    if (r.emit) emits += 1;
    findingState = r.newFindingState;
  }
  assert.equal(emits, 1, 'exactly one emission crossing the threshold');
  assert.equal(findingState.emitted, true);
});

test('same outage, further ticks past threshold: still exactly one emission (dedupe)', () => {
  let findingState = {};
  const decision = { verdict: 'down', message: 'DAEMON DOWN', recovered: false, newState: { episodeStartedAt: '2026-09-24T00:00:00Z' } };
  let emits = 0;
  for (let i = 0; i < DOWN_FINDING_THRESHOLD + 5; i += 1) {
    const r = evaluateFinding({ decision, findingState });
    if (r.emit) emits += 1;
    findingState = r.newFindingState;
  }
  assert.equal(emits, 1, 'the same outage must never emit twice, however many more ticks it runs');
});

test('mutation sanity: threshold-1 tick vs threshold tick is the exact boundary', () => {
  const decision = { verdict: 'wedged', message: 'DAEMON WEDGED', recovered: false, newState: { episodeStartedAt: '2026-09-24T01:00:00Z' } };
  const belowState = { episodeStartedAt: '2026-09-24T01:00:00Z', ticks: DOWN_FINDING_THRESHOLD - 2, emitted: false };
  const below = evaluateFinding({ decision, findingState: belowState });
  assert.equal(below.emit, null, 'tick count reaching threshold-1 must still withhold emission');
  assert.equal(below.newFindingState.ticks, DOWN_FINDING_THRESHOLD - 1);

  const atState = { episodeStartedAt: '2026-09-24T01:00:00Z', ticks: DOWN_FINDING_THRESHOLD - 1, emitted: false };
  const at = evaluateFinding({ decision, findingState: atState });
  assert.equal(at.emit, 'down', 'crossing the threshold on this exact tick must emit');
  assert.equal(at.newFindingState.ticks, DOWN_FINDING_THRESHOLD);
});

test('new outage after recovery gets a fresh finding (different episodeStartedAt resets dedupe)', () => {
  const emittedState = { episodeStartedAt: '2026-09-24T01:00:00Z', ticks: DOWN_FINDING_THRESHOLD, emitted: true };
  const healthyDecision = { verdict: 'healthy', recovered: true, newState: {} };
  const recovered = evaluateFinding({ decision: healthyDecision, findingState: emittedState });
  assert.equal(recovered.emit, 'recovered');
  assert.deepEqual(recovered.newFindingState, {});

  // New episode, same threshold walk, must emit again (not suppressed by the old episode's dedupe).
  let findingState = recovered.newFindingState;
  const newOutage = { verdict: 'down', message: 'DAEMON DOWN', recovered: false, newState: { episodeStartedAt: '2026-09-24T02:00:00Z' } };
  let emits = 0;
  for (let i = 0; i < DOWN_FINDING_THRESHOLD; i += 1) {
    const r = evaluateFinding({ decision: newOutage, findingState });
    if (r.emit) emits += 1;
    findingState = r.newFindingState;
  }
  assert.equal(emits, 1, 'a new outage after recovery must produce its own single finding');
});

test('healthy with no prior finding emitted: no recovered finding noise', () => {
  const healthyDecision = { verdict: 'healthy', recovered: false, newState: {} };
  const r = evaluateFinding({ decision: healthyDecision, findingState: {} });
  assert.equal(r.emit, null);
});

test('suspect (single blip, below the http-unresponsive streak) never counts as an outage tick', () => {
  const suspectDecision = { verdict: 'suspect', recovered: false, newState: {} };
  const r = evaluateFinding({ decision: suspectDecision, findingState: { episodeStartedAt: 'x', ticks: 2, emitted: false } });
  assert.equal(r.emit, null);
  assert.deepEqual(r.newFindingState, {}, 'suspect resets the finding tick count, matching evaluate()\'s own streak reset');
});

// ── emitDaemonFinding: dependency-injected, never touches disk in this test ──

test('emitDaemonFinding calls the injected emit-finding main with an actionable, high-severity, stable-fingerprint finding for a down outage', () => {
  let calledWith = null;
  const decision = { verdict: 'down', message: 'DAEMON DOWN — test', newState: { episodeStartedAt: '2026-09-24T03:00:00Z' } };
  emitDaemonFinding('down', decision, '2026-09-24T03:00:00Z', {
    emitFindingMainFn: (argv) => { calledWith = argv; return 0; },
  });
  assert.ok(calledWith, 'main() must be invoked');
  const get = (flag) => calledWith[calledWith.indexOf(flag) + 1];
  assert.equal(get('--task'), 'daemon-heartbeat-sentinel');
  assert.equal(get('--repo'), 'wezbridge');
  assert.equal(get('--actionable'), 'true');
  assert.equal(get('--severity'), 'high');
  assert.equal(get('--fingerprint'), 'daemon-outage-2026-09-24T03:00:00Z');
  assert.match(get('--summary'), /DOWN/);
});

test('emitDaemonFinding for a recovered outage is non-actionable, low severity', () => {
  let calledWith = null;
  emitDaemonFinding('recovered', { verdict: 'healthy' }, '2026-09-24T03:00:00Z', {
    emitFindingMainFn: (argv) => { calledWith = argv; return 0; },
  });
  const get = (flag) => calledWith[calledWith.indexOf(flag) + 1];
  assert.equal(get('--actionable'), 'false');
  assert.equal(get('--severity'), 'low');
  assert.match(get('--summary'), /recovered/);
});

test('emitDaemonFinding never throws even if the injected main() throws', () => {
  assert.doesNotThrow(() => {
    emitDaemonFinding('down', { verdict: 'down', newState: {} }, '2026-09-24T04:00:00Z', {
      emitFindingMainFn: () => { throw new Error('disk full'); },
    });
  });
});

// ── Integration: real main(), real bin/emit-finding.cjs, real filesystem ──
// Multiple spawns share one WEZBRIDGE_INTEL_DIR so STATE_FILE and
// FINDING_STATE_FILE persist across "ticks", the same way the Windows
// scheduled task's repeated 5-min invocations do.
function runSentinelOnce(dir, { staleMinutesAgo = 42 } = {}) {
  fs.writeFileSync(path.join(dir, '.daemon-heartbeat.json'),
    JSON.stringify({ ts: new Date(Date.now() - staleMinutesAgo * 60000).toISOString() }));
  return spawnSync(process.execPath, [
    '--require', path.join(__dirname, 'fixtures/sentinel-observation.cjs'),
    path.join(__dirname, '../scripts/daemon-heartbeat-sentinel.cjs'),
  ], {
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir, SENTINEL_FIXTURE_MODE: 'still-stale' },
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
}

function listFindings(dir) {
  const findingsDir = path.join(dir, 'automation-findings');
  if (!fs.existsSync(findingsDir)) return [];
  return fs.readdirSync(findingsDir).filter((f) => f.startsWith('daemon-heartbeat-sentinel-'));
}

test('integration: a sustained outage across real sentinel runs writes exactly one finding file, once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-finding-int-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (let i = 0; i < DOWN_FINDING_THRESHOLD - 1; i += 1) {
    const r = runSentinelOnce(dir);
    assert.equal(listFindings(dir).length, 0, `tick ${i + 1}: still below threshold, no finding file yet (${r.stdout}${r.stderr})`);
  }
  const atThreshold = runSentinelOnce(dir);
  assert.equal(listFindings(dir).length, 1, `at threshold: exactly one finding file (${atThreshold.stdout}${atThreshold.stderr})`);

  // One more tick of the same outage must not duplicate the finding.
  runSentinelOnce(dir);
  assert.equal(listFindings(dir).length, 1, 'same outage, one more tick: still exactly one finding file');

  const found = listFindings(dir)[0];
  const finding = JSON.parse(fs.readFileSync(path.join(dir, 'automation-findings', found), 'utf8'));
  assert.equal(finding.task, 'daemon-heartbeat-sentinel');
  assert.equal(finding.repo_owner, 'wezbridge');
  assert.equal(finding.actionable, true);
});
