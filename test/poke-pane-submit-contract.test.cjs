'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'poke-pane.cjs'), 'utf8');
const monitorSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'wabot-roadmap-monitor.ps1'), 'utf8');

test('scheduled poke writes Enter through stdin and verifies composer clearance', () => {
  assert.match(source, /input:\s*payload/);
  assert.match(source, /sendViaStdin\(target\.pane_id, '\\r'\)/);
  assert.match(source, /composerStillHolds\(tail, text\)/);
  assert.match(source, /VERIFIED \(composer cleared\)/);
  assert.match(source, /die\(7, `prompt remained/);
});

test('scheduled poke never treats visible echo as submission proof', () => {
  assert.doesNotMatch(source, /VERIFIED \(echo found in pane\)/);
  assert.doesNotMatch(source, /--no-paste', '\\r'/);
  assert.equal(monitorSource.includes('VERIFIED \\(echo found in pane\\)'), false);
  assert.equal(monitorSource.includes('VERIFIED \\(composer cleared\\)'), true);
});
