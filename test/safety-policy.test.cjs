'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const policy = require(path.resolve(__dirname, '..', 'src', 'safety-policy.cjs'));
const { evaluate, setSelfPaneIds, RULES, DESTRUCTIVE_TEXT_PATTERNS } = policy;

function withEnv(key, value, fn) {
  const prev = process.env[key];
  process.env[key] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// no_self_kill ----------------------------------------------------------

test('blocks: kill_session on registered self pane', () => {
  setSelfPaneIds([0, 12]);
  const r = evaluate({ action: 'kill_session', paneId: 12 });
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'no_self_kill');
});

test('allows: kill_session on a non-self pane', () => {
  setSelfPaneIds([0]);
  const r = evaluate({ action: 'kill_session', paneId: 21 });
  assert.equal(r.allowed, true);
});

test('allows: kill_session when no self panes registered', () => {
  setSelfPaneIds([]);
  const r = evaluate({ action: 'kill_session', paneId: 12 });
  assert.equal(r.allowed, true);
});

test('handles: kill_session with paneId as string', () => {
  setSelfPaneIds([0]);
  const r = evaluate({ action: 'kill_session', paneId: '0' });
  assert.equal(r.allowed, false);
});

// no_destructive_prompt_injection --------------------------------------

test('blocks: send_prompt containing rm -rf /', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'oops rm -rf / now' });
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'no_destructive_prompt_injection');
});

test('blocks: send_prompt containing DROP TABLE', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'DROP TABLE users;' });
  assert.equal(r.allowed, false);
});

test('blocks: send_prompt containing git push --force origin main', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'please run git push --force origin main' });
  assert.equal(r.allowed, false);
});

test('blocks: send_prompt with fork bomb', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'try this: :(){ :|:& };:' });
  assert.equal(r.allowed, false);
});

test('blocks: send_prompt with mkfs /dev/sda', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'mkfs.ext4 /dev/sda1' });
  assert.equal(r.allowed, false);
});

test('allows: benign send_prompt', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'continue with the next task' });
  assert.equal(r.allowed, true);
});

test('allows: send_prompt mentioning git push to feature branch', () => {
  const r = evaluate({ action: 'send_prompt', paneId: 1, prompt: 'run git push origin feat/x' });
  assert.equal(r.allowed, true);
});

// worktree_outside_dotworktrees ----------------------------------------

test('blocks: worktree_remove on path outside .worktrees', () => {
  const r = evaluate({
    action: 'worktree_remove',
    baseCwd: '/repo',
    worktreePath: '/etc/passwd',
  });
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'worktree_outside_dotworktrees');
});

test('allows: worktree_remove on path inside .worktrees/', () => {
  const r = evaluate({
    action: 'worktree_remove',
    baseCwd: '/repo',
    worktreePath: '/repo/.worktrees/feat-x',
  });
  assert.equal(r.allowed, true);
});

test('allows: worktree_remove on .worktrees itself', () => {
  const r = evaluate({
    action: 'worktree_remove',
    baseCwd: '/repo',
    worktreePath: '/repo/.worktrees',
  });
  assert.equal(r.allowed, true);
});

test('blocks: worktree_remove without baseCwd is ignored (no false-block)', () => {
  // Without baseCwd we cannot validate; allow but log via reason
  const r = evaluate({ action: 'worktree_remove', worktreePath: '/repo/.worktrees/x' });
  assert.equal(r.allowed, true);
});

// broadcast_too_wide ---------------------------------------------------

test('blocks: broadcast to >10 recipients', () => {
  const r = evaluate({ action: 'broadcast', recipientCount: 25 });
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'broadcast_too_wide');
});

test('allows: broadcast to 5 recipients', () => {
  const r = evaluate({ action: 'broadcast', recipientCount: 5 });
  assert.equal(r.allowed, true);
});

// send_key_ctrl_c_to_self ----------------------------------------------

test('blocks: send_key ctrl+c to self pane', () => {
  setSelfPaneIds([0]);
  const r = evaluate({ action: 'send_key', paneId: 0, key: 'ctrl+c' });
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'send_key_ctrl_c_to_self');
});

test('allows: send_key ctrl+c to non-self pane', () => {
  setSelfPaneIds([0]);
  const r = evaluate({ action: 'send_key', paneId: 12, key: 'ctrl+c' });
  assert.equal(r.allowed, true);
});

test('allows: send_key enter to self pane', () => {
  setSelfPaneIds([0]);
  const r = evaluate({ action: 'send_key', paneId: 0, key: 'enter' });
  assert.equal(r.allowed, true);
});

// override + edge cases ------------------------------------------------

test('override: WEZBRIDGE_SAFETY_OVERRIDE=1 bypasses block', () => {
  setSelfPaneIds([0]);
  withEnv('WEZBRIDGE_SAFETY_OVERRIDE', '1', () => {
    const r = evaluate({ action: 'kill_session', paneId: 0 });
    assert.equal(r.allowed, true);
    assert.match(r.reason, /WEZBRIDGE_SAFETY_OVERRIDE/);
  });
});

test('empty context allowed', () => {
  const r = evaluate(null);
  assert.equal(r.allowed, true);
});

test('unknown action allowed (open by default)', () => {
  const r = evaluate({ action: 'list_projects' });
  assert.equal(r.allowed, true);
});

// sanity ---------------------------------------------------------------

test('RULES export sanity', () => {
  assert.equal(Array.isArray(RULES), true);
  assert.ok(RULES.length >= 5);
  for (const r of RULES) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.reason, 'string');
    assert.equal(typeof r.test, 'function');
  }
});

test('DESTRUCTIVE_TEXT_PATTERNS is a non-empty array of regexes', () => {
  assert.equal(Array.isArray(DESTRUCTIVE_TEXT_PATTERNS), true);
  assert.ok(DESTRUCTIVE_TEXT_PATTERNS.length >= 5);
  for (const p of DESTRUCTIVE_TEXT_PATTERNS) {
    assert.ok(p instanceof RegExp);
  }
});
