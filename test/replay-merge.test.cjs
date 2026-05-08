'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { summarizeDiffStat, extractConflicts } = require(
  path.resolve(__dirname, '..', 'scripts', 'replay-merge.cjs'),
);

// summarizeDiffStat -------------------------------------------------

test('summarizeDiffStat: empty input', () => {
  assert.equal(summarizeDiffStat(''), '(no diff)');
  assert.equal(summarizeDiffStat(undefined), '(no diff)');
});

test('summarizeDiffStat: trims + drops blank lines', () => {
  const stat = '\n  src/a.js | 5 +++--\n  src/b.js | 3 +++\n\n 2 files changed\n';
  const out = summarizeDiffStat(stat);
  assert.match(out, /src\/a\.js \| 5 \+\+\+--/);
  assert.match(out, /src\/b\.js \| 3 \+\+\+/);
  assert.match(out, /2 files changed/);
  assert.equal(out.split('\n').length, 3);
});

// extractConflicts --------------------------------------------------

test('extractConflicts: no conflicts → []', () => {
  assert.deepEqual(extractConflicts(''), []);
  assert.deepEqual(extractConflicts(' M src/clean.js\n?? new.txt\n'), []);
});

test('extractConflicts: detects UU lines (both modified)', () => {
  const out = 'UU src/conflict.js\n M src/clean.js\nUU README.md\n';
  assert.deepEqual(extractConflicts(out), ['src/conflict.js', 'README.md']);
});

test('extractConflicts: detects all conflict status codes', () => {
  const codes = ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'];
  const out = codes.map((c, i) => `${c} file${i}.js`).join('\n');
  const parsed = extractConflicts(out);
  assert.equal(parsed.length, codes.length);
  for (let i = 0; i < codes.length; i++) {
    assert.equal(parsed[i], `file${i}.js`);
  }
});

test('extractConflicts: ignores non-conflict status', () => {
  const out = ' M tracked.js\n?? untracked.js\nM  staged.js\nA  added.js\nUU real-conflict.js\n';
  assert.deepEqual(extractConflicts(out), ['real-conflict.js']);
});

test('extractConflicts: handles paths with spaces', () => {
  const out = 'UU src/has space.js\n';
  assert.deepEqual(extractConflicts(out), ['src/has space.js']);
});
