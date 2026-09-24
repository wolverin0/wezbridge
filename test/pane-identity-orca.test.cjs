'use strict';
/**
 * pane-identity-orca.test.cjs — T-0596: resolveOrca (project/lane -> live Orca
 * terminal handle), and that it never overrides resolve()'s WezTerm precedence.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../src/pane-identity.cjs');

test('resolveOrca: lane match wins over cwd/title', () => {
  const terminals = [
    { handle: 'term_a', title: 'orchestrator', worktreePath: 'G:/Py Apps/other', lane: 'wezbridge' },
    { handle: 'term_b', title: 'wezbridge', worktreePath: 'G:/Py Apps/wezbridge', lane: null },
  ];
  const hit = identity.resolveOrca('wezbridge', terminals);
  assert.equal(hit.handle, 'term_a');
  assert.equal(hit.matchedBy, 'lane');
  assert.equal(hit.ambiguous.length, 0);
  assert.equal(hit.warning, null);
});

test('resolveOrca: falls back to cwd (worktreePath leaf) when no lane matches', () => {
  const terminals = [
    { handle: 'term_a', title: 'random', worktreePath: 'G:/Py Apps/wezbridge', lane: null },
  ];
  const hit = identity.resolveOrca('wezbridge', terminals);
  assert.equal(hit.handle, 'term_a');
  assert.equal(hit.matchedBy, 'cwd');
});

test('resolveOrca: falls back to title when no lane or cwd matches', () => {
  const terminals = [
    { handle: 'term_a', title: 'wezbridge', worktreePath: 'G:/Py Apps/other-repo', lane: null },
  ];
  const hit = identity.resolveOrca('wezbridge', terminals);
  assert.equal(hit.handle, 'term_a');
  assert.equal(hit.matchedBy, 'title');
});

test('resolveOrca: no match -> null handle with a clear warning', () => {
  const hit = identity.resolveOrca('nonexistent-project', []);
  assert.equal(hit.handle, null);
  assert.match(hit.warning, /no live orca terminal for "nonexistent-project"/);
});

test('resolveOrca: ambiguous matches are surfaced, not silently picked', () => {
  const terminals = [
    { handle: 'term_a', title: null, worktreePath: 'G:/Py Apps/wezbridge', lane: null },
    { handle: 'term_b', title: null, worktreePath: 'G:/Py Apps/wezbridge', lane: null },
  ];
  const hit = identity.resolveOrca('wezbridge', terminals);
  assert.equal(hit.ambiguous.length, 2);
  assert.match(hit.warning, /2 orca terminals match/);
});

test('resolveOrca: alias map resolves before matching, same as resolve()', () => {
  const aliasMap = new Map([['orch', 'wezbridge']]);
  const terminals = [{ handle: 'term_a', title: null, worktreePath: 'G:/Py Apps/wezbridge', lane: null }];
  const hit = identity.resolveOrca('orch', terminals, aliasMap);
  assert.equal(hit.handle, 'term_a');
});

test('WezTerm precedence unchanged: resolve() still finds a live WezTerm pane exactly as before Orca existed', () => {
  const panes = [{ pane_id: 5, cwd: 'G:/Py Apps/wezbridge', tab_title: null }];
  const hit = identity.resolve('wezbridge', panes);
  assert.equal(hit.paneId, 5);
  assert.equal(hit.matchedBy, 'cwd');
});
