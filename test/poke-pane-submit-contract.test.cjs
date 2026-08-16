'use strict';
/**
 * The delivery contract for scheduled pokes.
 *
 * THE CLAIM UNDER TEST: a poke is "delivered" only when the composer is EMPTY.
 * Seeing the text in the pane proves nothing — an unsent prompt sitting in the
 * composer looks exactly like a sent one in the scrollback, which is how a
 * scheduled job reports VERIFIED while its message was never submitted.
 *
 * HISTORY OF THIS FILE. It used to assert regexes against poke-pane.cjs's source
 * text. That broke on 2026-08-14 when a third argument was added to an unrelated
 * call: behaviour untouched, test red. The far worse property is the one that
 * did not announce itself — deleting the Enter write entirely would have kept it
 * GREEN, because the strings it matched also appear in comments. The decision is
 * now a module (scripts/composer-state.cjs) and is exercised with real pane text.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { composerStillHolds } = require('../scripts/composer-state.cjs');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const pokeSource = read('scripts/poke-pane.cjs');
const monitorSource = read('scripts/wabot-roadmap-monitor.ps1');

/** A Claude Code pane with `msg` still sitting unsent in the composer. */
const holding = (msg) => [
  '  brlite steward gate: 3 findings past deadline',
  '',
  '╭──────────────────────────────────────────────╮',
  `│ ❯ ${msg}`,
  '╰──────────────────────────────────────────────╯',
].join('\n');

/** The same pane after the prompt was actually accepted. */
const cleared = [
  '  brlite steward gate: 3 findings past deadline',
  '',
  '● Reading _intel/rulings.jsonl...',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ ❯ ',
  '╰──────────────────────────────────────────────╯',
].join('\n');

const POKE = 'steward-gate RED: see _intel/steward-gate-latest.txt';

// ---------------------------------------------------------------------------
// The property that matters
// ---------------------------------------------------------------------------

test('an unsent prompt in the composer is NOT delivery', () => {
  assert.equal(composerStillHolds(holding(POKE), POKE), true);
});

test('an empty composer IS delivery', () => {
  assert.equal(composerStillHolds(cleared, POKE), false);
});

test('the text appearing in scrollback is not proof — only the composer counts', () => {
  // The exact false-positive this contract exists to prevent: the poke is
  // visible in the pane's history AND the composer is empty. That is delivered.
  const echoed = `● user: ${POKE}\n${cleared}`;
  assert.equal(composerStillHolds(echoed, POKE), false);
});

test('a COLLAPSED paste still counts as held — the payload is there under a label', () => {
  // Long pokes render as "[Pasted text +12 lines]" instead of the text itself.
  // Matching only on the literal payload would read this as cleared and report
  // a long, unsent message as delivered.
  assert.equal(composerStillHolds(holding('[Pasted text +12 lines]'), POKE), true);
});

test('a truncated composer render still counts as held', () => {
  // Panes wrap and clip. Only a prefix of the poke may be visible.
  assert.equal(composerStillHolds(holding(POKE.slice(0, 24)), POKE), true);
});

test('a DIFFERENT prompt in the composer is not our payload', () => {
  // Someone typing while the poke lands must not make us report "still stuck"
  // forever — exit 7 would be wrong and the operator would stop believing it.
  assert.equal(composerStillHolds(holding('what is the brlite gate saying?'), POKE), false);
});

test('an empty payload can never be reported stuck', () => {
  assert.equal(composerStillHolds(holding('anything'), ''), false);
});

test('unreadable pane text is not read as cleared by accident', () => {
  // No composer marker at all means we learned nothing. Returning false here is
  // deliberate — the CALLER escalates unreadable panes to exit 8 rather than
  // letting this function invent a verdict it has no evidence for.
  assert.equal(composerStillHolds('', POKE), false);
  assert.match(pokeSource, /composer verification unavailable/,
    'poke-pane must exit non-zero when it cannot read the composer at all');
});

// ---------------------------------------------------------------------------
// Structural assertions — only for things a unit test genuinely cannot reach
// ---------------------------------------------------------------------------

test('Enter is written through stdin, separately from the payload', () => {
  // Behavioural coverage would need a live pane. What is checkable here is that
  // a bare CR is written on its own: passing a control character as an argv
  // element gets it swallowed before wezterm sees it on Windows.
  assert.match(pokeSource, /sendViaStdin\(\s*target\.pane_id,\s*'\\r'/,
    'the CR must be its own stdin write');
  assert.match(pokeSource, /input:\s*payload/, 'payload must go through stdin, not argv');
});

test('nothing in the delivery path claims echo as proof', () => {
  for (const [name, src] of [['poke-pane.cjs', pokeSource], ['wabot-roadmap-monitor.ps1', monitorSource]]) {
    assert.equal(/VERIFIED \\?\(echo found in pane\\?\)/.test(src), false, `${name} still claims echo is proof`);
    assert.equal(/VERIFIED \\?\(composer cleared\\?\)/.test(src), true, `${name} must verify on composer clearance`);
  }
});
