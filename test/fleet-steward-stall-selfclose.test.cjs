'use strict';
/**
 * T-0479 — clearStall (scripts/orchestrator-turn.cjs, T-0283 AC6) cancels the
 * loop-stall card (kind `question`, gate `operator`, origin_key
 * `orchestrator:loop-stall:*`) WITHOUT writing an operator ruling — it is a
 * mechanical, code-driven close, not a human decision taken in a pane.
 * auditUnrecordedDecisions (fleet-steward.cjs) could not tell the two apart:
 * it flagged T-0467, auto-closed 14/09 by clearStall, as decision-unrecorded
 * 24h later. That is the lint firing on CORRECT behaviour.
 *
 * Fix: auditUnrecordedDecisions exempts a card ONLY when BOTH are true —
 * origin_key starts with `orchestrator:loop-stall:` AND evaluator_evidence
 * carries the literal marker clearStall itself writes ("la alarma de stall
 * se cierra sola (T-0283 AC6)"). origin_key alone is NOT enough (a human can
 * hand-cancel a loop-stall card without clearStall ever running), which is
 * the negative control below.
 *
 * Fail-first: before the fix, the loop-stall card cancelled by clearStall's
 * real output shape DOES produce a decision-unrecorded finding, same as any
 * other operator-gated card that left `blocked` with no ruling on file.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');
const { FINDING_CATEGORY } = require('../src/rulings.cjs');

const NOW = Date.parse('2026-09-15T10:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const CAT = 'decision-unrecorded';
const CLEARSTALL_MARKER = 'la alarma de stall se cierra sola (T-0283 AC6)';

function intelWith({ rulings = [], cards = [] }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-stall-selfclose-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'rulings.jsonl'), rulings.map((r) => JSON.stringify(r)).join('\n') + (rulings.length ? '\n' : ''));
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  for (const c of cards) fs.writeFileSync(path.join(d, 'tasks', `${c.id}.json`), JSON.stringify(c, null, 2));
  return d;
}

/** Shape of the loop-stall card AFTER clearStall runs on it (T-0283 AC6, orchestrator-turn.cjs:420-453). */
const stallSelfClosed = (over = {}) => ({
  id: 'T-0467', repo: 'wezbridge', kind: 'question', title: 'The orchestrator loop is firing and achieving nothing',
  state: 'cancelled', gate: 'operator', blocked_by: 'operator',
  origin_key: 'orchestrator:loop-stall:2026-09-14T09:00:00.000Z',
  evaluator_evidence: `loop productivo de nuevo ${hoursAgo(2)}: ${CLEARSTALL_MARKER}`,
  lease: null, created_at: hoursAgo(30), state_changed_at: hoursAgo(5), updated_at: hoursAgo(5), ...over,
});

const findings = (dir, cards) => steward.audit(cards, NOW, dir).findings.filter((f) => f.category === CAT);

test('AC1 fail-first: loop-stall card cancelled by clearStall (real evidence marker) must NOT fire decision-unrecorded', () => {
  const card = stallSelfClosed();
  const dir = intelWith({ cards: [card] });
  const f = findings(dir, [card]);
  assert.deepEqual(f, [], 'clearStall closing its own alarm mechanically is not an unrecorded human decision');
});

test('AC2 negative control A: same gate/state, hand-cancelled by a human with no ruling STILL fires', () => {
  // Same operator-gated card, same left-gate state, but NO evaluator_evidence
  // at all — nothing distinguishes it from any other silent pane decision.
  const card = stallSelfClosed({ evaluator_evidence: undefined });
  delete card.evaluator_evidence;
  const dir = intelWith({ cards: [card] });
  const f = findings(dir, [card]);
  assert.equal(f.length, 1, 'origin_key alone must not buy an exemption a human hand-cancel could trivially have');
  assert.equal(f[0].id, 'T-0467');
  assert.equal(f[0].category, FINDING_CATEGORY.decisionUnrecorded);
});

test('AC2 negative control B: loop-stall origin_key cancelled WITHOUT the clearStall evidence marker still fires', () => {
  const card = stallSelfClosed({ evaluator_evidence: 'cancelled manually, no longer needed' });
  const dir = intelWith({ cards: [card] });
  const f = findings(dir, [card]);
  assert.equal(f.length, 1, 'a loop-stall origin_key with generic/forged-looking evidence is not the clearStall trace');
});

test('AC2 negative control C: a non-stall gate=operator card moved to done by hand, no ruling, still fires (existing behaviour untouched)', () => {
  const card = {
    id: 'T-0801', repo: 'infra', kind: 'deploy', title: 'restart de wabot', state: 'done', gate: 'operator',
    blocked_by: 'operator', lease: null, created_at: hoursAgo(30), state_changed_at: hoursAgo(5), updated_at: hoursAgo(5),
  };
  const dir = intelWith({ cards: [card] });
  const f = findings(dir, [card]);
  assert.equal(f.length, 1, 'ordinary decision-unrecorded detection must be unaffected by the stall exemption');
});

test('AC1 control: an operator ruling on the stall card still suppresses the finding on its own (exemption is additive, not a replacement)', () => {
  const card = stallSelfClosed();
  const ruling = { task: 'T-0467', ruling: 'resolved', why: 'reviewed manually anyway', at: hoursAgo(1), source: 'orchestrator-pane', by: 'operator' };
  const dir = intelWith({ rulings: [ruling], cards: [card] });
  const f = findings(dir, [card]);
  assert.deepEqual(f, []);
});
