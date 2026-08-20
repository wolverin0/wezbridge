'use strict';
/**
 * board-fresh-gate.test.cjs — the freshness gate (slice 4).
 *
 * The gate answers "¿está actualizado?" so the operator stops asking it: work
 * evidence (a commit, a corroborated deploy marker) older than freshHours with
 * open tasks in that repo that nobody touched since is RED. No evidence is
 * GREEN — nothing happening is compliant. Unreadable inputs are UNKNOWN (3),
 * never green. Pure evaluate() core + CLI exit codes, both under test.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { evaluate, evaluateIntel, FRESH_HOURS } = require('../scripts/board-fresh-gate.cjs');

const GATE = path.join(__dirname, '..', 'scripts', 'board-fresh-gate.cjs');
const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

const SHA = 'abc123def456abc123def456abc123def456abcd';

function headMoved(repo, atHoursAgo, sha = SHA) {
  return { time: hoursAgo(atHoursAgo), repo, session: 's1', event: 'turn-end', markers: [], head: sha, head_prev: 'e'.repeat(40), head_moved: true };
}

function openTask(id, repo, updatedHoursAgo, extra = {}) {
  return { id, repo, title: `t ${id}`, state: 'ready', updated_at: hoursAgo(updatedHoursAgo), ...extra };
}

// --- pure core: the RED condition -------------------------------------------

test('head_moved 6h ago + open task untouched since = RED naming repo and sha', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'RED');
  assert.strictEqual(out.stale.length, 1);
  assert.strictEqual(out.stale[0].repo, 'wezbridge');
  assert.strictEqual(out.stale[0].sha, SHA, 'RED must carry the sha — "which work" is the whole point');
  assert.deepStrictEqual(out.stale[0].open_tasks, ['T-1']);
});

test('a task.* ledger event for the repo AFTER the evidence clears it — GREEN', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [{ time: hoursAgo(1), event: 'task.updated', task_id: 'T-1', state: 'review' }],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN', 'touching the ledger is exactly the behaviour this gate trains');
});

test('a ledger event BEFORE the evidence does not clear it — still RED', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [{ time: hoursAgo(8), event: 'task.updated', task_id: 'T-1' }],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'RED');
});

test('a ledger event for ANOTHER repo does not clear it — still RED', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [openTask('T-1', 'wezbridge', 10), openTask('T-2', 'otherrepo', 10)],
    ledgerEvents: [{ time: hoursAgo(1), event: 'task.created', task_id: 'T-2', repo: 'otherrepo' }],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'RED');
});

test('task updated_at at or after the evidence time = GREEN', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [openTask('T-1', 'wezbridge', 2)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN');
});

test('state_changed_at counts as a touch even when updated_at is stale', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [openTask('T-1', 'wezbridge', 10, { state_changed_at: hoursAgo(2) })],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN');
});

test('evidence younger than freshHours is grace, not RED', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 2)],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN', `inside the ${FRESH_HOURS}h window the update may still be coming`);
});

test('a NEWER commit restarts the clock for the repo (latest evidence wins)', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 8), headMoved('wezbridge', 1, 'f'.repeat(40))],
    tasks: [openTask('T-1', 'wezbridge', 20)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN');
});

test('no open tasks in the repo = GREEN (nothing to update)', () => {
  const out = evaluate({
    paneEvents: [headMoved('wezbridge', 6)],
    tasks: [{ id: 'T-1', repo: 'wezbridge', state: 'done', updated_at: hoursAgo(30) }],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN');
});

test('no evidence at all = GREEN — nothing happened is compliant', () => {
  const out = evaluate({ paneEvents: [], tasks: [openTask('T-1', 'wezbridge', 100)], ledgerEvents: [], now: NOW });
  assert.strictEqual(out.verdict, 'GREEN');
});

// --- what counts as evidence -------------------------------------------------

test('a clean deploy-class marker IS evidence (sha null) — RED', () => {
  const out = evaluate({
    paneEvents: [{ time: hoursAgo(6), repo: 'wezbridge', event: 'turn-end', markers: ['MERGED'] }],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'RED');
  assert.strictEqual(out.stale[0].sha, null);
});

test('a PROSE-ONLY deploy marker is NOT evidence — GREEN', () => {
  const out = evaluate({
    paneEvents: [{ time: hoursAgo(6), repo: 'wezbridge', event: 'turn-end', markers: ['DEPLOYED'], markers_prose_only: true }],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN', 'talking about a deploy is not a deploy — a noisy gate is how the last 6 died');
});

test('a VCS-UNCORROBORATED deploy marker is NOT evidence — GREEN', () => {
  const out = evaluate({
    paneEvents: [{ time: hoursAgo(6), repo: 'wezbridge', event: 'turn-end', markers: ['PUSHED'], markers_unsupported_by_vcs: true }],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN');
});

test('non-deploy markers (FAILED, criteria:) are NOT evidence — GREEN', () => {
  const out = evaluate({
    paneEvents: [{ time: hoursAgo(6), repo: 'wezbridge', event: 'turn-end', markers: ['FAILED', 'CRITERIA:'] }],
    tasks: [openTask('T-1', 'wezbridge', 10)],
    ledgerEvents: [],
    now: NOW,
  });
  assert.strictEqual(out.verdict, 'GREEN');
});

// --- evaluateIntel: unreadable inputs are UNKNOWN, never green ---------------

test('evaluateIntel: missing pane-events.jsonl is UNKNOWN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-intel-'));
  const out = evaluateIntel({ intelDir: dir, tasks: [], now: NOW });
  assert.strictEqual(out.verdict, 'UNKNOWN');
});

test('evaluateIntel: absent events.jsonl is zero ledger events, not UNKNOWN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-intel-'));
  fs.writeFileSync(path.join(dir, 'pane-events.jsonl'),
    JSON.stringify(headMoved('wezbridge', 6)) + '\n');
  const out = evaluateIntel({ intelDir: dir, tasks: [openTask('T-1', 'wezbridge', 10)], now: NOW });
  assert.strictEqual(out.verdict, 'RED', 'no ledger file can only make it redder, never falsely green');
});

// --- CLI exit codes (the 09:05 chain consumes these) -------------------------

function mkIntel({ paneLines, taskList, eventLines }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-cli-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  if (paneLines) fs.writeFileSync(path.join(dir, 'pane-events.jsonl'), paneLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (eventLines) fs.writeFileSync(path.join(dir, 'events.jsonl'), eventLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const t of taskList || []) fs.writeFileSync(path.join(dir, 'tasks', `${t.id}.json`), JSON.stringify(t));
  return dir;
}

function runGate(intel) {
  return spawnSync(process.execPath, [GATE], {
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel },
    encoding: 'utf8', timeout: 30000,
  });
}

test('CLI: stale evidence + untouched open task exits 1 and prints repo + sha', () => {
  // Real wall-clock fixture: the CLI uses Date.now().
  const intel = mkIntel({
    paneLines: [{ ...headMoved('wezbridge', 0), time: new Date(Date.now() - 6 * 3600000).toISOString() }],
    taskList: [{ id: 'T-1', repo: 'wezbridge', title: 'x', state: 'ready', updated_at: new Date(Date.now() - 10 * 3600000).toISOString() }],
  });
  const res = runGate(intel);
  assert.strictEqual(res.status, 1, `expected RED, got ${res.status}: ${res.stdout} ${res.stderr}`);
  assert.match(res.stdout, /RED/);
  assert.match(res.stdout, /wezbridge/);
  assert.ok(res.stdout.includes(SHA.slice(0, 12)), 'RED output names the sha');
});

test('CLI: appending the task.updated ledger event flips it to 0', () => {
  const intel = mkIntel({
    paneLines: [{ ...headMoved('wezbridge', 0), time: new Date(Date.now() - 6 * 3600000).toISOString() }],
    taskList: [{ id: 'T-1', repo: 'wezbridge', title: 'x', state: 'ready', updated_at: new Date(Date.now() - 10 * 3600000).toISOString() }],
    eventLines: [{ time: new Date(Date.now() - 3600000).toISOString(), event: 'task.updated', task_id: 'T-1', state: 'review' }],
  });
  const res = runGate(intel);
  assert.strictEqual(res.status, 0, `expected GREEN, got ${res.status}: ${res.stdout} ${res.stderr}`);
  assert.match(res.stdout, /GREEN/);
});

test('CLI: prose-only DEPLOYED marker alone stays 0', () => {
  const intel = mkIntel({
    paneLines: [{ time: new Date(Date.now() - 6 * 3600000).toISOString(), repo: 'wezbridge', event: 'turn-end', markers: ['DEPLOYED'], markers_prose_only: true }],
    taskList: [{ id: 'T-1', repo: 'wezbridge', title: 'x', state: 'ready', updated_at: new Date(Date.now() - 10 * 3600000).toISOString() }],
  });
  const res = runGate(intel);
  assert.strictEqual(res.status, 0, `expected GREEN, got ${res.status}: ${res.stdout} ${res.stderr}`);
});

test('CLI: unreadable pane-events.jsonl exits 3 — a blind gate is not a clean one', () => {
  const intel = mkIntel({ taskList: [] });
  const res = runGate(intel);
  assert.strictEqual(res.status, 3, `expected UNKNOWN, got ${res.status}: ${res.stdout} ${res.stderr}`);
  assert.match(res.stdout, /UNKNOWN/);
});
