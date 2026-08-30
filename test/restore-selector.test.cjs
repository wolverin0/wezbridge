'use strict';

/**
 * restore-selector.test.cjs — T-0234: the restore selector must survive the
 * exact 2026-08-24 crash shape: an 8-pane group at T-12min (the fleet) followed
 * by a 1-pane post-crash group (the pane the operator already revived).
 * `readLatestSnapshot` picked the trivial group and spawned a `--continue`
 * duplicate of the LIVE session — twice (panes 6 and 8, mm-99c4).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snap = require('../src/session-snapshot.cjs');
const { excludeAlreadyLive, normalizeSnapshotCwd } = require('../scripts/restore-session.cjs');

const NOW = Date.parse('2026-08-24T22:12:30Z');
const RICH_TS = '2026-08-24T21:59:34.875Z'; // 12 min before "now"
const TRIVIAL_TS = '2026-08-24T22:11:08.531Z'; // post-crash single pane

function entry(ts, paneId, ai, proj) {
  return {
    snapshot_ts: ts, pane_id: paneId, tab_id: null, window_id: null,
    cwd: `file:///G:/Py%20Apps/${proj}/`, pid: null, title: proj, tab_title: proj, cmdline: null, ai,
  };
}

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-fix-'));
  const logPath = path.join(dir, 'session-snapshot.jsonl');
  const lines = [
    entry(RICH_TS, 0, 'claude', 'wezbridge'),
    entry(RICH_TS, 14, 'claude', 'infra'),
    entry(RICH_TS, 15, 'claude', 'yolo26'),
    entry(RICH_TS, 38, 'codex', 'mutual'),
    entry(TRIVIAL_TS, 1, 'claude', 'wezbridge'), // the operator's revived pane
  ];
  fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return logPath;
}

test('T-0234: the RICHEST recent group wins over a newer trivial post-crash group', () => {
  const logPath = writeFixture();
  const picked = snap.readRichestRecentSnapshot({ logPath, now: NOW });
  assert.strictEqual(picked.length, 4, 'the 4-pane fleet group, not the 1-pane revival');
  assert.strictEqual(picked[0].snapshot_ts, RICH_TS);
});

test('T-0234: latest-group behavior is preserved when the latest IS the richest', () => {
  const logPath = writeFixture();
  fs.appendFileSync(logPath, [
    entry('2026-08-24T22:12:00.000Z', 2, 'claude', 'wezbridge'),
    entry('2026-08-24T22:12:00.000Z', 3, 'claude', 'infra'),
    entry('2026-08-24T22:12:00.000Z', 4, 'claude', 'yolo26'),
    entry('2026-08-24T22:12:00.000Z', 5, 'codex', 'mutual'),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const picked = snap.readRichestRecentSnapshot({ logPath, now: NOW });
  assert.strictEqual(picked[0].snapshot_ts, '2026-08-24T22:12:00.000Z', 'equal richness -> newest wins');
});

test('T-0234: groups outside the window do not resurrect ancient fleets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-old-'));
  const logPath = path.join(dir, 'session-snapshot.jsonl');
  const OLD = '2026-08-24T10:00:00.000Z'; // 12h before now — history, not state
  fs.writeFileSync(logPath, [
    entry(OLD, 0, 'claude', 'wezbridge'),
    entry(OLD, 1, 'claude', 'infra'),
    entry(TRIVIAL_TS, 9, 'claude', 'yolo26'),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const picked = snap.readRichestRecentSnapshot({ logPath, now: NOW });
  assert.strictEqual(picked.length, 1, 'only the in-window group is eligible');
  assert.strictEqual(picked[0].snapshot_ts, TRIVIAL_TS);
});

test('T-0234: a cwd whose agent is ALREADY LIVE is skipped — the duplicate --continue class', () => {
  const entries = [
    entry(RICH_TS, 0, 'claude', 'wezbridge'),
    entry(RICH_TS, 14, 'claude', 'infra'),
    entry(RICH_TS, 38, 'codex', 'mutual'),
  ];
  const live = [{ cwd: 'file:///G:/Py%20Apps/wezbridge/', agent: 'claude' }];
  const { keep, skipped } = excludeAlreadyLive(entries, live);
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].pane_id, 0, 'the live orchestrator must NOT be duplicated');
  assert.deepStrictEqual(keep.map((e) => e.pane_id), [14, 38]);
});

test('T-0234: same cwd but DIFFERENT agent is not a duplicate (claude live, codex snapshotted)', () => {
  const entries = [entry(RICH_TS, 38, 'codex', 'mutual')];
  const live = [{ cwd: 'file:///G:/Py%20Apps/mutual/', agent: 'claude' }];
  const { keep, skipped } = excludeAlreadyLive(entries, live);
  assert.strictEqual(skipped.length, 0, 'a codex session next to a claude session is legitimate');
  assert.strictEqual(keep.length, 1);
});

test('Windows snapshot file URLs become native drive paths before pane spawn', () => {
  const cwd = normalizeSnapshotCwd('file:///G:/Py%20Apps/project-costa/');
  if (process.platform === 'win32') assert.equal(cwd, 'G:\\Py Apps\\project-costa\\');
  else assert.equal(cwd, '/G:/Py Apps/project-costa/');
});

test('T-0234: empty census (mux down) excludes nothing — restore proceeds visibly', () => {
  const entries = [entry(RICH_TS, 0, 'claude', 'wezbridge')];
  const { keep, skipped } = excludeAlreadyLive(entries, []);
  assert.strictEqual(keep.length, 1);
  assert.strictEqual(skipped.length, 0);
});
