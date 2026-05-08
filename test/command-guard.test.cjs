'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { evaluate, DESTRUCTIVE_PATTERNS } = require(
  path.resolve(__dirname, '..', 'scripts', 'command-guard.cjs'),
);

// Helpers ---------------------------------------------------------------

function withEnv(key, value, fn) {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// Block cases -----------------------------------------------------------

test('blocks: git push origin main', () => {
  const r = evaluate(['git', 'push', 'origin', 'main']);
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'git_push_to_default_branch');
});

test('blocks: git push origin master', () => {
  const r = evaluate(['git', 'push', 'origin', 'master']);
  assert.equal(r.allowed, false);
});

test('blocks: git push HEAD:main', () => {
  const r = evaluate(['git', 'push', 'origin', 'HEAD:main']);
  assert.equal(r.allowed, false);
});

test('blocks: git push --force', () => {
  const r = evaluate(['git', 'push', '--force']);
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'git_push_force');
});

test('blocks: git push -f', () => {
  const r = evaluate(['git', 'push', '-f']);
  assert.equal(r.allowed, false);
});

test('blocks: git push --force-with-lease', () => {
  const r = evaluate(['git', 'push', '--force-with-lease']);
  assert.equal(r.allowed, false);
});

test('blocks: git reset --hard', () => {
  const r = evaluate(['git', 'reset', '--hard']);
  assert.equal(r.allowed, false);
});

test('blocks: git reset --hard HEAD~3', () => {
  const r = evaluate(['git', 'reset', '--hard', 'HEAD~3']);
  assert.equal(r.allowed, false);
});

test('blocks: git checkout .', () => {
  const r = evaluate(['git', 'checkout', '.']);
  assert.equal(r.allowed, false);
});

test('blocks: git clean -fd', () => {
  const r = evaluate(['git', 'clean', '-fd']);
  assert.equal(r.allowed, false);
});

test('blocks: git clean -fdx', () => {
  const r = evaluate(['git', 'clean', '-fdx']);
  assert.equal(r.allowed, false);
});

test('blocks: git branch -D feature-x', () => {
  const r = evaluate(['git', 'branch', '-D', 'feature-x']);
  assert.equal(r.allowed, false);
});

test('blocks: gh pr merge 170', () => {
  const r = evaluate(['gh', 'pr', 'merge', '170']);
  assert.equal(r.allowed, false);
  assert.equal(r.matched, 'gh_pr_merge');
});

test('blocks: gh pr merge 170 --merge --delete-branch', () => {
  const r = evaluate(['gh', 'pr', 'merge', '170', '--merge', '--delete-branch']);
  assert.equal(r.allowed, false);
});

// Allow cases -----------------------------------------------------------

test('allows: empty argv', () => {
  const r = evaluate([]);
  assert.equal(r.allowed, true);
});

test('allows: git status', () => {
  const r = evaluate(['git', 'status']);
  assert.equal(r.allowed, true);
});

test('allows: git log', () => {
  const r = evaluate(['git', 'log', '--oneline', '-5']);
  assert.equal(r.allowed, true);
});

test('allows: git push origin feature-branch (non-default)', () => {
  const r = evaluate(['git', 'push', 'origin', 'feature/visual-sprint']);
  assert.equal(r.allowed, true);
});

test('allows: git push -u origin feature-branch (no main token)', () => {
  const r = evaluate(['git', 'push', '-u', 'origin', 'feat/x']);
  assert.equal(r.allowed, true);
});

test('allows: git reset HEAD~1 (soft, no --hard)', () => {
  const r = evaluate(['git', 'reset', 'HEAD~1']);
  assert.equal(r.allowed, true);
});

test('allows: git checkout -b new-branch', () => {
  const r = evaluate(['git', 'checkout', '-b', 'new-branch']);
  assert.equal(r.allowed, true);
});

test('allows: git branch -d merged-branch (lowercase, normal delete)', () => {
  const r = evaluate(['git', 'branch', '-d', 'merged-branch']);
  assert.equal(r.allowed, true);
});

test('allows: gh pr create --base main', () => {
  const r = evaluate(['gh', 'pr', 'create', '--base', 'main', '--head', 'feat']);
  assert.equal(r.allowed, true);
});

test('allows: gh pr list', () => {
  const r = evaluate(['gh', 'pr', 'list']);
  assert.equal(r.allowed, true);
});

test('allows: gh pr view 169', () => {
  const r = evaluate(['gh', 'pr', 'view', '169']);
  assert.equal(r.allowed, true);
});

test('allows: non-shimmed binaries (e.g. ls, npm, node)', () => {
  for (const argv of [['ls', '-la'], ['npm', 'install'], ['node', 'script.js']]) {
    const r = evaluate(argv);
    assert.equal(r.allowed, true, `expected ${argv.join(' ')} to be allowed`);
  }
});

// Override --------------------------------------------------------------

test('override: WEZBRIDGE_GUARD_OVERRIDE=1 bypasses block', () => {
  withEnv('WEZBRIDGE_GUARD_OVERRIDE', '1', () => {
    const r = evaluate(['git', 'push', 'origin', 'main']);
    assert.equal(r.allowed, true);
    assert.match(r.reason, /WEZBRIDGE_GUARD_OVERRIDE/);
  });
});

test('override: WEZBRIDGE_GUARD_OVERRIDE=0 does NOT bypass', () => {
  withEnv('WEZBRIDGE_GUARD_OVERRIDE', '0', () => {
    const r = evaluate(['git', 'push', 'origin', 'main']);
    assert.equal(r.allowed, false);
  });
});

// Sanity ----------------------------------------------------------------

test('DESTRUCTIVE_PATTERNS exports a non-empty array', () => {
  assert.equal(Array.isArray(DESTRUCTIVE_PATTERNS), true);
  assert.ok(DESTRUCTIVE_PATTERNS.length >= 5);
  for (const p of DESTRUCTIVE_PATTERNS) {
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.reason, 'string');
    assert.equal(typeof p.test, 'function');
  }
});
