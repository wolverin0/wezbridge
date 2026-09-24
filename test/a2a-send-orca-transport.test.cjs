'use strict';
/**
 * a2a-send-orca-transport.test.cjs — T-0596: a2a_send({to_project}) delivers via
 * an ORCA terminal when WezTerm has no live pane for the project (the fleet's
 * 2026-09-24 move to Orca). Spawns the REAL mcp-server.cjs as a subprocess
 * (same pattern as a2a-queue-records-result.test.cjs) with WEZBRIDGE_WEZTERM_BIN
 * pointed at the existing wezterm-mock (0 agent panes, so WezTerm resolution
 * always misses — the exact precondition this card fixes) and ORCA_CLI pointed
 * at test/mocks/orca-mock.cjs.
 */
const { guardCompanions, companionsRoot } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.cjs');
const WEZ_MOCK = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
const ORCA_MOCK = path.join(__dirname, 'mocks', 'orca-mock.cjs');
// companionsRoot() (not a fixed ../.. — this file also runs from an isolated
// worktree, where ../.. is NOT the Py Apps root) so this matches whatever
// guardCompanions above already verified exists.
const CURATION = path.join(companionsRoot(), '_docs-curation');
const REAL_KINDS = path.join(companionsRoot(), '_intel', 'kinds.json');

