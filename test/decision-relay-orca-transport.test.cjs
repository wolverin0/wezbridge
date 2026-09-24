'use strict';
/**
 * decision-relay-orca-transport.test.cjs — T-0599: decision-relay.cjs's
 * direct-delivery attempt (the "operator approved/cancelled" envelope) now
 * resolves and delivers through the SAME shared Orca resolver+sender a2a_send
 * and project-queue's findTarget use (src/orca-target.cjs, src/orca-send.cjs)
 * by DEFAULT — WezTerm (pane-identity resolution + sendPromptDeferredEnter)
 * is legacy, gated behind WEZBRIDGE_WEZTERM_TRANSPORT=1 (same flag T-0596
 * item 4 introduced for mcp-server.cjs/project-queue.cjs). Also covers the
 * AC4 backlog seal: a ruling approved BEFORE Orca became a viable transport
 * (ORCA_DRAIN_NOT_BEFORE / WEZBRIDGE_DRAIN_NOT_BEFORE) must never be
 * delivered live just because Orca now works — the operator's 20-24/09
 * "never re-deliver the backlog" decision.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRelay } = require('../src/decision-relay.cjs');

function mkIntel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-relay-orca-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rulings.jsonl'), '');
  return dir;
}
function writeCard(intel, card) { fs.writeFileSync(path.join(intel, 'tasks', `${card.id}.json`), JSON.stringify(card, null, 2)); }
function appendRuling(intel, line) { fs.appendFileSync(path.join(intel, 'rulings.jsonl'), JSON.stringify(line) + '\n'); }
function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
const events = (intel) => readJsonl(path.join(intel, 'events.jsonl'));
const queue = (intel, project) => readJsonl(path.join(intel, 'queues', `${project}.jsonl`));

// A wall-clock comfortably AFTER ORCA_DRAIN_NOT_BEFORE (2026-09-24T18:00:00Z)
// so fresh decisions (entry.at set to NOW below) are never backlog-sealed by
// accident in this file's "happy path" tests.
const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const FRESH_AT = '2026-09-24T23:00:00.000Z';

function seedCard(intel, over = {}) {
  writeCard(intel, { id: 'T-1099', repo: 'orcarepo', state: 'ready', kind: 'deploy', lease: null, contract: { gate: null }, next_action: null, ...over });
}

function mkOrcaDoubles({ handle = 'term_orcarepo1', ambiguous = [], sendResult } = {}) {
  const resolveCalls = [];
  const sendCalls = [];
  return {
    resolveCalls,
    sendCalls,
    resolveOrcaTargetFn: async (project) => { resolveCalls.push(project); return { handle, matchedBy: 'lane', ambiguous, warning: null }; },
    sendToOrcaTerminalFn: async (h, body) => {
      sendCalls.push({ handle: h, body });
      return sendResult || { ok: true, submitted: 'submitted', delivered: 'ok', handle: h, retryId: null, tail: ['...'], error: null };
    },
  };
}

function relayFor(intel, { orca, runLedger = () => ({ ok: true }), now = () => NOW, ...rest } = {}) {
  return createRelay({
    intelDir: intel,
    discoverPanes: () => [{ paneId: 999, project: 'must-not-be-used-by-orca-path', status: 'idle', lastLines: '' }],
    send: { sendPromptDeferredEnter: async () => { throw new Error('WezTerm transport must not be used by default (WEZBRIDGE_WEZTERM_TRANSPORT unset)'); }, verifyPromptSubmission: async () => { throw new Error('unexpected'); } },
    runLedger,
    now,
    log: () => {},
    ...(orca || {}),
    ...rest,
  });
}

test('T-0599: default (no flag) delivers via the shared Orca resolver+sender, never touches WezTerm', async () => {
  const intel = mkIntel();
  seedCard(intel);
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'dale orca', at: FRESH_AT, source: 'board-app' });
  const orca = mkOrcaDoubles();
  const out = await relayFor(intel, { orca }).relayOnce();

  assert.equal(orca.resolveCalls.length, 1, 'resolveOrcaTarget called once');
  assert.deepEqual(orca.resolveCalls, ['orcarepo']);
  assert.equal(orca.sendCalls.length, 1, 'sendToOrcaTerminal called once');
  assert.match(orca.sendCalls[0].body, /\[decision\] operator approved T-1099: dale orca/);
  assert.equal(orca.sendCalls[0].handle, 'term_orcarepo1');
  assert.deepEqual(out.delivered.map((d) => d.task), ['T-1099']);

  const ev = events(intel).filter((e) => e.event === 'decision.delivered');
  assert.equal(ev.length, 1);

  const q = queue(intel, 'orcarepo');
  assert.equal(q.length, 1);
  assert.equal(q[0].ok, true);
  assert.equal(q[0].transport, 'orca', 'la linea de la cola declara el transporte usado');
});

test('T-0599: unresolved Orca terminal => queued, not delivered, no WezTerm fallback attempted', async () => {
  const intel = mkIntel();
  seedCard(intel);
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'sin terminal', at: FRESH_AT, source: 'board-app' });
  const orca = mkOrcaDoubles({ handle: null });
  const out = await relayFor(intel, { orca }).relayOnce();

  assert.equal(orca.sendCalls.length, 0, 'no intenta enviar sin terminal resuelto');
  assert.equal(out.delivered.length, 0);
  assert.equal(out.queued.length, 1);
  const q = queue(intel, 'orcarepo');
  assert.equal(q.length, 1);
  assert.equal(q[0].ok, false);
  assert.equal(q[0].transport, 'orca');
});

test('T-0599: self-send guard — resolving to this process\' own ORCA_TERMINAL_HANDLE refuses the attempt', async () => {
  const intel = mkIntel();
  seedCard(intel);
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'self', at: FRESH_AT, source: 'board-app' });
  const orca = mkOrcaDoubles({ handle: 'term_self' });
  const prior = process.env.ORCA_TERMINAL_HANDLE;
  process.env.ORCA_TERMINAL_HANDLE = 'term_self';
  try {
    const out = await relayFor(intel, { orca }).relayOnce();
    assert.equal(orca.sendCalls.length, 0, 'nunca se entrega a si mismo');
    assert.equal(out.delivered.length, 0);
  } finally {
    if (prior === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = prior;
  }
});

test('T-0599: WEZBRIDGE_WEZTERM_TRANSPORT=1 restores the legacy WezTerm path verbatim, Orca never called', async () => {
  const intel = mkIntel();
  seedCard(intel);
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'legacy', at: FRESH_AT, source: 'board-app' });
  const orca = mkOrcaDoubles();
  const prior = process.env.WEZBRIDGE_WEZTERM_TRANSPORT;
  process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
  try {
    const sent = [];
    const relay = createRelay({
      intelDir: intel,
      discoverPanes: () => [{ paneId: 5, project: path.join(intel, '..', 'orcarepo'), status: 'idle', lastLines: '❯' }],
      send: { sendPromptDeferredEnter: async (paneId, text) => { sent.push({ paneId, text }); return 'ok'; }, verifyPromptSubmission: async () => 'submitted' },
      runLedger: () => ({ ok: true }),
      now: () => NOW,
      log: () => {},
      resolveOrcaTargetFn: orca.resolveOrcaTargetFn,
      sendToOrcaTerminalFn: orca.sendToOrcaTerminalFn,
    });
    const out = await relay.relayOnce();
    assert.equal(orca.resolveCalls.length, 0, 'Orca resolver nunca se llama con el flag on');
    assert.equal(orca.sendCalls.length, 0);
    assert.equal(sent.length, 1, 'WezTerm SI se usa con el flag on');
    assert.deepEqual(out.delivered.map((d) => d.task), ['T-1099']);
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_WEZTERM_TRANSPORT; else process.env.WEZBRIDGE_WEZTERM_TRANSPORT = prior;
  }
});

// ── AC4: backlog seal ───────────────────────────────────────────────────────
test('T-0599 AC4: a ruling approved BEFORE the Orca backlog-seal cutoff is never delivered live, even though Orca now works', async () => {
  const intel = mkIntel();
  seedCard(intel);
  const preCutoffAt = '2026-09-22T12:00:00.000Z'; // before ORCA_DRAIN_NOT_BEFORE (2026-09-24T18:00Z)
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'backlog', at: preCutoffAt, source: 'board-app' });
  const orca = mkOrcaDoubles();
  const out = await relayFor(intel, { orca }).relayOnce();

  assert.equal(orca.resolveCalls.length, 0, 'nunca intenta resolver un terminal para una decision sellada');
  assert.equal(orca.sendCalls.length, 0);
  assert.equal(out.delivered.length, 0);
  assert.deepEqual(out.undeliverable.map((u) => ({ task: u.task, reason: u.reason })), [{ task: 'T-1099', project: 'orcarepo', reason: 'backlog-sealed' }].map(({ task, reason }) => ({ task, reason })));

  const ev = events(intel).filter((e) => e.event === 'decision.undeliverable');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reason, 'backlog-sealed');

  // Never queued either — a sealed decision must not resurface via queue-drain.
  assert.equal(fs.existsSync(path.join(intel, 'queues', 'orcarepo.jsonl')), false);

  // A second pass does not re-ingest/re-attempt it (markResolved already ran).
  const again = await relayFor(intel, { orca }).relayOnce();
  assert.equal(again.ingested, 0);
  assert.equal(orca.sendCalls.length, 0);
});

test('T-0599 AC4: WEZBRIDGE_DRAIN_NOT_BEFORE override moves the decision-relay cutoff too', async () => {
  const intel = mkIntel();
  seedCard(intel);
  const at = '2026-09-24T19:00:00.000Z'; // after the DEFAULT cutoff, before the overridden one
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'override', at, source: 'board-app' });
  const orca = mkOrcaDoubles();
  const prior = process.env.WEZBRIDGE_DRAIN_NOT_BEFORE;
  process.env.WEZBRIDGE_DRAIN_NOT_BEFORE = '2026-09-24T20:00:00.000Z';
  try {
    const out = await relayFor(intel, { orca }).relayOnce();
    assert.equal(orca.sendCalls.length, 0);
    assert.deepEqual(out.undeliverable.map((u) => u.reason), ['backlog-sealed']);
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_DRAIN_NOT_BEFORE; else process.env.WEZBRIDGE_DRAIN_NOT_BEFORE = prior;
  }
});

test('T-0599 AC4: a ruling approved AFTER the cutoff is unaffected by the seal', async () => {
  const intel = mkIntel();
  seedCard(intel);
  appendRuling(intel, { task: 'T-1099', category: 'awaiting-operator', ruling: 'approved', why: 'post-cutoff', at: FRESH_AT, source: 'board-app' });
  const orca = mkOrcaDoubles();
  const out = await relayFor(intel, { orca }).relayOnce();
  assert.equal(orca.sendCalls.length, 1);
  assert.deepEqual(out.delivered.map((d) => d.task), ['T-1099']);
});
