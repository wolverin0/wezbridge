'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseArgs, splitCmdline } = require(path.resolve(__dirname, '..', 'scripts', 'restore-session.cjs'));

// parseArgs ----------------------------------------------------------

test('parseArgs: defaults', () => {
  const o = parseArgs([]);
  assert.equal(o.dryRun, false);
  assert.equal(o.staggerMs, 2000);
  assert.equal(o.filter, null);
});

test('parseArgs: --dry-run', () => {
  const o = parseArgs(['--dry-run']);
  assert.equal(o.dryRun, true);
});

test('parseArgs: --stagger-ms', () => {
  const o = parseArgs(['--stagger-ms', '500']);
  assert.equal(o.staggerMs, 500);
});

test('parseArgs: --filter compiles to regex', () => {
  const o = parseArgs(['--filter', 'wezbridge|memorymaster']);
  assert.ok(o.filter instanceof RegExp);
  assert.ok(o.filter.test('/path/to/wezbridge'));
  assert.ok(o.filter.test('/path/memorymaster/x'));
  assert.equal(o.filter.test('/other/path'), false);
});

test('parseArgs: invalid stagger falls back to default', () => {
  const o = parseArgs(['--stagger-ms', 'abc']);
  assert.equal(o.staggerMs, 2000);
});

// splitCmdline -------------------------------------------------------

test('splitCmdline: simple space-separated', () => {
  assert.deepEqual(splitCmdline('claude --continue'), ['claude', '--continue']);
});

test('splitCmdline: handles double-quoted args', () => {
  assert.deepEqual(splitCmdline('claude --foo "hello world"'), ['claude', '--foo', 'hello world']);
});

test('splitCmdline: handles single-quoted args', () => {
  assert.deepEqual(splitCmdline("claude --foo 'a b c'"), ['claude', '--foo', 'a b c']);
});

test('splitCmdline: collapses runs of spaces', () => {
  assert.deepEqual(splitCmdline('claude   --a   --b'), ['claude', '--a', '--b']);
});

test('splitCmdline: empty input returns []', () => {
  assert.deepEqual(splitCmdline(''), []);
  assert.deepEqual(splitCmdline(null), []);
});

test('splitCmdline: realistic claude --channels invocation', () => {
  const cmd = 'C:\\path\\claude.exe --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions --continue';
  assert.deepEqual(splitCmdline(cmd), [
    'C:\\path\\claude.exe',
    '--channels',
    'plugin:telegram@claude-plugins-official',
    '--dangerously-skip-permissions',
    '--continue',
  ]);
});

// applyTabTitle ------------------------------------------------------

const { applyTabTitle, spawnPane } = require(path.resolve(__dirname, '..', 'scripts', 'restore-session.cjs'));

test('applyTabTitle: ignores missing paneId or title', () => {
  assert.equal(applyTabTitle(null, 'test'), false);
  assert.equal(applyTabTitle(1, ''), false);
  assert.equal(applyTabTitle(null, null), false);
});

test('applyTabTitle: handles dry-run without spawning', () => {
  assert.equal(applyTabTitle(12, 'network-audit', { dryRun: true }), true);
});

test('spawnPane: dry-run respects tab_title and ai', () => {
  const entry = {
    pane_id: 13,
    cwd: 'G:/_OneDrive/OneDrive/Desktop/Py Apps/whatsappbot-main-wt',
    tab_title: 'network-audit',
    ai: 'claude',
  };
  assert.equal(spawnPane(entry, { dryRun: true }), true);
});

