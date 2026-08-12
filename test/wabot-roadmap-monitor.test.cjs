'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const script = fs.readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'wabot-roadmap-monitor.ps1'),
  'utf8',
);

test('roadmap monitor rejects UNVERIFIED as delivery success', () => {
  assert.ok(script.includes("(?<!UN)VERIFIED \\(echo found in pane\\)"));
  assert.doesNotMatch(script, /-match ['"]VERIFIED['"]/);
});

test('roadmap monitor cannot spawn panes or launch an AI CLI', () => {
  const executableLines = script
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(executableLines, /spawn_session|spawn-in-workspace|wezterm-mux-server|claude(?:\.cmd)?|codex(?:\.cmd)?/i);
  assert.match(script, /--tab-title', 'wabot'/);
});

test('status advances only after verified delivery', () => {
  const verifiedPoke = script.indexOf("if ($pokeResult -eq 'verified')");
  const statusWrite = script.indexOf('$state.lastVerifiedPokeAt = $now.ToString');
  assert.ok(verifiedPoke >= 0);
  assert.ok(statusWrite > verifiedPoke);
});

test('an accepted queue is throttled separately from verified execution', () => {
  assert.match(script, /lastPokeAttemptAt/);
  assert.match(script, /'enqueued'/);
  assert.match(script, /\$pokeResult -ne 'failed'/);
});

test('scheduled terminal message stays short and delegates details to the prompt file', () => {
  assert.match(script, /AUTOMATED_ROADMAP_POKE/);
  assert.match(script, /Read and execute \$promptReference/);
  assert.doesNotMatch(script, /\$basePrompt = Get-Content/);
});
