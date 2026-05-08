'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sidecar = require(path.resolve(__dirname, '..', 'src', 'sidecar-spawn.cjs'));
const { buildSidecarPrompt, recordSidecar, DEFAULT_WATCH_INTERVAL_MIN } = sidecar;

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sidecar-'));
  return path.join(dir, 'teams.jsonl');
}

// buildSidecarPrompt -----------------------------------------------------

test('buildSidecarPrompt: minimum args produces valid prompt', () => {
  const p = buildSidecarPrompt({ coderPaneId: 12 });
  assert.match(p, /SIDECAR PANE BOOTSTRAP/);
  assert.match(p, /coder pane 12/);
  assert.match(p, /Every 2 minutes/);
  assert.match(p, /Begin your first watch tick now/);
});

test('buildSidecarPrompt: includes task description when provided', () => {
  const p = buildSidecarPrompt({ coderPaneId: 12, taskDesc: 'Fix Wave-7 tests' });
  assert.match(p, /TASK DESCRIPTION/);
  assert.match(p, /Fix Wave-7 tests/);
});

test('buildSidecarPrompt: includes rubric path when provided', () => {
  const p = buildSidecarPrompt({ coderPaneId: 12, rubricPath: 'docs/rubric.md' });
  assert.match(p, /RUBRIC PATH: docs\/rubric\.md/);
});

test('buildSidecarPrompt: includes project cwd when provided', () => {
  const p = buildSidecarPrompt({ coderPaneId: 12, projectCwd: '/repo/x' });
  assert.match(p, /Project cwd: \/repo\/x/);
});

test('buildSidecarPrompt: respects custom watch interval', () => {
  const p = buildSidecarPrompt({ coderPaneId: 12, watchIntervalMin: 5 });
  assert.match(p, /Every 5 minutes/);
});

test('buildSidecarPrompt: throws when coderPaneId missing', () => {
  assert.throws(() => buildSidecarPrompt({}), /coderPaneId required/);
  assert.throws(() => buildSidecarPrompt({ coderPaneId: null }), /coderPaneId required/);
});

test('buildSidecarPrompt: enforces "do not modify files" instruction', () => {
  const p = buildSidecarPrompt({ coderPaneId: 12 });
  assert.match(p, /Do NOT modify files/);
});

// recordSidecar ----------------------------------------------------------

test('recordSidecar: writes to teams.jsonl with persona=sidecar', () => {
  const logPath = tmpLog();
  const ok = recordSidecar({
    paneId: 33, coderPaneId: 12, baseCwd: '/repo', worktreePath: '/repo/.wt/sidecar-12',
  }, { logPath });
  assert.equal(ok, true);
  const raw = fs.readFileSync(logPath, 'utf8');
  const event = JSON.parse(raw.trim());
  assert.equal(event.event, 'worktree_added');
  assert.equal(event.persona, 'sidecar');
  assert.equal(event.pane_id, 33);
  assert.equal(event.sidecar_for, 12);
});

test('recordSidecar: rejects info without paneId', () => {
  assert.equal(recordSidecar(null), false);
  assert.equal(recordSidecar({}), false);
  assert.equal(recordSidecar({ coderPaneId: 12 }), false);
});

// constants --------------------------------------------------------------

test('DEFAULT_WATCH_INTERVAL_MIN is reasonable', () => {
  assert.equal(typeof DEFAULT_WATCH_INTERVAL_MIN, 'number');
  assert.ok(DEFAULT_WATCH_INTERVAL_MIN >= 1 && DEFAULT_WATCH_INTERVAL_MIN <= 10);
});
