'use strict';
/**
 * poke-pane submit contract (source-level, cheap): the shape that keeps the
 * scheduled poke honest. Behaviour lives in composer-state.test.cjs (unit) and
 * poke-pane-one-prompt.test.cjs (live, against a TUI double).
 * T-0303 (2026-09-02): the verifier is IMPORTED from composer-state.cjs (no
 * private copy), integrity is checked BEFORE Enter (exit 9), a composer holding
 * someone else's text is refused before writing (exit 10), and multi-line
 * payloads are flattened to one line with the log saying so.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'poke-pane.cjs'), 'utf8');

test('scheduled poke writes Enter through stdin as a SEPARATE write and verifies composer clearance', () => {
  assert.match(source, /input:\s*payload/);
  assert.match(source, /sendViaStdin\(target\.pane_id, '\\r', target\._socketEnv\)/);
  assert.match(source, /composerStillHolds\(tail, payload\)/);
  assert.match(source, /VERIFIED \(paste \$\{landed\}, composer cleared\)/);
  assert.match(source, /die\(7, `prompt remained/);
  assert.match(source, /die\(8, `composer verification unavailable/);
});

test('T-0303: one verifier (imported), integrity before Enter, foreign-text refusal, flatten declared in the log', () => {
  assert.match(source, /require\('\.\/composer-state\.cjs'\)/, 'the verifier must be the shared module');
  assert.doesNotMatch(source, /^function composerStillHolds/m, 'no private copy of the verifier (that is how the fix reaches one caller only)');
  assert.match(source, /pasteLandedIntact\(readTail\(\), payload\)/, 'integrity is read from the live composer BEFORE Enter');
  assert.match(source, /die\(9, `paste did not land as ONE prompt/);
  assert.match(source, /composerHoldsForeignText\(before\)/);
  assert.match(source, /die\(10, `pane \$\{target\.pane_id\} composer already holds unsent text/);
  assert.match(source, /poke-pane FLATTENED: \$\{lineCount\} lines -> 1 line/, 'flattening must be said out loud in the log');
  assert.match(source, /noPaste: false/, 'the payload goes in as a paste (one write), not typed key by key');
});

test('scheduled poke resolves live GUI sockets and never treats echo as proof', () => {
  assert.match(source, /tasklist/);
  assert.match(source, /gui-sock-/);
  assert.match(source, /WEZTERM_UNIX_SOCKET/);
  assert.doesNotMatch(source, /VERIFIED \(echo found in pane\)/);
  assert.doesNotMatch(source, /--no-paste', '\\r'/);
});

test('T-0303 AC6: the fix is not a bigger timeout or added sleeps', () => {
  const timeouts = [...source.matchAll(/timeout:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(timeouts.every((t) => t <= 20000), `a timeout grew past 20000ms: ${timeouts}`);
  const pauses = [...source.matchAll(/pause\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(pauses, [700, 700, 900], `the settle waits are the three that existed (700 after paste, 700 after Enter, 900 after retry), not new sleeps: ${pauses}`);
});