function callTool(name, args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      const line = stdout.slice(0, nl).trim();
      child.stdin.end();
      child.kill('SIGTERM');
      try { resolve(JSON.parse(line)); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}; stdout=${stdout}; stderr=${stderr}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

const resultText = (res) => res.result.content[0].text;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-orca-'));
  const intel = path.join(root, '_intel');
  const curation = path.join(root, '_docs-curation');
  const orcaState = path.join(root, 'orca-state');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  fs.mkdirSync(curation, { recursive: true });
  fs.mkdirSync(orcaState, { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(intel, 'kinds.json'));
  fs.copyFileSync(path.join(CURATION, 'ledger.cjs'), path.join(curation, 'ledger.cjs'));
  fs.copyFileSync(path.join(CURATION, 'sweeper-config.json'), path.join(curation, 'sweeper-config.json'));
  return { root, intel, orcaState };
}

function writeTerminals(root, terminals) {
  const f = path.join(root, 'orca-terminals.json');
  fs.writeFileSync(f, JSON.stringify(terminals));
  return f;
}

function envFor(intel, orcaState, terminalsFile, extra = {}) {
  return {
    WEZBRIDGE_INTEL_DIR: intel,
    WEZBRIDGE_WEZTERM_BIN: WEZ_MOCK,
    WEZBRIDGE_SAFETY_OVERRIDE: '1',
    ORCA_CLI: ORCA_MOCK,
    ORCA_MOCK_STATE: orcaState,
    ORCA_MOCK_TERMINALS: terminalsFile,
    ...extra,
  };
}

function writeRoster(intel, lanes) {
  fs.writeFileSync(path.join(intel, 'orchestrators.json'), JSON.stringify({ version: 1, lanes }));
}

test('AC1: a2a_send to_project delivers via Orca when no WezTerm pane is live, and returns delivered:true with screen evidence', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', from_pane: 5, type: 'progress', corr: 'T-0596:smoke:20260924', body: 'smoke T-0596 transporte orca — ignorar',
    }, envFor(intel, orcaState, terminalsFile));
    assert.equal(res.result.isError, false, resultText(res));
    const payload = JSON.parse(resultText(res));
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.transport, 'orca');
    assert.equal(payload.to_handle, 'term_drill1');
    assert.equal(payload.submitted, 'submitted');
    assert.equal(payload.delivered, 'ok');
    assert.equal(payload.queued, true, 'still durably queued like every to_project send');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-0600 U2: immediate (non-queued) Orca path — send accepted but screen never shows the envelope -> ok:false, delivered:false, still durably queued for retry', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', from_pane: 5, type: 'progress', corr: 'T-0600:u2:20260924', body: 'never lands on screen (T-0600 U2)',
    }, envFor(intel, orcaState, terminalsFile, { ORCA_MOCK_SWALLOW_HANDLE: 'term_drill1' }));
    assert.equal(res.result.isError, false, resultText(res));
    const payload = JSON.parse(resultText(res));
    // Before the T-0600 fix this asserted true — a submitted:'unknown' Orca
    // read-back was treated as verified because it merely wasn't 'stuck'.
    assert.equal(payload.ok, false, JSON.stringify(payload));
    assert.equal(payload.transport, 'orca');
    assert.equal(payload.submitted, 'unknown');
    assert.equal(payload.delivered, 'unknown');
    assert.equal(payload.queued, true, 'must still be durably queued for scripts/queue-drain.cjs to retry');

    const queueLine = fs.readFileSync(path.join(intel, 'queues', 'drillrepo.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((q) => q.corr === 'T-0600:u2:20260924');
    assert.ok(queueLine, 'queue line must exist');
    assert.equal(queueLine.ok, false, 'an unverified orca delivery must NOT be recorded as ok:true in the durable queue');

    const consumerDeliveredFile = path.join(intel, 'queues', 'state', 'drillrepo', 'delivered.json');
    if (fs.existsSync(consumerDeliveredFile)) {
      const delivered = JSON.parse(fs.readFileSync(consumerDeliveredFile, 'utf8'));
      assert.equal(delivered.includes(queueLine.id), false, 'must not be tombstoned as already-delivered — the drain still needs to retry it');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AC2 (regression): WezTerm destinations are unaffected — a live WezTerm pane still wins over any Orca terminal', async () => {
  // Reuses the exact mechanism a2a-queue-records-result.test.cjs relies on: the
  // wezterm-mock's `list` has no agent panes, so this test cannot assert a
  // positive WezTerm delivery through the mock alone — instead it proves Orca
  // is never even consulted when pane-identity.resolve() finds nothing BUT an
  // alias/self-project resolves via WezTerm first. Real WezTerm-path coverage
  // is the full existing suite (a2a-queue-records-result.test.cjs et al.),
  // required green in the same run as this file.
  const { root, intel, orcaState } = sandbox();
  try {
    const terminalsFile = writeTerminals(root, []); // no orca terminals at all
    const res = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'progress', corr: 'x', body: 'hola',
    }, envFor(intel, orcaState, terminalsFile));
    const payload = JSON.parse(resultText(res));
    assert.equal(payload.queued, true);
    assert.equal(payload.ok, false, 'no wezterm pane and no orca terminal -> still queued, not delivered');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("SELF-SEND GUARD: a2a_send refuses when to_project resolves to the caller's own Orca terminal (ORCA_TERMINAL_HANDLE)", async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_self', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_self', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', from_pane: 5, type: 'progress', corr: 'T-0596:self:20260924', body: 'no deberia salir nunca',
    }, envFor(intel, orcaState, terminalsFile, { ORCA_TERMINAL_HANDLE: 'term_self' }));
    assert.equal(res.result.isError, true, resultText(res));
    assert.match(resultText(res), /self-send: BLOCKED a2a_send/);
    assert.equal(fs.existsSync(path.join(intel, 'queues', 'drillrepo.jsonl')), false, 'self-send must not enqueue a retry-storm candidate');
    const stateFile = path.join(orcaState, 'term_self.json');
    if (fs.existsSync(stateFile)) {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.deepEqual(s.tail, [], 'self-send must not type anything into the terminal');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AC3: delivery records (queue line + a2a-results.jsonl for type=result) carry transport', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const GOOD_BODY = [
      'FinalOrchestra JOB-1: COMPLETED',
      'criteria:',
      '- algo: pass — evidencia concreta',
      'files_changed: src/x.cjs',
      'next_action: nada',
    ].join('\n');
    await callTool('a2a_send', {
      to_project: 'drillrepo', from_pane: 5, type: 'result', corr: 'T-0596:res:20260924', body: GOOD_BODY,
    }, envFor(intel, orcaState, terminalsFile));

    const queueLine = fs.readFileSync(path.join(intel, 'queues', 'drillrepo.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((q) => q.corr === 'T-0596:res:20260924');
    assert.ok(queueLine, 'queue line must exist');
    assert.equal(queueLine.transport, 'orca');

    const resultsLine = fs.readFileSync(path.join(intel, 'a2a-results.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.corr === 'T-0596:res:20260924');
    assert.ok(resultsLine, 'a2a-results.jsonl line must exist');
    assert.equal(resultsLine.transport, 'orca');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── T-0600 U3: Orca sender identity without --from-pane ─────────────────────

test('T-0600 U3: no --from-pane, ORCA_TERMINAL_HANDLE resolvable via census+roster -> from_project = that lane, envelope delivered', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [
      { lane: 'wezbridge-fleet', repos: ['wezbridge'], handle: 'term_fleet', state: 'live' },
      { lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' },
    ]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_fleet', title: 'fleet', worktreePath: 'G:/Py Apps/wezbridge', connected: true, writable: true },
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', type: 'progress', corr: 'T-0600:u3:sender', body: 'sent headless from the Fleet Orca terminal',
      // NO from_pane at all — the exact precondition this fixes.
    }, envFor(intel, orcaState, terminalsFile, { ORCA_TERMINAL_HANDLE: 'term_fleet' }));
    assert.equal(res.result.isError, false, resultText(res));
    const payload = JSON.parse(resultText(res));
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.from_project, 'wezbridge-fleet');
    assert.equal(payload.from_source, 'orca-terminal');
    assert.equal(payload.from_pane, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-0600 U3: no --from-pane and ORCA_TERMINAL_HANDLE points at an unknown/dead terminal -> clear error, isError:true', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, []);
    const terminalsFile = writeTerminals(root, []); // handle is nowhere in the live census
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', type: 'progress', corr: 'T-0600:u3:unknown', body: 'should never leave',
    }, envFor(intel, orcaState, terminalsFile, { ORCA_TERMINAL_HANDLE: 'term_ghost' }));
    assert.equal(res.result.isError, true, resultText(res));
    assert.match(resultText(res), /from_pane not given/);
    assert.match(resultText(res), /term_ghost/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-0600 U3: explicit --from-project still wins over ORCA_TERMINAL_HANDLE census resolution', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'wezbridge-fleet', repos: ['wezbridge'], handle: 'term_fleet', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_fleet', title: 'fleet', worktreePath: 'G:/Py Apps/wezbridge', connected: true, writable: true },
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', type: 'progress', corr: 'T-0600:u3:explicit', body: 'explicit wins',
      from_project: 'a-manually-named-sender',
    }, envFor(intel, orcaState, terminalsFile, { ORCA_TERMINAL_HANDLE: 'term_fleet' }));
    const payload = JSON.parse(resultText(res));
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.from_project, 'a-manually-named-sender');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T-0600 U3 SECURITY: sender-identity resolution via ORCA_TERMINAL_HANDLE does NOT widen dispatch authority — a blocked card still refuses the send', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'wezbridge-fleet', repos: ['wezbridge'], handle: 'term_fleet', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_fleet', title: 'fleet', worktreePath: 'G:/Py Apps/wezbridge', connected: true, writable: true },
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    fs.writeFileSync(path.join(intel, 'tasks', 'T-0600.json'), JSON.stringify({
      id: 'T-0600', state: 'blocked', blocker: 'operator has not approved this yet',
    }));
    const res = await callTool('a2a_send', {
      to_project: 'drillrepo', type: 'request', corr: 'T-0600:blocked-dispatch', body: 'try to dispatch anyway',
      // Sender identity resolved via the NEW orca-terminal path (no from_pane) —
      // must not skip the dispatch gate that already runs for every other sender.
    }, envFor(intel, orcaState, terminalsFile, { ORCA_TERMINAL_HANDLE: 'term_fleet' }));
    assert.equal(res.result.isError, true, resultText(res));
    assert.match(resultText(res), /dispatch-gate: BLOCKED a2a_send/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an OLD (>24h) queued entry is not auto-redelivered as a side effect of the transport field addition', async () => {
  // Belt-and-suspenders per the brief: project-queue.cjs's enqueue() gained an
  // additive `transport` field only — the drain/TTL logic (queue-drain.cjs,
  // covered by test/project-queue-pending-expiry.test.cjs) is untouched by this
  // card. This asserts enqueue() itself still writes plain, inert lines: no
  // resend, no drain, just confirming the new field does not change what a
  // reader sees for old lines (a line written before this change has NO
  // transport field at all, and must stay that way — parsers must not require it).
  const pq = require('../src/project-queue.cjs');
  const { root } = sandbox();
  try {
    const before = pq.enqueue({ project: 'legacy', corr: 'old-corr', type: 'progress', from_pane: 1, ok: false, body: 'pre-existing decision relay entry' }, { base: root });
    assert.equal(before.ok, true);
    const line = JSON.parse(fs.readFileSync(path.join(root, 'queues', 'legacy.jsonl'), 'utf8').trim());
    assert.equal('transport' in line, false, 'omitting transport on an untransported enqueue call must not synthesize one');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
