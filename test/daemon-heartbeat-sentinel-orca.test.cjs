'use strict';

/**
 * daemon-heartbeat-sentinel-orca.test.cjs — T-0599 FIX-UP: the verifier's
 * missed finding. daemon-heartbeat-sentinel.cjs's deliverPoke() still sent
 * its every-5-min Windows-scheduled-task poke straight to a WezTerm pane via
 * sendPromptDeferredEnter/verifyPromptSubmission, with no Orca routing and no
 * WEZBRIDGE_WEZTERM_TRANSPORT gate — unlike decision-relay.cjs (T-0599) it
 * was NOT in the original inventory. Now that the fleet lives in Orca
 * (T-0596), that poke reached nobody.
 *
 * This suite MUST fail against the pre-fix deliverPoke() (WezTerm-only, no
 * flag) because: (a) it calls the injected orcaTargetFn/orcaSendFn and
 * expects them to be used by DEFAULT with no flag set, and (b) with the flag
 * set it expects ONLY the WezTerm double to be called and the Orca doubles
 * to see zero calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deliverPoke, deliverPokeOrca, deliverPokeWezTerm,
} = require('../scripts/daemon-heartbeat-sentinel.cjs');

function mkOrcaDoubles({ handle = 'term_wezbridge1', ambiguous = [], sendResult } = {}) {
  const resolveCalls = [];
  const sendCalls = [];
  return {
    resolveCalls,
    sendCalls,
    resolveOrcaTargetFn: async (project) => { resolveCalls.push(project); return { handle, matchedBy: 'lane', ambiguous, warning: null }; },
    sendToOrcaTerminalFn: async (h, text) => {
      sendCalls.push({ handle: h, text });
      return sendResult || { ok: true, submitted: 'submitted', delivered: 'ok', handle: h, retryId: null, tail: ['...'], error: null };
    },
  };
}

// action-log.cjs writes to disk; point it at a scratch dir so this suite
// never touches the real _intel/actions.jsonl.
let priorIntelDir;
let priorWezTransport;
let priorOrcaHandle;
let priorOrchRepo;
test.beforeEach(() => {
  priorIntelDir = process.env.WEZBRIDGE_INTEL_DIR;
  priorWezTransport = process.env.WEZBRIDGE_WEZTERM_TRANSPORT;
  priorOrcaHandle = process.env.ORCA_TERMINAL_HANDLE;
  priorOrchRepo = process.env.WEZBRIDGE_ORCH_REPO;
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  process.env.WEZBRIDGE_INTEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-sentinel-orca-'));
  delete process.env.WEZBRIDGE_WEZTERM_TRANSPORT;
  delete process.env.ORCA_TERMINAL_HANDLE;
  process.env.WEZBRIDGE_ORCH_REPO = 'wezbridge';
});
test.afterEach(() => {
  if (priorIntelDir === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = priorIntelDir;
  if (priorWezTransport === undefined) delete process.env.WEZBRIDGE_WEZTERM_TRANSPORT; else process.env.WEZBRIDGE_WEZTERM_TRANSPORT = priorWezTransport;
  if (priorOrcaHandle === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = priorOrcaHandle;
  if (priorOrchRepo === undefined) delete process.env.WEZBRIDGE_ORCH_REPO; else process.env.WEZBRIDGE_ORCH_REPO = priorOrchRepo;
});

test('T-0599 fixup: default (no flag) delivers the poke via the shared Orca resolver+sender', async () => {
  const orca = mkOrcaDoubles();
  const result = await deliverPoke('DAEMON DOWN — test', null, orca);
  assert.equal(orca.resolveCalls.length, 1, 'resolveOrcaTarget called once');
  assert.deepEqual(orca.resolveCalls, ['wezbridge']);
  assert.equal(orca.sendCalls.length, 1, 'sendToOrcaTerminal called once');
  assert.match(orca.sendCalls[0].text, /\[daemon-sentinel\] DAEMON DOWN — test/);
  assert.equal(result.delivered, true);
  assert.equal(result.handle, 'term_wezbridge1');
});

test('T-0599 fixup: WEZBRIDGE_WEZTERM_TRANSPORT=1 uses ONLY the legacy WezTerm path, Orca doubles never called', async () => {
  process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
  const orca = mkOrcaDoubles();
  // No live WezTerm pane in this test env — deliverPokeWezTerm calls the REAL
  // pane-discovery.cjs, which fails soft to "no orchestrator pane found" when
  // there is no census. The point of this test is the ROUTING, not WezTerm's
  // own delivery mechanics (covered by findOrchestratorPane's own callers).
  const result = await deliverPoke('DAEMON DOWN — test', null, orca);
  assert.equal(orca.resolveCalls.length, 0, 'Orca resolver must NOT be called with the flag on');
  assert.equal(orca.sendCalls.length, 0, 'Orca sender must NOT be called with the flag on');
  assert.equal(typeof result.delivered, 'boolean');
});

test('T-0599 fixup: unresolved Orca terminal reports undelivered, never throws', async () => {
  const orca = mkOrcaDoubles({ handle: null });
  const result = await deliverPoke('DAEMON DOWN — test', null, orca);
  assert.equal(orca.sendCalls.length, 0, 'no send attempt without a resolved terminal');
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'no orchestrator pane found');
});

test('T-0599 fixup: ambiguous Orca resolution reports undelivered with its own reason', async () => {
  const orca = mkOrcaDoubles({ handle: 'term_a', ambiguous: ['term_a', 'term_b'] });
  const result = await deliverPoke('DAEMON DOWN — test', null, orca);
  assert.equal(orca.sendCalls.length, 0);
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'ambiguous-pane');
});

test('T-0599 fixup: self-send guard refuses delivering to ORCA_TERMINAL_HANDLE', async () => {
  process.env.ORCA_TERMINAL_HANDLE = 'term_wezbridge1';
  const orca = mkOrcaDoubles({ handle: 'term_wezbridge1' });
  const result = await deliverPoke('DAEMON DOWN — test', null, orca);
  assert.equal(orca.sendCalls.length, 0, 'never delivers to itself');
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'self-send');
});

test('T-0599 fixup: recheck() is honored — a recovered daemon during resolution is not sent', async () => {
  const orca = mkOrcaDoubles();
  const result = await deliverPokeOrca('DAEMON DOWN — test', () => null, orca);
  assert.equal(orca.sendCalls.length, 0);
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'daemon recovered before alert delivery');
});

test('T-0599 fixup: send failure (ok:false) reports undelivered with the sender\'s error, not a thrown exception', async () => {
  const orca = mkOrcaDoubles({ sendResult: { ok: false, submitted: 'unknown', delivered: 'unknown', handle: 'term_wezbridge1', retryId: null, tail: null, error: 'orca timeout' } });
  const result = await deliverPokeOrca('DAEMON DOWN — test', null, orca);
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'orca timeout');
});

test('T-0599 fixup mutation sanity: deliverPokeWezTerm exists and is a distinct function from deliverPokeOrca', () => {
  assert.equal(typeof deliverPokeWezTerm, 'function');
  assert.equal(typeof deliverPokeOrca, 'function');
  assert.notEqual(deliverPokeWezTerm, deliverPokeOrca);
});
