'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'poke-pane.cjs'), 'utf8');

test('scheduled poke writes Enter through stdin and verifies composer clearance', () => {
  assert.match(source, /input:\s*payload/);
  assert.match(source, /sendViaStdin\(target\.pane_id, '\\r', target\._socketEnv\)/);
  assert.match(source, /composerStillHolds\(tail, text\)/);
  assert.match(source, /VERIFIED \(composer cleared\)/);
  assert.match(source, /die\(7, `prompt remained/);
  assert.match(source, /die\(8, `composer verification unavailable/);
});

test('scheduled poke resolves live GUI sockets and never treats echo as proof', () => {
  assert.match(source, /tasklist/);
  assert.match(source, /gui-sock-/);
  assert.match(source, /WEZTERM_UNIX_SOCKET/);
  assert.doesNotMatch(source, /VERIFIED \(echo found in pane\)/);
  assert.doesNotMatch(source, /--no-paste', '\\r'/);
});
