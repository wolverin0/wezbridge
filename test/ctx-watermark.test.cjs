'use strict';

/**
 * ctx-watermark.test.cjs — M2 (2026-08-24): the waker reads the watched pane's
 * "Ctx Used: NN%" off the same lastLines it already scans, so a poke can warn
 * BEFORE the context cliff (wabot hit 97% unseen the same day this was built).
 */

const test = require('node:test');
const assert = require('node:assert');
const { paneContextPct } = require('../src/orchestrator-waker.cjs');

const pane = (project, lastLines) => ({ pane_id: 15, project, lastLines });

test('M2: extracts the context % of the pane matching the watched repo', () => {
  const panes = [
    pane('/G:/Py Apps/wezbridge', 'Ctx Used: 12.0%  Context: [..]'),
    pane('/G:/Py Apps/whatsappbot-prod - Copy - Copy/whatsappbot-final', 'Ctx Used: 97.0%  Context: [..]'),
  ];
  assert.strictEqual(paneContextPct(panes, 'whatsappbot-prod - Copy - Copy/whatsappbot-final'), 97);
  assert.strictEqual(paneContextPct(panes, 'wezbridge'), 12);
});

test('M2: no pane or no marker returns null — a missing number never fakes an alert', () => {
  assert.strictEqual(paneContextPct([], 'wezbridge'), null);
  assert.strictEqual(paneContextPct([pane('/x/wezbridge', 'sin status bar')], 'wezbridge'), null);
  assert.strictEqual(paneContextPct([pane('/x/otra-cosa', 'Ctx Used: 99.0%')], 'wezbridge'), null);
  assert.strictEqual(paneContextPct([], ''), null);
});
