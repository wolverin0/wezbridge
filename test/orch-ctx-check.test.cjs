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

test('orchestrator-turn.cjs wires the check in, guarded from --dry-run', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'orchestrator-turn.cjs'), 'utf8');
  assert.match(src, /require\(['"]\.\/orch-ctx-check\.cjs['"]\)/);
  assert.match(src, /runCtxCheck/);
  const callSite = src.indexOf('runCtxCheck');
  const guard = src.lastIndexOf("--dry-run", callSite);
  assert.ok(guard > -1, 'the check call is not guarded by a --dry-run test above it');
});
