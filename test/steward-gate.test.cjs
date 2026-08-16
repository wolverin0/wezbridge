'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gate = require('../scripts/steward-gate.cjs');

const H = 3600000;
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

const finding = (over = {}) => ({
  id: 'T-0001', repo: 'brlite', state: 'ready', title: 'a task',
  owner: null, age_hours: 100, category: 'idle', why: 'nobody has picked this up', ...over,
});

// ---------------------------------------------------------------------------
// The gate exists to CONTRADICT "nothing needs you". These prove it can.
// ---------------------------------------------------------------------------

test('RED: a past-deadline finding with no ruling', () => {
  const r = gate.evaluate({ findings: [finding()], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'RED', 'an idle task at 100h with no ruling must fail the gate');
  assert.strictEqual(r.unruled[0].id, 'T-0001');
});

test('GREEN: a finding that has not reached its deadline yet', () => {
  const r = gate.evaluate({ findings: [finding({ age_hours: 12 })], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'GREEN', 'idle for 12h is not yet owed a ruling');
});

test('GREEN: cancelled is permanent', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'cancelled', why: 'dead project', at: iso(-500 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'a cancelled task must never be raised again');
});

test('GREEN: operator-gated is permanent', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'operator-gated', at: iso(-999 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'waiting on the operator IS the correct state');
});

// ---------------------------------------------------------------------------
// THE ANTI-WOLF PROPERTY — the veto condition for shipping this at all.
// An artifact that fires on compliant behaviour is worse than none.
// ---------------------------------------------------------------------------

test('ANTI-WOLF: a deferred task stays green across many ticks and ages', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', why: 'parked', until: iso(240 * H), at: iso(0) }];
  for (let tick = 0; tick < 25; tick += 1) {
    const now = NOW + tick * 4 * H;              // a tick every 4h for ~4 days
    const r = gate.evaluate({ findings: [finding({ age_hours: 100 + tick * 4 })], rulings, now });
    assert.strictEqual(r.verdict, 'GREEN', `tick ${tick}: a correctly parked task must not fire`);
  }
});

test('a deferral RE-RAISES once its until passes', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(10 * H), at: iso(0) }];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 9 * H }).verdict, 'GREEN');
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 11 * H }).verdict, 'RED',
    'a deferral is a pause, not an erasure');
});

test('a deferral with NO until is not a ruling — a shrug must not silence anything', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'deferred', why: 'later', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
});

// ---------------------------------------------------------------------------
// Situation changes must re-open the judgement.
// ---------------------------------------------------------------------------

test('a ruling does NOT carry over when the category changes', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(500 * H), at: iso(0) }];
  const r = gate.evaluate({ findings: [finding({ category: 'abandoned-lease', age_hours: 30 })], rulings, now: NOW });
  assert.strictEqual(r.verdict, 'RED', 'parked-while-idle must not silence a crashed lease');
});

test('dispatched expires after the grace window so a swallowed dispatch resurfaces', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'dispatched', at: iso(0) }];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 5 * H }).verdict, 'GREEN');
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 30 * H }).verdict, 'RED',
    'if a dispatch never moved the task, the gate must ask again');
});

test('the LATEST ruling wins, so a decision can be revised by appending', () => {
  const rulings = [
    { task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(1 * H), at: iso(-10 * H) },
    { task: 'T-0001', category: 'idle', ruling: 'cancelled', at: iso(-1 * H) },
  ];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 50 * H }).verdict, 'GREEN');
});

test('awaiting-operator is never gated — it is the correct resting state', () => {
  const r = gate.evaluate({ findings: [finding({ category: 'awaiting-operator', age_hours: 9999 })], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'GREEN');
});

test('an unknown ruling word covers nothing', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'noted', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED', '"noted" is narration, and narration is what this gate exists to defeat');
});

test('a ruling for a DIFFERENT task does not cover this one', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-9999', category: 'idle', ruling: 'cancelled', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
});

