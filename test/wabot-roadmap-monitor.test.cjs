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
  // Was asserting the literal `(?<!UN)VERIFIED \(echo found in pane\)`, which
  // went stale when delivery moved from echo-detection to composer-clearance:
  // red test, correct script. Worse, a string match cannot tell whether the
  // negative lookbehind actually works — the whole point of the pattern.
  //
  // So: extract the pattern the script really uses and RUN it. PowerShell and
  // JavaScript share this regex syntax, so the behaviour is genuinely testable.
  const line = script.split(/\r?\n/).find((l) => l.includes('$deliveryVerified'));
  assert.ok(line, 'no delivery-verification line found at all');
  const [, pattern] = line.match(/-match\s+'(.+)'\s*$/) || [];
  assert.ok(pattern, `could not extract the delivery pattern from: ${line}`);

  const rx = new RegExp(pattern);
  assert.match('poke-pane OK: 182 chars -> pane 7 — VERIFIED (composer cleared)', rx);
  assert.doesNotMatch('poke-pane: UNVERIFIED (composer cleared)', rx,
    'UNVERIFIED must not read as delivered — the lookbehind is the whole guard');
  assert.doesNotMatch('poke-pane: VERIFIED (echo found in pane)', rx,
    'echo in the pane is not delivery proof');
  assert.doesNotMatch('VERIFIED', rx, 'a bare VERIFIED must not satisfy the check');
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
