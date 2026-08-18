'use strict';
/**
 * Two collapsed states in the steward's bookkeeping, fixed together because
 * they are the same defect measured from opposite ends of one variable.
 *
 * T-0144 — `updated_at` meant "the file was written" and was read as "the work
 * moved". Writing triage notes onto 8 stale tasks on 2026-08-16 reset their
 * measured age from 300-478h to ~0h; findings fell 13 -> 3 with zero work
 * advanced. Narration cleared the gate.
 *
 * T-0164 — `abandoned-lease` meant both "the owner died" and "the owner is
 * alive and busy and did not renew". On 2026-08-17 it went RED on T-0146 at 14h
 * while fifteen PRs were being reviewed and merged under that very task.
 *
 * The fix is two measures with two meanings, NOT one merged measure:
 *   lastTransition — has this card moved?      (idle / review / failed / blocked)
 *   lastProgress   — is the worker alive?      (running only)
 * Collapsing them again is what these tests exist to prevent.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

// Isolated empty intel dir — audit() otherwise falls back to the REAL _intel and
// live routine findings leak into these fixtures.
function emptyIntel() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-progress-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  return d;
}
const EMPTY = emptyIntel();

// ─── T-0144: annotation is not progress ────────────────────────────────────

test('editing a task without moving it keeps its FULL idle age', () => {
  // Filed 200h ago, never picked up, annotated one minute ago. It is still 200h
  // of nobody picking it up.
  const t = {
    id: 'T-ANN', repo: 'wezbridge', state: 'ready', title: 'never picked up',
    created_at: hoursAgo(200), state_changed_at: hoursAgo(200),
    updated_at: hoursAgo(0.016),
  };
  const f = steward.audit([t], NOW, EMPTY).findings;
  assert.strictEqual(f.length, 1, 'an annotation must not clear the finding');
  assert.strictEqual(f[0].category, 'idle');
  assert.strictEqual(f[0].age_hours, 200, 'age must come from the last transition');
});

test('a task reopened done -> ready starts a FRESH idle clock, not an ancient one', () => {
  // The trap in the naive fix: measuring from created_at outright would report
  // legitimately reopened work as instantly ancient — a wolf in the opposite
  // direction. The reopen IS a transition, so the clock restarts.
  const t = {
    id: 'T-REOPEN', repo: 'wezbridge', state: 'ready', title: 'reopened',
    created_at: hoursAgo(5000), state_changed_at: hoursAgo(2), updated_at: hoursAgo(2),
  };
  assert.deepStrictEqual(steward.audit([t], NOW, EMPTY).findings, [],
    'work reopened two hours ago is not stale');
});

test('a legacy task with no state_changed_at falls back to created_at, not updated_at', () => {
  // Every task already on disk predates the stamp. The fallback must not
  // reintroduce the bug for them: for a card that has sat in `ready` since it
  // was filed, created_at is the honest answer.
  const t = {
    id: 'T-LEGACY', repo: 'wezbridge', state: 'ready', title: 'legacy record',
    created_at: hoursAgo(300), updated_at: hoursAgo(1),
  };
  const f = steward.audit([t], NOW, EMPTY).findings;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].age_hours, 300);
});

// ─── T-0164: a busy owner is not a dead one ────────────────────────────────

test('an expired lease is NOT abandoned when siblings on the same corr are moving', () => {
  // The exact shape of T-0146: an umbrella task worked THROUGH its children.
  // The umbrella never transitions, so every ledger-only measure reads it as
  // dead while the programme under it is the busiest thing on the board.
  const umbrella = {
    id: 'T-0146', repo: 'whatsappbot-final', state: 'running', title: 'remediation programme',
    corr: 'wa-remediation-full', created_at: hoursAgo(40), state_changed_at: hoursAgo(14),
    lease: { owner: 'pane-12', expires_at: hoursAgo(12) },
  };
  const child = {
    id: 'T-0154', repo: 'whatsappbot-final', state: 'done', title: 'tranche',
    corr: 'wa-remediation-full', created_at: hoursAgo(30), state_changed_at: hoursAgo(1),
  };
  assert.deepStrictEqual(steward.audit([umbrella, child], NOW, EMPTY).findings, [],
    'a sibling closing an hour ago proves the owner is alive');
});

test('the SAME task with no sibling activity still goes RED', () => {
  // The other half of the planted pair. If narrowing the rule silenced the
  // category, that would be a worse defect than the false positive it fixed.
  const umbrella = {
    id: 'T-0146', repo: 'whatsappbot-final', state: 'running', title: 'remediation programme',
    corr: 'wa-remediation-full', created_at: hoursAgo(40), state_changed_at: hoursAgo(14),
    lease: { owner: 'pane-12', expires_at: hoursAgo(12) },
  };
  const deadChild = { // a sibling that ALSO went quiet — not evidence of life
    id: 'T-0154', repo: 'whatsappbot-final', state: 'done', title: 'tranche',
    corr: 'wa-remediation-full', created_at: hoursAgo(30), state_changed_at: hoursAgo(20),
  };
  const f = steward.audit([umbrella, deadChild], NOW, EMPTY).findings
    .filter((x) => x.id === 'T-0146');
  assert.strictEqual(f.length, 1, 'a genuinely dead owner must still be reported');
  assert.strictEqual(f[0].category, 'abandoned-lease');
  assert.match(f[0].why, /pane-12/, 'the report must still name who dropped it');
});

test('the finding STATES which progress channels it checked', () => {
  // Criterion from T-0164: the definition of progress evidence lives in the
  // gate output, not in the reader's head. Narrow the rule later and this
  // sentence has to change with it.
  const dead = {
    id: 'T-DEAD', repo: 'wezbridge', state: 'running', title: 'dead',
    corr: null, created_at: hoursAgo(40), state_changed_at: hoursAgo(30),
    lease: { owner: 'pane-99', expires_at: hoursAgo(20) },
  };
  const [f] = steward.audit([dead], NOW, EMPTY).findings;
  for (const channel of [/FSM transition/, /run log/, /ruling/, /sibling/]) {
    assert.match(f.why, channel, `the finding must name the ${channel} channel`);
  }
});

test('a ruling recorded against the task counts as progress', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-rulings-'));
  try {
    fs.mkdirSync(path.join(dir, 'routine-findings'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rulings.jsonl'),
      JSON.stringify({ task: 'T-RULED', category: 'abandoned-lease', ruling: 'dispatched', at: hoursAgo(1) }) + '\n');
    const t = {
      id: 'T-RULED', repo: 'wezbridge', state: 'running', title: 'ruled on an hour ago',
      created_at: hoursAgo(40), state_changed_at: hoursAgo(30),
      lease: { owner: 'pane-3', expires_at: hoursAgo(20) },
    };
    assert.deepStrictEqual(steward.audit([t], NOW, dir).findings, [],
      'someone ruled on this an hour ago — it is not forgotten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the scope limit that keeps the fix from becoming the next silent-dropper ─

test('sibling progress must NOT suppress idle — only abandonment', () => {
  // "A sibling moved" is evidence the OWNER is alive. It is NOT evidence that
  // anyone picked THIS card up. Letting the sibling channel count for `idle`
  // would hide a live programme's own untouched backlog behind its siblings'
  // progress — the shape of the board that reported "Needs Attention: 0".
  const untouched = {
    id: 'T-0166', repo: 'whatsappbot-final', state: 'queued', title: 'nobody has taken this',
    corr: 'wa-remediation-full', created_at: hoursAgo(200), state_changed_at: hoursAgo(200),
  };
  const busySibling = {
    id: 'T-0163', repo: 'whatsappbot-final', state: 'done', title: 'tranche',
    corr: 'wa-remediation-full', created_at: hoursAgo(200), state_changed_at: hoursAgo(1),
  };
  const f = steward.audit([untouched, busySibling], NOW, EMPTY).findings
    .filter((x) => x.id === 'T-0166');
  assert.strictEqual(f.length, 1, 'an unclaimed task stays visible however busy its siblings are');
  assert.strictEqual(f[0].category, 'idle');
  assert.strictEqual(f[0].age_hours, 200);
});

// ─── the ceiling: siblings DEFER the alarm, they never cancel it ───────────
// Found by independent review (pane-15) on the first version of this fix, which
// put the peer stamp straight into the Math.max. A task dead for 208 days still
// classified clean as long as its corr had any movement. Trading a false RED
// for a permanent false GREEN is strictly worse: silence is the one direction
// this gate must never fail in.

test('a task dead PAST the ceiling fires even while its corr is busy', () => {
  // pane-15's exact reproduction: dead 500h, sibling transitioned 6 minutes ago.
  const dead = {
    id: 'T-DEAD-500', repo: 'wezbridge', state: 'running', title: 'dead but well-connected',
    corr: 'busy-corr', created_at: hoursAgo(600), state_changed_at: hoursAgo(500),
  };
  const liveSibling = {
    id: 'T-ALIVE', repo: 'wezbridge', state: 'running',
    corr: 'busy-corr', created_at: hoursAgo(600), state_changed_at: hoursAgo(0.1),
  };
  const f = steward.audit([dead, liveSibling], NOW, EMPTY).findings.filter((x) => x.id === 'T-DEAD-500');
  assert.strictEqual(f.length, 1, '500h of silence must not be cancelled by a neighbour');
  assert.strictEqual(f[0].category, 'stale-running');
});

test('...and at 208 days it is certainly not clean', () => {
  // The number the reviewer used to show the suppression had no upper bound at
  // all. If this ever returns null again, the ceiling has been removed.
  const dead = {
    id: 'T-DEAD-5000', repo: 'wezbridge', state: 'running', title: 'dead for 208 days',
    corr: 'busy-corr', created_at: hoursAgo(6000), state_changed_at: hoursAgo(5000),
  };
  const liveSibling = {
    id: 'T-ALIVE', repo: 'wezbridge', state: 'running',
    corr: 'busy-corr', created_at: hoursAgo(6000), state_changed_at: hoursAgo(0.1),
  };
  const f = steward.audit([dead, liveSibling], NOW, EMPTY).findings.filter((x) => x.id === 'T-DEAD-5000');
  assert.strictEqual(f.length, 1);
});

test('BELOW the ceiling a busy corr still defers the alarm — the T-0146 case survives', () => {
  // The ceiling must not undo the fix it is bounding. An umbrella quiet for 14h
  // while its children close is the original false RED and must stay silent.
  const umbrella = {
    id: 'T-0146', repo: 'whatsappbot-final', state: 'running', title: 'umbrella',
    corr: 'wa-remediation-full', created_at: hoursAgo(40), state_changed_at: hoursAgo(14),
    lease: { owner: 'pane-12', expires_at: hoursAgo(12) },
  };
  const child = {
    id: 'T-0154', repo: 'whatsappbot-final', state: 'done',
    corr: 'wa-remediation-full', created_at: hoursAgo(30), state_changed_at: hoursAgo(1),
  };
  assert.deepStrictEqual(steward.audit([umbrella, child], NOW, EMPTY).findings, []);
});

test('the ceiling measures the task OWN life, so a live run log still suppresses past it', () => {
  // The ceiling must not resurrect the T-0008 wolf. A long oversight loop
  // reporting only to its run log is alive by its OWN evidence, not a
  // neighbour's, so 300h without an FSM transition is still not abandonment.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-ceiling-'));
  try {
    fs.mkdirSync(path.join(dir, 'routine-findings'), { recursive: true });
    const runDir = path.join(dir, 'runs', 'T-LOOP');
    fs.mkdirSync(runDir, { recursive: true });
    const log = path.join(runDir, 'log.md');
    fs.writeFileSync(log, '# pass 50\n');
    const fresh = new Date(NOW - 3600000);
    fs.utimesSync(log, fresh, fresh);

    const t = {
      id: 'T-LOOP', repo: 'whatsappbot-final', state: 'running', title: 'live loop',
      corr: null, created_at: hoursAgo(400), state_changed_at: hoursAgo(300),
    };
    assert.strictEqual(steward.classify(t, NOW, dir), null,
      'own run log beats the ceiling — the ceiling only bounds the SIBLING channel');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the two measures are not interchangeable', () => {
  // Guards the split itself. This task has ancient movement but fresh progress:
  // the two functions MUST disagree. If a later refactor merges them, one of
  // these two assertions goes red rather than the behaviour silently changing.
  // 100h of own silence: old enough that the two measures must disagree, but
  // BELOW the 168h ceiling, so the sibling channel is still in play.
  const t = {
    id: 'T-SPLIT', repo: 'wezbridge', state: 'running',
    corr: 'c-1', created_at: hoursAgo(100), state_changed_at: hoursAgo(100),
  };
  const peer = { id: 'T-PEER', state: 'done', corr: 'c-1', state_changed_at: hoursAgo(1) };
  const ctx = steward.buildContext([t, peer], EMPTY);
  assert.strictEqual(steward.lastTransition(t), Date.parse(hoursAgo(100)),
    'movement ignores the sibling entirely');
  assert.strictEqual(steward.lastProgress(t, NOW, EMPTY, ctx), Date.parse(hoursAgo(1)),
    'liveness picks up the sibling');
});