test('mixed board: one ruled, one not — RED, and it names the unruled one', () => {
  const r = gate.evaluate({
    findings: [finding({ id: 'T-A' }), finding({ id: 'T-B' })],
    rulings: [{ task: 'T-A', category: 'idle', ruling: 'cancelled', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
  assert.strictEqual(r.unruled.length, 1);
  assert.strictEqual(r.unruled[0].id, 'T-B');
});

// ---------------------------------------------------------------------------
// The gate must not go blind when the operator owes something
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');
const gatePath = require('node:path').join(__dirname, '..', 'scripts', 'steward-gate.cjs');

function runGate(args, intelDir) {
  try {
    const stdout = execFileSync(process.execPath, [gatePath, ...args],
      { encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intelDir } });
    return { code: 0, stdout };
  } catch (e) { return { code: e.status, stdout: String(e.stdout || '') }; }
}

test('a steward that exits NON-ZERO still yields a usable report', () => {
  // MUST exercise the SPAWNED steward, not --from. The first version of this
  // test used --from, which never reaches execFileSync at all, so removing the
  // whole fix left it green: a test passing for the wrong reason, again.
  // Here the REAL steward runs against a real ledger containing an
  // operator-gated blocked task, which makes it genuinely exit 1.
  const os = require('node:os'); const fsx = require('node:fs'); const p = require('node:path');
  const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'gate-spawn-'));
  fsx.mkdirSync(p.join(dir, 'tasks'));
  const old = new Date(Date.now() - 400 * 3600000).toISOString();
  // makes the steward exit 1
  fsx.writeFileSync(p.join(dir, 'tasks', 'T-GATE.json'), JSON.stringify({
    id: 'T-GATE', repo: 'r', state: 'blocked', gate: 'operator',
    blocker: 'operator owes an answer', updated_at: old, title: 'gated',
  }));
  // and an unruled idle task, so a gate that really evaluated must say RED
  fsx.writeFileSync(p.join(dir, 'tasks', 'T-IDLE.json'), JSON.stringify({
    id: 'T-IDLE', repo: 'r', state: 'ready', updated_at: old, title: 'idle',
  }));
  fsx.writeFileSync(p.join(dir, 'rulings.jsonl'), '');

  const res = runGate([], dir);
  assert.notStrictEqual(res.code, 3, 'UNKNOWN here means the gate went blind because the steward exited 1');
  assert.strictEqual(res.code, 1, 'it must reach the RED verdict the findings warrant');
  assert.match(res.stdout, /T-IDLE/);
});

test('a report supplied via --from is validated the same way', () => {
  // fleet-steward exits 1 on purpose when the operator personally owes
  // something, and execFileSync throws on any non-zero exit. That made the gate
  // report UNKNOWN precisely when an operator decision was pending — blind in
  // the one situation it exists to surface. Found 2026-08-14. A report is valid
  // because it PARSES, not because the exit code was 0.
  const os = require('node:os'); const fsx = require('node:fs'); const p = require('node:path');
  const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'gate-exit-'));
  const findings = p.join(dir, 'findings.json');
  fsx.writeFileSync(findings, JSON.stringify({
    findings: [{ id: 'T-X', repo: 'r', category: 'idle', age_hours: 999, title: 't' }],
  }));
  fsx.writeFileSync(p.join(dir, 'rulings.jsonl'), '');
  const res = runGate(['--from', findings], dir);
  assert.strictEqual(res.code, 1, 'must reach a RED verdict, not UNKNOWN(3)');
  assert.match(res.stdout, /RED/);
});

test('genuinely unreadable input is still UNKNOWN, never a verdict', () => {
  // The fix above must not have turned "cannot see" into "nothing found".
  const os = require('node:os'); const fsx = require('node:fs'); const p = require('node:path');
  const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'gate-unk-'));
  assert.strictEqual(runGate(['--from', p.join(dir, 'missing.json')], dir).code, 3, 'missing file');
  const bad = p.join(dir, 'bad.json');
  fsx.writeFileSync(bad, '{not json');
  assert.strictEqual(runGate(['--from', bad], dir).code, 3, 'unparseable');
  const wrong = p.join(dir, 'wrong.json');
  fsx.writeFileSync(wrong, '{"findings":"not an array"}');
  assert.strictEqual(runGate(['--from', wrong], dir).code, 3, 'right JSON, wrong shape');
});

test('`resolved` permanently covers a finding, and an unknown word never does', () => {
  // Added 2026-08-14 after the first autonomous turn reported that the enum had
  // no word for "harvested and closed" and had to log three closures as
  // `dispatched`. `cancelled` would have been just as wrong in the other
  // direction: it says the work is dead, not finished.
  const f = { id: 'T-1', category: 'stale-review', age_hours: 999 };
  const now = Date.parse('2026-08-14T12:00:00Z');
  const at = '2026-01-01T00:00:00Z';          // ancient on purpose: permanence is the point
  assert.strictEqual(gate.rulingCovers({ task: 'T-1', category: 'stale-review', ruling: 'resolved', at }, f, now), true);
  // and it must not silently cover a DIFFERENT category — closing a review says
  // nothing about the same task later going stale-failed
  assert.strictEqual(gate.rulingCovers({ task: 'T-1', category: 'idle', ruling: 'resolved', at }, f, now), false);
  // the enum stays closed: a plausible-looking word is not a ruling
  for (const word of ['closed', 'done', 'harvested', 'complete', '', null]) {
    assert.strictEqual(gate.rulingCovers({ task: 'T-1', category: 'stale-review', ruling: word, at }, f, now), false,
      `"${word}" was accepted as a ruling`);
  }
});
