'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseStatusBar } = require('../src/status-parser.cjs');

test('ctx regression: all four real-world statusline shapes parse', () => {
  // v1 matched ONLY "Ctx: N%". Live panes render "Ctx Used: N%" (Claude) and
  // "Context N% used"/"Context N% left" (codex), so ctx read null on 17/17
  // panes on 2026-07-28 while session/weekly parsed fine — a silent sensor
  // failure in the most decision-relevant per-pane signal.
  const cases = [
    ['Session: webdesign  Ctx Used: 29.0%  Context: [###] 286k/1.0M (29%)', 29.0, 'current Claude'],
    ['Ctx: 17%  Session: 22.0%', 17, 'legacy Claude'],
    ['gpt-5.6-sol high · Working · Context 83% used · weekly 94% left', 83, 'codex used'],
    ['gpt-5.6-sol high · Working · Context 47% left', 53, 'codex left -> inverted'],
  ];
  for (const [line, expected, label] of cases) {
    const r = parseStatusBar(line);
    assert.ok(r, `${label}: must parse`);
    assert.strictEqual(r.ctx, expected, `${label}: ctx`);
  }
});

test('ctx regression: session and weekly still parse alongside the new ctx shapes', () => {
  const r = parseStatusBar('Ctx Used: 29.0%  Reset: 58m  Session: 23.0%  Weekly: 82.0%');
  assert.strictEqual(r.ctx, 29.0);
  assert.strictEqual(r.session, 23.0);
  assert.strictEqual(r.weekly, 82.0);
});

test('ctx regression: a pane with no status bar still returns null', () => {
  assert.strictEqual(parseStatusBar('pauol@wolverin0 MINGW64 /g/repo\n$ '), null);
});
