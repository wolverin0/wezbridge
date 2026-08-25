'use strict';
/**
 * Two mux sockets, one fleet (mm-0dc1, measured 2026-08-25).
 *
 * The GUI socket the MCP server talks to numbered the live panes 2/11/14/33/36;
 * each pane's own WEZTERM_PANE, which comes from the other socket, said
 * 6/15/18/28/30. Every reply addressed to the id a colleague advertised landed
 * in _intel/queues/_dead-letter.jsonl unread — 10 of 10 dead letters were
 * addressed to "pane 6", which in the sending server's space was nobody.
 *
 * These tests pin the two guards that make that condition loud: refusing an
 * unknown target id before transport, and naming the divergence in health.
 * The fixtures are the REAL measured lists, so a regression reproduces the
 * actual outage rather than an invented one.
 */
const test = require('node:test');
const assert = require('node:assert');
const identity = require('../src/pane-identity.cjs');
const wez = require('../src/wezterm.cjs');

// Measured 2026-08-25 via `wezterm cli list --format json` against each socket.
const GUI_SPACE = [
  { pane_id: 2, tab_title: 'wezbridge', cwd: 'file:///G:/Py%20Apps/wezbridge/' },
  { pane_id: 11, tab_title: 'infra', cwd: 'file:///G:/Py%20Apps/infra/' },
  { pane_id: 14, tab_title: 'memorymaster', cwd: 'file:///G:/Py%20Apps/memorymaster/' },
  { pane_id: 33, tab_title: 'wabotclaude', cwd: 'file:///G:/Py%20Apps/whatsappbot-final/' },
  { pane_id: 36, tab_title: 'dsh-pilot', cwd: 'file:///G:/Py%20Apps/dsh-pilot/' },
];
const ENV_SPACE = [
  { pane_id: 6, tab_title: 'wezbridge', cwd: 'file:///G:/Py%20Apps/wezbridge/' },
  { pane_id: 15, tab_title: 'infra', cwd: 'file:///G:/Py%20Apps/infra/' },
  { pane_id: 18, tab_title: 'memorymaster', cwd: 'file:///G:/Py%20Apps/memorymaster/' },
  { pane_id: 28, tab_title: 'wabotclaude', cwd: 'file:///G:/Py%20Apps/whatsappbot-final/' },
  { pane_id: 30, tab_title: 'dsh-pilot', cwd: 'file:///G:/Py%20Apps/dsh-pilot/' },
  { pane_id: 33, tab_title: 'axion', cwd: 'file:///G:/Py%20Apps/axion/' },
];

test('validateTargetPane refuses the id a peer advertised about itself', () => {
  // The orchestrator says "I am pane 6" (its env). A peer sending through the
  // GUI space must NOT attempt id 6 — that is the dead-letter path.
  const res = identity.validateTargetPane({ paneId: 6, panes: GUI_SPACE });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /not in the live census/);
  assert.ok(res.alternatives.some((a) => a.project === 'wezbridge' && a.paneId === 2),
    'the refusal must name the pane the caller actually meant');
});

test('validateTargetPane accepts a live id and names whose it is', () => {
  const res = identity.validateTargetPane({ paneId: 11, panes: GUI_SPACE });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.project, 'infra');
});

test('a live id that is a DIFFERENT session per space still resolves — so the caller is told who it hit', () => {
  // id 33 is wabot in the GUI space and axion in the env space. Neither call
  // can fail, so the only defence is naming the resolved project out loud.
  const viaGui = identity.validateTargetPane({ paneId: 33, panes: GUI_SPACE });
  const viaEnv = identity.validateTargetPane({ paneId: 33, panes: ENV_SPACE });
  assert.strictEqual(viaGui.project, 'whatsappbot-final');
  assert.strictEqual(viaEnv.project, 'axion');
  assert.notStrictEqual(viaGui.project, viaEnv.project);
});

test('an empty census does not convict a pane of being absent', () => {
  // mm-c03b: silence from the instrument is not evidence about the system.
  // Refusing here would break every send whenever discovery hiccups.
  const res = identity.validateTargetPane({ paneId: 6, panes: [] });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.unverified, true);
});

test('compareSocketSpaces reports the divergence and the dangerous collisions apart', () => {
  const cmp = wez.compareSocketSpaces(GUI_SPACE, ENV_SPACE);
  assert.strictEqual(cmp.diverged, true);
  const wezbridge = cmp.shared.find((s) => s.tab === 'wezbridge');
  assert.deepStrictEqual(wezbridge, { tab: 'wezbridge', guiId: 2, envId: 6 });
  assert.strictEqual(cmp.shared.length, 5, 'all five named panes carry two ids');
  // The collision is the half that misdelivers instead of erroring.
  assert.deepStrictEqual(cmp.collisions, [{ id: 33, guiTab: 'wabotclaude', envTab: 'axion' }]);
});

test('compareSocketSpaces stays quiet when one socket serves the fleet', () => {
  const cmp = wez.compareSocketSpaces(GUI_SPACE, GUI_SPACE);
  assert.strictEqual(cmp.diverged, false);
  assert.deepStrictEqual(cmp.shared, []);
  assert.deepStrictEqual(cmp.collisions, []);
});
