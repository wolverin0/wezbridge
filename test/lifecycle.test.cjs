'use strict';
/**
 * lifecycle.test.cjs — B2 lifecycle enforcement: pane cap (WEZBRIDGE_MAX_PANES
 * default 5, refusal at the wezterm.cjs chokepoints incl. splits), project
 * affinity resolution (env > _intel/affinity.json > none, invalid agents
 * ignored), lease detection against _intel/tasks/, and the PURE auto-close
 * SHADOW decision (orchestrator/lease/unknown-project/unverified exclusions).
 * Pure functions take injected env/readFile; IO uses WEZBRIDGE_INTEL_DIR temp.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
const lifecycle = require('../src/lifecycle.cjs');

// ── pane cap ─────────────────────────────────────────────────────────────────

test('evaluateSpawnCap: default cap 5 — under allowed, at-or-over refused with reason', () => {
  assert.strictEqual(lifecycle.evaluateSpawnCap({ paneCount: 4, env: {} }).allowed, true);
  const refused = lifecycle.evaluateSpawnCap({ paneCount: 5, env: {} });
  assert.strictEqual(refused.allowed, false);
  assert.strictEqual(refused.max, 5);
  assert.match(refused.reason, /pane cap reached: 5 live panes >= max 5/);
  assert.match(refused.reason, /WEZBRIDGE_MAX_PANES/);
});

test('evaluateSpawnCap: WEZBRIDGE_MAX_PANES raises the cap; 0/off disables it', () => {
  const env8 = { WEZBRIDGE_MAX_PANES: '8' };
  assert.strictEqual(lifecycle.evaluateSpawnCap({ paneCount: 7, env: env8 }).allowed, true);
  assert.strictEqual(lifecycle.evaluateSpawnCap({ paneCount: 8, env: env8 }).allowed, false);
  for (const off of ['0', 'off']) {
    const v = lifecycle.evaluateSpawnCap({ paneCount: 999, env: { WEZBRIDGE_MAX_PANES: off } });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.max, null);
  }
});

test('evaluateSpawnCap: garbage values fall back to the default, never disable', () => {
  for (const bad of ['banana', '-3', '2.5x is not parsed as 2? yes it is', '']) {
    const max = lifecycle.resolveMaxPanes({ WEZBRIDGE_MAX_PANES: bad });
    assert.ok(max === 5 || (Number.isInteger(max) && max > 0), `"${bad}" -> ${max}`);
  }
  assert.strictEqual(lifecycle.resolveMaxPanes({ WEZBRIDGE_MAX_PANES: 'banana' }), 5);
  assert.strictEqual(lifecycle.resolveMaxPanes({ WEZBRIDGE_MAX_PANES: '-3' }), 5);
  assert.strictEqual(lifecycle.resolveMaxPanes({}), 5);
});

// ── affinity ─────────────────────────────────────────────────────────────────

const SEED = JSON.stringify({
  _doc: 'doc keys are skipped',
  mutual: { agent: 'codex' },
  rifas: { agent: 'codex' },
  doctor: { agent: 'codex', model: 'gpt-5' },
  broken: { agent: 'gpt-oss' },
});

function readSeed() { return SEED; }

test('resolveAffinity: file map lookup is case-insensitive and skips _doc keys', () => {
  const hit = lifecycle.resolveAffinity({ project: 'Mutual', env: {}, readFile: readSeed });
  assert.strictEqual(hit.agent, 'codex');
  assert.strictEqual(hit.source, 'file');
  const miss = lifecycle.resolveAffinity({ project: '_doc', env: {}, readFile: readSeed });
  assert.strictEqual(miss.agent, null);
});

test('resolveAffinity: unknown project, missing file, disabled env → no affinity', () => {
  assert.strictEqual(lifecycle.resolveAffinity({ project: 'wabot', env: {}, readFile: readSeed }).agent, null);
  const noFile = lifecycle.resolveAffinity({
    project: 'mutual', env: {}, readFile: () => { throw new Error('ENOENT'); },
  });
  assert.strictEqual(noFile.agent, null);
  assert.strictEqual(noFile.source, 'none');
  const disabled = lifecycle.resolveAffinity({ project: 'mutual', env: { WEZBRIDGE_AFFINITY: '0' }, readFile: readSeed });
  assert.strictEqual(disabled.agent, null);
  assert.strictEqual(disabled.source, 'env');
});

test('resolveAffinity: WEZBRIDGE_AFFINITY_JSON wins over the file', () => {
  const hit = lifecycle.resolveAffinity({
    project: 'mutual',
    env: { WEZBRIDGE_AFFINITY_JSON: JSON.stringify({ mutual: { agent: 'claude' } }) },
    readFile: readSeed,
  });
  assert.strictEqual(hit.agent, 'claude');
  assert.strictEqual(hit.source, 'env');
});

test('resolveAffinity: invalid agent value is reported null, model still usable', () => {
  const broken = lifecycle.resolveAffinity({ project: 'broken', env: {}, readFile: readSeed });
  assert.strictEqual(broken.agent, null);
  assert.match(broken.reason, /invalid agent/);
  const doctor = lifecycle.resolveAffinity({ project: 'doctor', env: {}, readFile: readSeed });
  assert.strictEqual(doctor.agent, 'codex');
  assert.strictEqual(doctor.model, 'gpt-5');
});

test('resolveAffinity: the committed _intel seed maps mutual/rifas/doctor → codex', () => {
  const intelDir = path.join(__dirname, '..', '..', '_intel');
  for (const project of ['mutual', 'rifas', 'doctor']) {
    const hit = lifecycle.resolveAffinity({ project, env: {}, intelDir });
    assert.strictEqual(hit.agent, 'codex', `${project} → codex (got ${hit.agent}; ${hit.reason})`);
  }
});

// ── leases ───────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-22T12:00:00Z');

test('leaseActive: held without expiry, unexpired, expired, absent', () => {
  assert.strictEqual(lifecycle.leaseActive(null, NOW), false);
  assert.strictEqual(lifecycle.leaseActive({ owner: 'pane-7' }, NOW), true);
  assert.strictEqual(lifecycle.leaseActive({ owner: 'pane-7', expires_at: '2026-08-22T13:00:00Z' }, NOW), true);
  assert.strictEqual(lifecycle.leaseActive({ owner: 'pane-7', expires_at: '2026-08-22T11:00:00Z' }, NOW), false);
});

test('findActiveLease: finds a running task leased to the owner, ignores others', () => {
  const intelDir = path.join(TMP, 'lease-case');
  const tasks = path.join(intelDir, 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, 'T-0001.json'), JSON.stringify({
    id: 'T-0001', state: 'running', lease: { owner: 'pane-7', expires_at: '2026-08-22T13:00:00Z' },
  }));
  fs.writeFileSync(path.join(tasks, 'T-0002.json'), JSON.stringify({
    id: 'T-0002', state: 'ready', lease: { owner: 'pane-8', expires_at: '2026-08-22T13:00:00Z' },
  }));
  fs.writeFileSync(path.join(tasks, 'T-0003.json'), JSON.stringify({
    id: 'T-0003', state: 'running', lease: { owner: 'pane-9', expires_at: '2026-08-22T11:00:00Z' },
  }));
  const held = lifecycle.findActiveLease({ owner: 'pane-7', intelDir, now: NOW });
  assert.strictEqual(held.task, 'T-0001');
  assert.strictEqual(lifecycle.findActiveLease({ owner: 'pane-8', intelDir, now: NOW }), null, 'ready task is not a live hold');
  assert.strictEqual(lifecycle.findActiveLease({ owner: 'pane-9', intelDir, now: NOW }), null, 'expired lease is not a live hold');
  assert.strictEqual(lifecycle.findActiveLease({ owner: 'pane-7', intelDir: path.join(TMP, 'nope'), now: NOW }), null, 'missing dir fails soft');
});

// ── auto-close SHADOW decision ───────────────────────────────────────────────

test('decideAutoClose: verified worker result with no lease → eligible', () => {
  const d = lifecycle.decideAutoClose({ paneId: 12, project: 'mutual', verified: true, lease: null });
  assert.strictEqual(d.close, true);
  assert.match(d.reason, /eligible for auto-close/);
});

test('decideAutoClose exclusions: orchestrator pane, active lease, unknown project, unverified', () => {
  const orch = lifecycle.decideAutoClose({ paneId: 0, project: 'WezBridge', orchRepo: 'wezbridge', verified: true });
  assert.strictEqual(orch.close, false);
  assert.match(orch.reason, /orchestrator/);

  const leased = lifecycle.decideAutoClose({
    paneId: 7, project: 'mutual', verified: true,
    lease: { owner: 'pane-7', task: 'T-0001', expires_at: '2099-01-01T00:00:00Z' },
  });
  assert.strictEqual(leased.close, false);
  assert.match(leased.reason, /lease/);

  const unknown = lifecycle.decideAutoClose({ paneId: 3, project: null, verified: true });
  assert.strictEqual(unknown.close, false);
  assert.match(unknown.reason, /unknown/);

  const unverified = lifecycle.decideAutoClose({ paneId: 3, project: 'mutual', verified: false });
  assert.strictEqual(unverified.close, false);
  assert.match(unverified.reason, /not verified/);
});

test('decideAutoClose: an EXPIRED lease no longer protects the pane', () => {
  const d = lifecycle.decideAutoClose({
    paneId: 7, project: 'mutual', verified: true, now: NOW,
    lease: { owner: 'pane-7', task: 'T-0003', expires_at: '2026-08-22T11:00:00Z' },
  });
  assert.strictEqual(d.close, true);
});

// ── chokepoint integration (mock wezterm via test/setup.cjs) ─────────────────

test('wezterm chokepoint: split past the cap throws, logs spawn_refused, and never creates the pane', () => {
  const intelDir = path.join(TMP, 'chokepoint');
  const savedIntel = process.env.WEZBRIDGE_INTEL_DIR;
  const savedMax = process.env.WEZBRIDGE_MAX_PANES;
  process.env.WEZBRIDGE_INTEL_DIR = intelDir;
  process.env.WEZBRIDGE_MAX_PANES = '1'; // mock mux reports exactly 1 live pane
  try {
    const wez = require('../src/wezterm.cjs');
    assert.throws(() => wez.splitHorizontal(1, { cwd: 'G:/x/mutual' }), /pane cap reached/);
    const lines = fs.readFileSync(path.join(intelDir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const refusal = lines.find((l) => l.action === 'spawn_refused');
    assert.ok(refusal, 'spawn_refused was logged');
    assert.strictEqual(refusal.target, 'G:/x/mutual');
    assert.strictEqual(refusal.extra.max, 1);

    // Disabled cap → the CAP no longer refuses. T-0239: this used to assert
    // doesNotThrow, which quietly made a live pane with id 1 a precondition —
    // `splitHorizontal` calls the real mux once the gate lets it through, and
    // wezterm renumbers panes after every crash. The suite then went red with
    // no bug, which is the verifier-accuses-the-subject class (mm-151b).
    //
    // What is under test here is `assertPaneCap`, not the mux. So the assertion
    // is now on the CAP error specifically: whether the split then succeeds or
    // fails against whatever panes happen to exist is none of this test's
    // business. The count check below is the real proof the gate stayed shut.
    process.env.WEZBRIDGE_MAX_PANES = '0';
    try {
      wez.splitHorizontal(1, { cwd: 'G:/x/mutual' });
    } catch (e) {
      assert.doesNotMatch(String(e && e.message), /pane cap reached/,
        'with the cap disabled the refusal must not come from the cap');
    }
    const after = fs.readFileSync(path.join(intelDir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(after.filter((l) => l.action === 'spawn_refused').length, 1, 'no second refusal once the cap is off');
  } finally {
    if (savedIntel === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = savedIntel;
    if (savedMax === undefined) delete process.env.WEZBRIDGE_MAX_PANES;
    else process.env.WEZBRIDGE_MAX_PANES = savedMax;
  }
});
