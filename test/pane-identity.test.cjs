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

// ── T-0235: the sender's own identity, resolved at send time ───────────────
// WEZTERM_PANE is stamped at MCP-server spawn and never updates. After the
// 2026-08-23 WezTerm crash, pane-0 signed envelopes as 6, 1 and 2 within one
// hour — replies chased dead ids and receivers could not validate the sender.
test('T-0235: env pane confirmed by census (same project) is trusted', () => {
  const panes = [{ pane_id: 2, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null }];
  const r = id.resolveSelfPane({ envPane: 2, cwd: 'G:/Py Apps/wezbridge', panes });
  assert.strictEqual(r.paneId, 2);
  assert.strictEqual(r.source, 'env-verified');
  assert.strictEqual(r.project, 'wezbridge');
});

test('T-0235: stale env pane is CORRECTED when the census has exactly one pane for our project', () => {
  // The real 2026-08-23 shape: env says 0 (pre-crash), census says we are 2.
  const panes = [
    { pane_id: 2, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null },
    { pane_id: 15, cwd: 'file:///G:/Py%20Apps/whatsappbot-final/', tab_title: null },
  ];
  const r = id.resolveSelfPane({ envPane: 0, cwd: 'G:/Py Apps/wezbridge', panes });
  assert.strictEqual(r.paneId, 2, 'the header must stop lying');
  assert.strictEqual(r.source, 'env-corrected');
  assert.match(r.warning, /stale/);
});

test('T-0235: env pane pointing at a FOREIGN project is corrected, not trusted', () => {
  // Renumbering can hand our old id to another project's pane — signing with it
  // makes replies land in a foreign session.
  const panes = [
    { pane_id: 0, cwd: 'file:///G:/Py%20Apps/mutual/', tab_title: null },
    { pane_id: 7, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null },
  ];
  const r = id.resolveSelfPane({ envPane: 0, cwd: 'G:/Py Apps/wezbridge', panes });
  assert.strictEqual(r.paneId, 7);
  assert.strictEqual(r.source, 'env-corrected');
});

test('T-0235: explicit from_pane is trusted verbatim — the external/headless sender path', () => {
  const r = id.resolveSelfPane({ explicitPane: 42, envPane: 0, cwd: 'G:/Py Apps/wezbridge', panes: [] });
  assert.strictEqual(r.paneId, 42);
  assert.strictEqual(r.source, 'explicit');
});

test('T-0235: unprovable identity falls back to env WITH a warning, or null without env', () => {
  const twoOfUs = [
    { pane_id: 3, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null },
    { pane_id: 9, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null },
  ];
  const ambiguous = id.resolveSelfPane({ envPane: 5, cwd: 'G:/Py Apps/wezbridge', panes: twoOfUs });
  assert.strictEqual(ambiguous.source, 'unresolved');
  assert.strictEqual(ambiguous.paneId, 5, 'env is the last resort, never silently dropped');
  assert.match(ambiguous.warning, /pass from_pane explicitly/);
  const nothing = id.resolveSelfPane({ envPane: NaN, cwd: 'G:/Py Apps/wezbridge', panes: [] });
  assert.strictEqual(nothing.paneId, null);
  assert.strictEqual(nothing.source, 'unresolved');
});
