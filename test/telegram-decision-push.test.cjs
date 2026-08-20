'use strict';
/**
 * telegram-decision-push.test.cjs — decisions must come TO the operator.
 *
 * Slice 1 of the 2026-08-20 observability plan: the telegram-streamer's
 * existing poll loop pushes ONE message per new operator-gated task to the
 * 'decisiones' topic with a board link. This file tests the pure detection
 * (src/decision-push.cjs) and the push orchestration with a stubbed sender.
 *
 * THE historical bug this guards: two gate predicates diverged
 * (`contract.gate` vs top-level `gate`) and gated tasks silently vanished
 * from the one surface built to show them. The detection here MUST use the
 * same `gateOf` as scripts/fleet-board.cjs — the fixture set includes one
 * task of each shape, so a predicate that reads only one location goes RED.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectNewDecisions, pushDecisions, STATE_BASENAME,
} = require('../src/decision-push.cjs');

// Each test gets its own intel dir; decision-push reads the env at CALL time.
function tmpIntel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-push-'));
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  return dir;
}

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_BASENAME), 'utf8')); }
  catch { return {}; }
}

// --- Fixtures: the two real gate shapes observed in the ledger -------------
// T-0009-style: gate inside contract.
const gatedContract = {
  id: 'T-9001', repo: 'wezbridge', title: 'needs a ruling on the payload contract',
  state: 'queued', contract: { gate: 'operator' }, gate: null,
  blocker: 'HTTP 422 — is the deploy contract ours to change?',
};
// T-0110-style: top-level gate, contract null. THE mutation-sensitive shape.
const gatedTopLevel = {
  id: 'T-9002', repo: 'infra', title: 'which domain do we keep',
  state: 'blocked', contract: null, gate: 'operator',
  blocker: 'two domains resolve; operator must pick one',
};
const openUngated = {
  id: 'T-9003', repo: 'app', title: 'ordinary running work',
  state: 'running', contract: null, gate: null,
};
const gatedButClosed = {
  id: 'T-9004', repo: 'app', title: 'was gated, already ruled',
  state: 'done', contract: { gate: 'operator' }, gate: null,
};

const NOW = Date.parse('2026-08-20T12:00:00Z');

// ---------------------------------------------------------------------------
// detectNewDecisions — pure
// ---------------------------------------------------------------------------

test('a decision is an OPEN task with the operator gate in EITHER location', () => {
  const { toNotify } = detectNewDecisions(
    [gatedContract, gatedTopLevel, openUngated, gatedButClosed], {}, NOW);
  assert.deepStrictEqual(toNotify.map((t) => t.id).sort(), ['T-9001', 'T-9002'],
    'both gate shapes must be detected — reading only contract.gate is the historical bug');
});

test('already-pushed decisions are not returned again', () => {
  const state = { 'T-9001': { pushed_at: new Date(NOW).toISOString() } };
  const { toNotify } = detectNewDecisions([gatedContract, gatedTopLevel], state, NOW);
  assert.deepStrictEqual(toNotify.map((t) => t.id), ['T-9002']);
});

test('non-gated open tasks are never decisions', () => {
  const { toNotify } = detectNewDecisions([openUngated], {}, NOW);
  assert.deepStrictEqual(toNotify, []);
});

test('ungating clears the entry so re-gating re-notifies', () => {
  const state = { 'T-9001': { pushed_at: new Date(NOW).toISOString() } };
  const ungated = { ...gatedContract, contract: null };
  const r1 = detectNewDecisions([ungated], state, NOW);
  assert.deepStrictEqual(r1.state, {}, 'entry must be cleared when the task stops being a decision');
  const r2 = detectNewDecisions([gatedContract], r1.state, NOW);
  assert.deepStrictEqual(r2.toNotify.map((t) => t.id), ['T-9001'], 're-gate must re-notify');
});

test('a closed task clears its entry too (ruling delivered)', () => {
  const state = { 'T-9004': { pushed_at: new Date(NOW).toISOString() } };
  const { state: pruned } = detectNewDecisions([gatedButClosed], state, NOW);
  assert.deepStrictEqual(pruned, {});
});

// ---------------------------------------------------------------------------
// pushDecisions — orchestration with stubbed telegram
// ---------------------------------------------------------------------------

test('a gated task is pushed once; the second cycle sends nothing', async () => {
  const dir = tmpIntel();
  const sent = [];
  const send = async (text) => { sent.push(text); return { ok: true }; };

  await pushDecisions({ tasks: [gatedContract, gatedTopLevel, openUngated], send, now: NOW });
  assert.strictEqual(sent.length, 2, 'one message per new decision');

  await pushDecisions({ tasks: [gatedContract, gatedTopLevel, openUngated], send, now: NOW });
  assert.strictEqual(sent.length, 2, 'second cycle must be silent — dedupe state persisted');
  assert.ok(readState(dir)['T-9001'] && readState(dir)['T-9002'],
    'both pushes recorded in .decision-pushed.json');
});

test('the message carries id, repo, title, blocker excerpt and the board URL', async () => {
  tmpIntel();
  process.env.WEZBRIDGE_BOARD_URL = 'http://myhost:9999/board';
  const sent = [];
  await pushDecisions({ tasks: [gatedTopLevel], send: async (t) => { sent.push(t); return { ok: true }; }, now: NOW });
  delete process.env.WEZBRIDGE_BOARD_URL;

  assert.strictEqual(sent.length, 1);
  const msg = sent[0];
  for (const piece of ['T-9002', 'infra', 'which domain do we keep',
    'two domains resolve', 'http://myhost:9999/board']) {
    assert.ok(msg.includes(piece), `message must include "${piece}" — got:\n${msg}`);
  }
});

test('board URL defaults to :4272 when the env var is unset', async () => {
  tmpIntel();
  delete process.env.WEZBRIDGE_BOARD_URL;
  const sent = [];
  await pushDecisions({ tasks: [gatedContract], send: async (t) => { sent.push(t); return { ok: true }; }, now: NOW });
  assert.ok(sent[0].includes('http://127.0.0.1:4272/'), sent[0]);
});

test('a failed POST leaves state unchanged so the next cycle retries', async () => {
  const dir = tmpIntel();
  let calls = 0;
  const failing = async () => { calls++; return { ok: false, description: 'boom' }; };
  await pushDecisions({ tasks: [gatedContract], send: failing, now: NOW });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(readState(dir), {}, 'nothing marked pushed on failure');
  assert.ok(!fs.existsSync(path.join(dir, 'events.jsonl')),
    'no decision.notified event for a message that never reached Telegram');

  const sent = [];
  await pushDecisions({ tasks: [gatedContract], send: async (t) => { sent.push(t); return { ok: true }; }, now: NOW });
  assert.strictEqual(sent.length, 1, 'retry succeeded on the next cycle');
  assert.ok(readState(dir)['T-9001'], 'marked pushed only after the successful POST');
});

test('a send that THROWS is treated as a failure, not a crash', async () => {
  const dir = tmpIntel();
  await pushDecisions({ tasks: [gatedContract], send: async () => { throw new Error('net down'); }, now: NOW });
  assert.deepStrictEqual(readState(dir), {}, 'thrown send must not mark pushed');
});

test('successful push appends a metadata-only decision.notified event', async () => {
  const dir = tmpIntel();
  await pushDecisions({ tasks: [gatedTopLevel], send: async () => ({ ok: true }), now: NOW });
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const evt = JSON.parse(lines[0]);
  assert.strictEqual(evt.event, 'decision.notified');
  assert.strictEqual(evt.task_id, 'T-9002');
  assert.ok(evt.time, 'event carries a time');
  assert.ok(!('blocker' in evt) && !('title' in evt), 'events.jsonl is metadata only — no bodies');
});

test('ungate then re-gate re-notifies through the full push path', async () => {
  tmpIntel();
  const sent = [];
  const send = async (t) => { sent.push(t); return { ok: true }; };

  await pushDecisions({ tasks: [gatedContract], send, now: NOW });
  assert.strictEqual(sent.length, 1);

  // Operator answers: gate comes off. Entry must clear durably.
  await pushDecisions({ tasks: [{ ...gatedContract, contract: null }], send, now: NOW });
  assert.strictEqual(sent.length, 1, 'ungated task must not be pushed');

  // Re-gated later: it is a NEW question — notify again.
  await pushDecisions({ tasks: [gatedContract], send, now: NOW });
  assert.strictEqual(sent.length, 2, 're-gate must re-notify');
});
