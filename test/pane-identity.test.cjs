'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const id = require('../src/pane-identity.cjs');

// Shapes taken from real `wezterm cli list --format json` output, 2026-07-29.
const PANES = [
  { pane_id: 3, tab_title: 'marketing', cwd: 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps/marketing/' },
  { pane_id: 5, tab_title: 'whatsappbot-final', cwd: 'file:///G:/.../Py%20Apps/whatsappbot-prod%20-%20Copy%20-%20Copy/whatsappbot-final/' },
  { pane_id: 15, tab_title: 'futuraCRM', cwd: 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps/argentina-sales-hub/' },
  { pane_id: 38, tab_title: 'watchdog', cwd: 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps/wezbridge/' },
];

const ALIASES = id.buildAliasMap([
  { project: 'argentina-sales-hub', aliases: ['futuraCRM', 'futura CRM'] },
  { project: 'marketing' },
]);

test('cwd is percent-decoded and reduced to the folder name', () => {
  assert.strictEqual(id.projectFromCwd('file:///G:/x/Py%20Apps/argentina-sales-hub/'), 'argentina-sales-hub');
  assert.strictEqual(id.projectFromCwd('file:///G:/x/Py%20Apps/whatsappbot-final'), 'whatsappbot-final');
  assert.strictEqual(id.projectFromCwd(null), null);
});

test('an operator alias resolves to the folder that actually holds the work', () => {
  // The operator calls argentina-sales-hub "futuraCRM" and labels the tab that
  // way. Asking for either name must reach the same pane — a resolver that only
  // knew folder names would fail every time he used his own vocabulary.
  const byAlias = id.resolve('futuraCRM', PANES, ALIASES);
  const byFolder = id.resolve('argentina-sales-hub', PANES, ALIASES);
  assert.strictEqual(byAlias.paneId, 15);
  assert.strictEqual(byFolder.paneId, 15);
  assert.strictEqual(byFolder.matchedBy, 'cwd');
});

test('an alias is NOT reported as a conflict', () => {
  // Pane 15 is labelled futuraCRM and works in argentina-sales-hub. Declared as
  // an alias, that is correct and must stay silent; warning on it would train
  // the reader to ignore warnings.
  const i = id.identify(PANES[2], ALIASES);
  assert.strictEqual(i.canonical, 'argentina-sales-hub');
  assert.strictEqual(i.labelConflict, false);
});

test('a label pointing at a DIFFERENT project is surfaced', () => {
  // A tab left labelled "marketing" while the session works in wezbridge is a
  // borrowed or stale pane — exactly the situation that put ClawTrol work into
  // another project's session.
  const aliases = id.buildAliasMap([{ project: 'marketing' }, { project: 'wezbridge' }]);
  const pane = { pane_id: 99, tab_title: 'marketing', cwd: 'file:///G:/x/Py%20Apps/wezbridge/' };
  const i = id.identify(pane, aliases);
  assert.strictEqual(i.canonical, 'wezbridge', 'cwd is authoritative, not the label');
  assert.strictEqual(i.labelConflict, true);
  const r = id.resolve('wezbridge', [pane], aliases);
  assert.match(r.warning, /labelled "marketing" but works in "wezbridge"/);
});

test('cwd outranks tab_title when both could match', () => {
  const aliases = id.buildAliasMap([{ project: 'wezbridge' }]);
  const panes = [
    { pane_id: 7, tab_title: 'wezbridge', cwd: 'file:///G:/x/Py%20Apps/other/' },
    { pane_id: 8, tab_title: 'watchdog', cwd: 'file:///G:/x/Py%20Apps/wezbridge/' },
  ];
  const r = id.resolve('wezbridge', panes, aliases);
  assert.strictEqual(r.paneId, 8, 'the pane WORKING in wezbridge wins over the one merely labelled so');
  assert.strictEqual(r.matchedBy, 'cwd');
});

test('two panes in the same project are reported as ambiguous, not silently picked', () => {
  // Silently choosing one is how a message lands in the wrong half of a split
  // workspace. Say so and let the caller disambiguate.
  const panes = [
    { pane_id: 1, tab_title: 'mutual', cwd: 'file:///G:/x/Py%20Apps/mutual/' },
    { pane_id: 2, tab_title: 'mutual-2', cwd: 'file:///G:/x/Py%20Apps/mutual/' },
  ];
  const r = id.resolve('mutual', panes, id.buildAliasMap([{ project: 'mutual' }]));
  assert.deepStrictEqual(r.ambiguous, [1, 2]);
  assert.match(r.warning, /2 panes match/);
});

test('a project with no live pane returns null rather than a near miss', () => {
  // "Spawn one in the right cwd" is the correct next step; returning the closest
  // available pane is how work gets borrowed into the wrong project.
  const r = id.resolve('nereidas', PANES, ALIASES);
  assert.strictEqual(r.paneId, null);
  assert.match(r.warning, /no live pane/);
});

test('resolution never depends on pane_id ordering or value', () => {
  // pane_id resets to 0 when WezTerm restarts and panes respawn in a different
  // order, so identity must not be positional. Same panes, ids permuted: same answer.
  const permuted = PANES.map((p, i) => ({ ...p, pane_id: [900, 901, 902, 903][i] }));
  assert.strictEqual(id.resolve('futuraCRM', permuted, ALIASES).paneId, 902);
});
