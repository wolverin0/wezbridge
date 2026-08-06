/**
 * Tests for waker ARMING — the failure that made the orchestrator blind.
 *
 * On 2026-08-06 the waker ran correctly for hours, the daemon was restarted
 * with the documented `npm run dashboard`, and arming vanished with the old
 * shell's env var. Nothing logged it, nothing reported it, and 24 pane
 * completions went unread for 2h45m.
 *
 * Two classes of test here, and the second is the important one:
 *   1. resolveWakerConfig precedence/reasons (leaf logic)
 *   2. COMPOSITION ROOT: startBackgroundServices must register the waker's
 *      arming decision on BOTH paths. A leaf test cannot catch "nobody calls
 *      it" — only a test that enters where the daemon actually wires things up.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { resolveWakerConfig } = require('../src/orchestrator-waker.cjs');
const daemonStatus = require('../src/daemon-status.cjs');
const { createEventHandlers } = require('../src/handlers/event-handlers.cjs');

// ── 1. resolveWakerConfig ──────────────────────────────────────────────────
const noFile = () => { throw new Error('ENOENT'); };
const withFile = (obj) => () => JSON.stringify(obj);

test('env=1 with repos arms, and says so', () => {
  const r = resolveWakerConfig({
    env: { WEZBRIDGE_ORCH_WAKER: '1', WEZBRIDGE_ORCH_WAKER_REPOS: 'brlite,walksim' },
    intelDir: '/x', readFile: noFile,
  });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.repos, ['brlite', 'walksim']);
  assert.match(r.reason, /armed/);
});

test('THE REGRESSION: config file arms when the env var is absent', () => {
  // This is the actual fix. Before it, an unset env var meant silence.
  const r = resolveWakerConfig({
    env: {}, intelDir: '/x', readFile: withFile({ enabled: true, repos: ['brlite'] }),
  });
  assert.equal(r.enabled, true, 'a daemon restart without the env var must stay armed');
  assert.deepEqual(r.repos, ['brlite']);
  assert.equal(r.source, 'file');
});

test('env=0 overrides an enabled config file (explicit off must win)', () => {
  const r = resolveWakerConfig({
    env: { WEZBRIDGE_ORCH_WAKER: '0' }, intelDir: '/x',
    readFile: withFile({ enabled: true, repos: ['brlite'] }),
  });
  assert.equal(r.enabled, false);
  assert.match(r.reason, /explicit off/);
});

test('no env and no file is OFF — with a reason that names the fix', () => {
  const r = resolveWakerConfig({ env: {}, intelDir: '/x', readFile: noFile });
  assert.equal(r.enabled, false);
  assert.match(r.reason, /orch-waker\.json/);
});

test('enabled:true with an empty repos list is OFF, not silently watching nothing', () => {
  const r = resolveWakerConfig({
    env: {}, intelDir: '/x', readFile: withFile({ enabled: true, repos: [] }),
  });
  assert.equal(r.enabled, false);
  assert.match(r.reason, /empty repos/);
});

test('a corrupt config file degrades to OFF rather than throwing at daemon startup', () => {
  const r = resolveWakerConfig({
    env: {}, intelDir: '/x', readFile: () => '{not json',
  });
  assert.equal(r.enabled, false);
});

test('every outcome carries a non-empty reason — the off-path must be loggable', () => {
  const cases = [
    { env: {}, readFile: noFile },
    { env: { WEZBRIDGE_ORCH_WAKER: '0' }, readFile: noFile },
    { env: { WEZBRIDGE_ORCH_WAKER: '1' }, readFile: noFile }, // armed but no repos
    { env: {}, readFile: withFile({ enabled: false }) },
  ];
  for (const c of cases) {
    const r = resolveWakerConfig({ ...c, intelDir: '/x' });
    assert.ok(r.reason && r.reason.length > 10, `missing reason for ${JSON.stringify(c.env)}`);
  }
});

// ── 2. daemon-status registry ──────────────────────────────────────────────
test('daemon-status distinguishes "off on purpose" from "never registered"', () => {
  daemonStatus._reset();
  daemonStatus.set('thing', { armed: false, reason: 'explicit off' });
  const snap = daemonStatus.snapshot();
  assert.equal(snap.thing.armed, false);
  assert.equal(snap.absent_thing, undefined, 'unregistered components must be absent, not false');
});

test('a probe that throws never breaks the health payload', () => {
  daemonStatus._reset();
  daemonStatus.set('thing', { armed: true, probe: () => { throw new Error('boom'); } });
  const snap = daemonStatus.snapshot();
  assert.equal(snap.thing.armed, true);
  assert.equal(snap.thing.probe_error, 'boom');
});

test('set rejects a missing armed boolean — the field health depends on', () => {
  daemonStatus._reset();
  assert.throws(() => daemonStatus.set('thing', { reason: 'x' }), /armed must be a boolean/);
});

// ── 3. COMPOSITION ROOT ────────────────────────────────────────────────────
// Enter where the daemon actually wires the waker up. A leaf test of
// resolveWakerConfig passes happily even if startBackgroundServices never calls
// it — which is precisely the shape of failure being guarded against.
function makeCtx(overrides = {}) {
  const logs = [];
  return {
    ctx: {
      log: (m) => logs.push(String(m)),
      path,
      fs: require('node:fs'),
      SRC_DIR: path.join(__dirname, '..', 'src'),
      ipc: { wez: { listPanes: () => [] }, discoverPanes: () => [] },
      wez: { listPanes: () => [] },
      discoverPanes: () => [],
      a2aState: new Map(),
      broadcastSSE: () => {},
      a2aHeartbeat: { startWatcher: () => {} },
      sessionSnapshot: { startWatcher: () => {} },
      teamManifest: { replay: () => ({ teams: new Map(), worktrees: new Map() }) },
      teamsRegistry: new Map(),
      worktreeRegistry: new Map(),
      safetyPolicy: { evaluate: () => ({ allowed: true }) },
      ...overrides,
    },
    logs,
  };
}

test('COMPOSITION ROOT: startBackgroundServices registers the waker when config arms it', () => {
  daemonStatus._reset();
  const prev = { ...process.env };
  process.env.WEZBRIDGE_ORCH_WAKER = '1';
  process.env.WEZBRIDGE_ORCH_WAKER_REPOS = 'brlite';
  process.env.WEZBRIDGE_INTEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arming-intel-'));
  process.env.WEZBRIDGE_SESSION_SNAPSHOT = '0';
  try {
    const { ctx, logs } = makeCtx();
    createEventHandlers(ctx).startBackgroundServices();
    const snap = daemonStatus.snapshot();
    assert.ok(snap.orchestrator_waker, 'waker must register itself at the composition root');
    assert.equal(snap.orchestrator_waker.armed, true);
    assert.ok(logs.some((l) => /orchestrator-waker armed/.test(l)), 'arming must be logged');
  } finally {
    process.env = prev;
  }
});

test('COMPOSITION ROOT: the OFF path registers and logs instead of falling through silently', () => {
  daemonStatus._reset();
  const prev = { ...process.env };
  process.env.WEZBRIDGE_ORCH_WAKER = '0';
  process.env.WEZBRIDGE_INTEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arming-intel-'));
  process.env.WEZBRIDGE_SESSION_SNAPSHOT = '0';
  try {
    const { ctx, logs } = makeCtx();
    createEventHandlers(ctx).startBackgroundServices();
    const snap = daemonStatus.snapshot();
    assert.equal(snap.orchestrator_waker.armed, false, 'the off state must be REPORTED, not inferred');
    assert.ok(
      logs.some((l) => /orchestrator-waker NOT armed/.test(l)),
      'the outage was invisible because the off-path logged nothing — it must log now'
    );
  } finally {
    process.env = prev;
  }
});

test('COMPOSITION ROOT: session_snapshot reports its own arming (was inferred from the wrong process)', () => {
  daemonStatus._reset();
  const prev = { ...process.env };
  process.env.WEZBRIDGE_SESSION_SNAPSHOT = '0';
  process.env.WEZBRIDGE_ORCH_WAKER = '0';
  process.env.WEZBRIDGE_INTEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arming-intel-'));
  try {
    const { ctx } = makeCtx();
    createEventHandlers(ctx).startBackgroundServices();
    assert.equal(daemonStatus.snapshot().session_snapshot.armed, false);
  } finally {
    process.env = prev;
  }
});
