'use strict';
/**
 * action-log.test.cjs — first tests for src/action-log.cjs (B2, action-log v2).
 * Covers: dir auto-creation + WEZBRIDGE_INTEL_DIR resolution, record shape
 * (ts/actor/pid/action/target/why), v2 optional fields corr/task/project,
 * actor precedence (WEZBRIDGE_ACTOR > WEZTERM_PANE > script), the
 * WEZBRIDGE_ACTION_WHY fallback, and the never-throws contract on broken IO.
 * All IO points at temp dirs via WEZBRIDGE_INTEL_DIR; nothing touches _intel.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'action-log-'));
const ENV_KEYS = ['WEZBRIDGE_INTEL_DIR', 'WEZBRIDGE_ACTOR', 'WEZBRIDGE_ACTION_WHY', 'WEZTERM_PANE'];

const { logAction, logPath, LOG_PATH } = require('../src/action-log.cjs');

let caseN = 0;
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try { return fn(); } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
function freshIntelDir() {
  // Deliberately NOT created — logAction must mkdirSync it (v2).
  return path.join(TMP, `case-${caseN++}`, 'nested');
}
function readLines(dir) {
  return fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
}

test('logPath honors WEZBRIDGE_INTEL_DIR and falls back to the repo default', () => {
  const dir = freshIntelDir();
  withEnv({ WEZBRIDGE_INTEL_DIR: dir }, () => {
    assert.strictEqual(logPath(), path.join(dir, 'actions.jsonl'));
  });
  withEnv({}, () => {
    assert.strictEqual(logPath(), LOG_PATH);
  });
});

test('logAction creates the missing intel dir and writes a full record', () => {
  const dir = freshIntelDir();
  withEnv({ WEZBRIDGE_INTEL_DIR: dir, WEZBRIDGE_ACTOR: 'test-actor' }, () => {
    assert.strictEqual(fs.existsSync(dir), false);
    logAction('spawn_refused', { target: 'pane-9', why: 'cap reached', extra: { max: 5 } });
    const [rec] = readLines(dir);
    assert.strictEqual(rec.action, 'spawn_refused');
    assert.strictEqual(rec.target, 'pane-9');
    assert.strictEqual(rec.why, 'cap reached');
    assert.strictEqual(rec.actor, 'test-actor');
    assert.strictEqual(rec.pid, process.pid);
    assert.deepStrictEqual(rec.extra, { max: 5 });
    assert.ok(!Number.isNaN(Date.parse(rec.ts)), 'ts is a parseable timestamp');
  });
});

test('v2 fields corr/task/project land on the record only when given', () => {
  const dir = freshIntelDir();
  withEnv({ WEZBRIDGE_INTEL_DIR: dir, WEZBRIDGE_ACTOR: 'x' }, () => {
    logAction('auto_close_shadow', { target: 'pane-3', why: 'eligible', corr: 'T-0199', task: 'T-0199', project: 'mutual' });
    logAction('kill_pane', { target: 'pane-4' });
    const [withFields, without] = readLines(dir);
    assert.strictEqual(withFields.corr, 'T-0199');
    assert.strictEqual(withFields.task, 'T-0199');
    assert.strictEqual(withFields.project, 'mutual');
    assert.ok(!('corr' in without) && !('task' in without) && !('project' in without),
      'absent optional fields are omitted, not null-filled');
  });
});

test('actor precedence: WEZBRIDGE_ACTOR > pane-<WEZTERM_PANE> > script name', () => {
  const dir = freshIntelDir();
  withEnv({ WEZBRIDGE_INTEL_DIR: dir, WEZBRIDGE_ACTOR: 'named', WEZTERM_PANE: '12' }, () => {
    logAction('a');
  });
  withEnv({ WEZBRIDGE_INTEL_DIR: dir, WEZTERM_PANE: '12' }, () => {
    logAction('b');
  });
  withEnv({ WEZBRIDGE_INTEL_DIR: dir }, () => {
    logAction('c');
  });
  const [a, b, c] = readLines(dir);
  assert.strictEqual(a.actor, 'named');
  assert.strictEqual(b.actor, 'pane-12');
  assert.ok(c.actor && !c.actor.startsWith('pane-'), `script/pid fallback, got "${c.actor}"`);
});

test('why falls back to WEZBRIDGE_ACTION_WHY when the caller gives none', () => {
  const dir = freshIntelDir();
  withEnv({ WEZBRIDGE_INTEL_DIR: dir, WEZBRIDGE_ACTOR: 'x', WEZBRIDGE_ACTION_WHY: 'ambient reason' }, () => {
    logAction('spawn_pane', { target: 'pane-1' });
    logAction('spawn_pane', { target: 'pane-2', why: 'explicit wins' });
  });
  const [ambient, explicit] = readLines(dir);
  assert.strictEqual(ambient.why, 'ambient reason');
  assert.strictEqual(explicit.why, 'explicit wins');
});

test('never throws: unwritable log path is a silent no-op', () => {
  // Parent "dir" is a FILE, so mkdirSync/appendFileSync must fail internally.
  const fileAsDir = path.join(TMP, `blocker-${caseN++}`);
  fs.writeFileSync(fileAsDir, 'not a directory', 'utf8');
  withEnv({ WEZBRIDGE_INTEL_DIR: path.join(fileAsDir, 'sub') }, () => {
    assert.doesNotThrow(() => logAction('spawn_pane', { target: 'pane-1' }));
  });
});
