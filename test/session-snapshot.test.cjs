'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snap = require(path.resolve(__dirname, '..', 'src', 'session-snapshot.cjs'));
const {
  classifyAI,
  captureProcessCmdline,
  buildSnapshotEntry,
  appendSnapshot,
  readAllSnapshots,
  readLatestSnapshot,
  DEFAULT_LOG,
} = snap;

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snap-'));
  return path.join(dir, 'snapshot.jsonl');
}

// classifyAI ----------------------------------------------------------

test('classifyAI: detects claude.exe in cmdline', () => {
  assert.equal(classifyAI('C:\\path\\claude.exe --continue', ''), 'claude');
});

test('classifyAI: detects codex.exe', () => {
  assert.equal(classifyAI('codex.exe --some-flag', ''), 'codex');
});

test('classifyAI: detects bare "claude" in cmdline', () => {
  assert.equal(classifyAI('claude --channels foo', ''), 'claude');
});

test('classifyAI: detects via title fallback', () => {
  assert.equal(classifyAI('', 'claude.exe'), 'claude');
});

test('classifyAI: returns null for non-AI processes', () => {
  assert.equal(classifyAI('bash.exe', ''), null);
  assert.equal(classifyAI('node /some/script.js', ''), null);
  assert.equal(classifyAI('git push', ''), null);
});

test('classifyAI: handles null/empty inputs', () => {
  assert.equal(classifyAI(null, null), null);
  assert.equal(classifyAI('', ''), null);
});

test('classifyAI: word-boundary safe (does not match "myclauder")', () => {
  assert.equal(classifyAI('myclauder.exe --foo', ''), null);
});

// captureProcessCmdline ----------------------------------------------

test('captureProcessCmdline: returns null for missing pid', () => {
  assert.equal(captureProcessCmdline(null), null);
  assert.equal(captureProcessCmdline(undefined), null);
  assert.equal(captureProcessCmdline('not-a-number'), null);
});

test('captureProcessCmdline: returns null when exec throws', () => {
  const fakeExec = () => { throw new Error('process gone'); };
  assert.equal(captureProcessCmdline(99999, { exec: fakeExec }), null);
});

test('captureProcessCmdline: returns trimmed output when exec succeeds', () => {
  const fakeExec = () => 'claude --continue\n';
  const out = captureProcessCmdline(123, { exec: fakeExec });
  assert.equal(out, 'claude --continue');
});

test('captureProcessCmdline: returns null on empty output', () => {
  const fakeExec = () => '   \n';
  assert.equal(captureProcessCmdline(123, { exec: fakeExec }), null);
});

// buildSnapshotEntry --------------------------------------------------

test('buildSnapshotEntry: returns entry for AI pane', () => {
  const pane = {
    pane_id: 5,
    tab_id: 2,
    window_id: 1,
    cwd: '/repo/x',
    pid: 12345,
    title: 'claude.exe',
    tab_title: '[reviewer] x',
  };
  const entry = buildSnapshotEntry(pane, 'claude --continue --channels plugin:foo', '2026-05-08T00:00:00.000Z');
  assert.equal(entry.pane_id, 5);
  assert.equal(entry.cwd, '/repo/x');
  assert.equal(entry.pid, 12345);
  assert.equal(entry.cmdline, 'claude --continue --channels plugin:foo');
  assert.equal(entry.ai, 'claude');
  assert.equal(entry.snapshot_ts, '2026-05-08T00:00:00.000Z');
});

test('buildSnapshotEntry: returns null for non-AI pane', () => {
  const pane = { pane_id: 1, cwd: '/x', pid: 1, title: 'bash.exe', tab_title: '' };
  assert.equal(buildSnapshotEntry(pane, 'bash', '2026-05-08T00:00:00.000Z'), null);
});

test('buildSnapshotEntry: returns null for missing pane', () => {
  assert.equal(buildSnapshotEntry(null, 'claude', '2026-05-08T00:00:00.000Z'), null);
  assert.equal(buildSnapshotEntry({}, 'claude', '2026-05-08T00:00:00.000Z'), null);
});

test('buildSnapshotEntry: classifies via title when cmdline is null', () => {
  const pane = { pane_id: 3, cwd: '/y', pid: 2, title: 'codex.exe', tab_title: '' };
  const entry = buildSnapshotEntry(pane, null, '2026-05-08T00:00:00.000Z');
  assert.equal(entry.ai, 'codex');
});

