// read_output delta cursor semantics (v3.5). The pane-line fixtures below are
// REAL transcripts captured 2026-07-02 from a live Git Bash pane in WezTerm —
// including the exact repeating two-line prompt that originally made the
// fingerprint match the newest prompt block and swallow the whole delta.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeReadCursor, sliceAfterCursor, trimTrailingEmpty } = require('../src/read-cursor.cjs');

const PROMPT = 'pauol@wolverin0 MINGW64 /g/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge (feat)';

// Pane tail at read 1 — first command executed, live prompt line is bare "$"
const READ1 = [
  '$ echo FIRST_MARK_1',
  'FIRST_MARK_1',
  '',
  PROMPT,
  '$',
];

// Same pane at read 2 — the previously-bare "$" line MUTATED into the second
// command, and an identical prompt block repeats at the bottom.
const READ2 = [
  '$ echo FIRST_MARK_1',
  'FIRST_MARK_1',
  '',
  PROMPT,
  '$ echo SECOND_MARK_2',
  'SECOND_MARK_2',
  '',
  PROMPT,
  '$',
];

test('delta after cursor contains ONLY the new command + output (real transcript)', () => {
  const cursor = makeReadCursor(READ1);
  const delta = sliceAfterCursor(READ2, cursor);
  assert.ok(delta !== null, 'cursor must still match');
  const joined = delta.join('\n');
  assert.ok(joined.includes('SECOND_MARK_2'), 'delta has the new marker');
  assert.ok(!joined.includes('FIRST_MARK_1'), 'delta excludes the old marker');
});

test('repeating prompt blocks do not swallow the delta (regression: live-line fingerprint)', () => {
  // The old fingerprint ended on the bare "$" live line; the identical block
  // at the END of READ2 matched first and returned an empty delta.
  const cursor = makeReadCursor(READ1);
  const delta = sliceAfterCursor(READ2, cursor);
  assert.ok(delta.length > 0, 'delta must not be empty');
});

test('unchanged pane yields only the live prompt line as residue', () => {
  const cursor = makeReadCursor(READ1);
  const delta = sliceAfterCursor(READ1, cursor);
  assert.ok(delta !== null);
  // Fingerprint excludes the final live line, so re-reading the same pane
  // returns just that line — callers see no meaningful new output.
  assert.deepEqual(delta, ['$']);
});

test('invalid / scrolled-past cursors return null (caller falls back to full tail)', () => {
  assert.equal(sliceAfterCursor(READ2, 'not-base64!!'), null);
  assert.equal(sliceAfterCursor(READ2, Buffer.from('"just a string"').toString('base64')), null);
  const foreign = makeReadCursor(['totally', 'different', 'pane', 'content', 'x']);
  assert.equal(sliceAfterCursor(READ2, foreign), null);
});

test('trimTrailingEmpty removes only trailing blanks', () => {
  assert.deepEqual(trimTrailingEmpty(['a', '', 'b', '', '  ']), ['a', '', 'b']);
  assert.deepEqual(trimTrailingEmpty([]), []);
});
