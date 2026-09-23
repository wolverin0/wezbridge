'use strict';
/**
 * Tests for orch-ctx-check.cjs (W3: the orchestrator's own rotation gate).
 *
 * The property under test: the previous orchestrator ran to >84% context while
 * enforcing rotation on everyone else, and nothing deterministic could say so.
 * Now something can — and its verdicts must be honest in BOTH directions:
 * over-threshold must fire through the routine contract, but a closed WezTerm
 * overnight must NOT wolf-cry every 2 hours, and genuine blindness (discovery
 * threw, ctx unparseable) must be void, never clean.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateCtx, writeRecord, RUN_RECORD, FINDINGS_FILE } = require('../scripts/orch-ctx-check.cjs');
const { loadRuns, auditRuns } = require('../scripts/routine-audit.cjs');

const pane = (over = {}) => ({ tabTitle: 'orch', isClaude: true, ctx: 50, ...over });
const T = 70;

// ---------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------

test('over threshold fires orchestrator-rotation-due', () => {
  const r = evaluateCtx({ panes: [pane({ ctx: 84 })], threshold: T, tab: 'orch' });
  assert.equal(r.verdict, 'findings');
  assert.equal(r.pct, 84);
  assert.match(r.survived[0].title, /orchestrator-rotation-due/);
  assert.match(r.survived[0].title, /84%/);
});

test('threshold is strict: exactly AT threshold stays clean, one over fires', () => {
  assert.equal(evaluateCtx({ panes: [pane({ ctx: T })], threshold: T, tab: 'orch' }).verdict, 'clean');
  assert.equal(evaluateCtx({ panes: [pane({ ctx: T + 1 })], threshold: T, tab: 'orch' }).verdict, 'findings');
});

test('under threshold is clean', () => {
  assert.equal(evaluateCtx({ panes: [pane({ ctx: 11 })], threshold: T, tab: 'orch' }).verdict, 'clean');
});

test('no orch pane is clean — vacuous, not blind (no wolf overnight)', () => {
  assert.equal(evaluateCtx({ panes: [], threshold: T, tab: 'orch' }).verdict, 'clean');
  const other = pane({ tabTitle: 'brlite', ctx: 95 });
  assert.equal(evaluateCtx({ panes: [other], threshold: T, tab: 'orch' }).verdict, 'clean');
});

test('discovery failure is void, never clean — blindness must not read as calm', () => {
  const r = evaluateCtx({ panes: null, threshold: T, tab: 'orch' });
  assert.equal(r.verdict, 'void');
  assert.match(r.void_reason, /unreachable|wedged/);
});

test('orch pane present but ctx unparseable is void', () => {
  const r = evaluateCtx({ panes: [pane({ ctx: null })], threshold: T, tab: 'orch' });
  assert.equal(r.verdict, 'void');
});

test('two panes answering to orch: the worst over-stayer decides', () => {
  const r = evaluateCtx({ panes: [pane({ ctx: 30 }), pane({ ctx: 90 })], threshold: T, tab: 'orch' });
  assert.equal(r.verdict, 'findings');
  assert.equal(r.pct, 90);
});

// ---------------------------------------------------------------------------
// The contract: what this writes, routine-audit must actually consume
// ---------------------------------------------------------------------------

test('a findings verdict travels the routine-audit chain end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ctx-'));
  writeRecord(evaluateCtx({ panes: [pane({ ctx: 84 })], threshold: T, tab: 'orch' }), dir);
  assert.ok(fs.existsSync(path.join(dir, RUN_RECORD)));
  assert.ok(fs.existsSync(path.join(dir, FINDINGS_FILE)));
  const findings = auditRuns(loadRuns(dir), Date.now());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'routine-findings');
  assert.match(findings[0].why, /1 finding/);
  assert.match(findings[0].why, /orchestrator-rotation-due/);
});

test('a clean verdict travels the chain to silence — each tick overwrites the last', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ctx-'));
  writeRecord(evaluateCtx({ panes: [pane({ ctx: 84 })], threshold: T, tab: 'orch' }), dir);
  writeRecord(evaluateCtx({ panes: [pane({ ctx: 12 })], threshold: T, tab: 'orch' }), dir);
  assert.equal(auditRuns(loadRuns(dir), Date.now()).length, 0);
});

// ---------------------------------------------------------------------------
// Wiring: orchestrator-turn runs the check; --dry-run touches nothing
// ---------------------------------------------------------------------------

// T-0400: was a source-position check (indexOf('runCtxCheck') vs.
// lastIndexOf('--dry-run', callSite)) — an `if (false)` around the actual
// runCtxCheck() call would leave both string literals in the exact same
// relative order, so the position comparison stays green while the check
// never runs. Rewritten to spawn the real orchestrator-turn.cjs against a
// throwaway WEZBRIDGE_INTEL_DIR and observe the ONE side effect runCtxCheck
// owns (writeRecord's RUN_RECORD file): --dry-run must touch nothing; a real
// turn must produce it. Both real invocations are cheap here because an
// empty temp intel dir makes the rest of the turn (gate, reviews, intake)
// a fast no-op that never wakes a pane (verified: gate=0, reviews=0).
test('orchestrator-turn.cjs wires the check in, guarded from --dry-run', () => {
  const { spawnSync } = require('node:child_process');
  const ENTRY = path.join(__dirname, '..', 'scripts', 'orchestrator-turn.cjs');
  const runRecordPath = (dir) => path.join(dir, 'routine-findings', 'run-orchestrator-rotation-wezbridge.json');

  const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-turn-dry-'));
  try {
    const dry = spawnSync(process.execPath, [ENTRY, '--dry-run'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, WEZBRIDGE_INTEL_DIR: dryDir },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(dry.status, 0, `--dry-run turn exited ${dry.status}: ${dry.stdout}${dry.stderr}`);
    assert.equal(fs.existsSync(runRecordPath(dryDir)), false,
      '--dry-run must touch NOTHING — runCtxCheck (and its writeRecord) must not run');
  } finally {
    fs.rmSync(dryDir, { recursive: true, force: true });
  }

  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-turn-live-'));
  try {
    const live = spawnSync(process.execPath, [ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, WEZBRIDGE_INTEL_DIR: liveDir },
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(live.status, 0, `turn exited ${live.status}: ${live.stdout}${live.stderr}`);
    assert.equal(fs.existsSync(runRecordPath(liveDir)), true,
      'a real turn (no --dry-run) must actually call runCtxCheck — its RUN_RECORD must exist');
    const record = JSON.parse(fs.readFileSync(runRecordPath(liveDir), 'utf8'));
    assert.equal(record.routine, 'orchestrator-rotation');
  } finally {
    fs.rmSync(liveDir, { recursive: true, force: true });
  }
});