test('buildSnapshotEntry: defaults snapshot_ts when not given', () => {
  const pane = { pane_id: 7, pid: 1, title: 'claude.exe' };
  const entry = buildSnapshotEntry(pane, 'claude');
  assert.match(entry.snapshot_ts, /^\d{4}-\d{2}-\d{2}T/);
});

// appendSnapshot + readAllSnapshots + readLatestSnapshot --------------

test('appendSnapshot: writes JSONL entries', () => {
  const logPath = tmpLog();
  const ts = '2026-05-08T01:00:00.000Z';
  const entries = [
    { snapshot_ts: ts, pane_id: 1, ai: 'claude', cmdline: 'claude --continue' },
    { snapshot_ts: ts, pane_id: 2, ai: 'codex', cmdline: 'codex' },
  ];
  assert.equal(appendSnapshot(entries, { logPath }), true);
  const all = readAllSnapshots({ logPath });
  assert.equal(all.length, 2);
});

test('appendSnapshot: returns false on empty input', () => {
  const logPath = tmpLog();
  assert.equal(appendSnapshot([], { logPath }), false);
  assert.equal(appendSnapshot(null, { logPath }), false);
});

test('readLatestSnapshot: returns only the most recent batch', () => {
  const logPath = tmpLog();
  appendSnapshot([
    { snapshot_ts: '2026-05-08T01:00:00.000Z', pane_id: 1, ai: 'claude' },
    { snapshot_ts: '2026-05-08T01:00:00.000Z', pane_id: 2, ai: 'codex' },
  ], { logPath });
  appendSnapshot([
    { snapshot_ts: '2026-05-08T02:00:00.000Z', pane_id: 1, ai: 'claude' },
    { snapshot_ts: '2026-05-08T02:00:00.000Z', pane_id: 3, ai: 'codex' },
  ], { logPath });
  const latest = readLatestSnapshot({ logPath });
  assert.equal(latest.length, 2);
  assert.ok(latest.every((e) => e.snapshot_ts === '2026-05-08T02:00:00.000Z'));
  const paneIds = latest.map((e) => e.pane_id).sort();
  assert.deepEqual(paneIds, [1, 3]);
});

test('readLatestSnapshot: empty when log absent', () => {
  assert.deepEqual(readLatestSnapshot({ logPath: '/no/such/file.jsonl' }), []);
});

test('readAllSnapshots: skips malformed lines', () => {
  const logPath = tmpLog();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, [
    JSON.stringify({ snapshot_ts: 't1', pane_id: 1 }),
    'this is not json',
    JSON.stringify({ snapshot_ts: 't2', pane_id: 2 }),
  ].join('\n') + '\n', 'utf8');
  const all = readAllSnapshots({ logPath });
  assert.equal(all.length, 2);
});

// snapshotOnce --------------------------------------------------------

test('snapshotOnce: writes only AI panes from listPanes() output', () => {
  const logPath = tmpLog();
  const panes = [
    { pane_id: 1, pid: 100, title: 'claude.exe', tab_title: '', cwd: '/a' },
    { pane_id: 2, pid: 101, title: 'bash.exe', tab_title: '', cwd: '/b' },
    { pane_id: 3, pid: 102, title: 'codex.exe', tab_title: '', cwd: '/c' },
  ];
  const fakeCapture = (pid) => ({ 100: 'claude --continue', 101: 'bash', 102: 'codex' })[pid] || null;
  const written = snap.snapshotOnce({ listPanes: () => panes, capture: fakeCapture, logPath });
  assert.equal(written, 2);
  const all = snap.readAllSnapshots({ logPath });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.pane_id).sort(), [1, 3]);
});

test('snapshotOnce: writes nothing when no AI panes', () => {
  const logPath = tmpLog();
  const panes = [{ pane_id: 1, pid: 100, title: 'bash.exe', tab_title: '', cwd: '/a' }];
  const written = snap.snapshotOnce({
    listPanes: () => panes,
    capture: () => 'bash',
    logPath,
  });
  assert.equal(written, 0);
});

test('snapshotOnce: empty pane list → 0 written', () => {
  const logPath = tmpLog();
  assert.equal(snap.snapshotOnce({ listPanes: () => [], logPath }), 0);
});

// constants -----------------------------------------------------------

test('DEFAULT_LOG ends in vault/_wezbridge/session-snapshot.jsonl', () => {
  assert.match(DEFAULT_LOG.replace(/\\/g, '/'), /vault\/_wezbridge\/session-snapshot\.jsonl$/);
});
