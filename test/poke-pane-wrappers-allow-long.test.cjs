'use strict';
/**
 * poke-pane-wrappers-allow-long.test.cjs — T-0473 wiring tripwire (T-0400 convention:
 * a static text-grep assertion, not a behavioral test, because the callers here are
 * non-JS wrappers — scripts/poke-pane.cmd (Task Scheduler entry point) and
 * scripts/wabot-roadmap-monitor.ps1 — that no JS test harness executes directly.
 * poke-pane.cjs enforces a 1200-char payload ceiling (src/poke-payload-ceiling.cjs)
 * and exits 13 unless --allow-long is passed. Both wrappers carry scheduled-job
 * content by design (wabot-roadmap-monitor.prompt.txt alone is 2915 chars, already
 * over the ceiling) so both must opt in with --allow-long or the scheduled task
 * silently starts failing once the ceiling ships. This test only proves the flag
 * string is present in the invocation; it cannot execute .cmd/.ps1 files here.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cmdPath = path.join(__dirname, '..', 'scripts', 'poke-pane.cmd');
const ps1Path = path.join(__dirname, '..', 'scripts', 'wabot-roadmap-monitor.ps1');
const promptPath = path.join(__dirname, '..', 'scripts', 'wabot-roadmap-monitor.prompt.txt');

test('poke-pane.cmd invokes poke-pane.cjs with --allow-long', () => {
  const src = fs.readFileSync(cmdPath, 'utf8');
  const invocation = src.split(/\r?\n/).find((line) => line.includes('poke-pane.cjs'));
  assert.ok(invocation, 'expected a line invoking poke-pane.cjs in poke-pane.cmd');
  assert.match(invocation, /--allow-long\b/, `poke-pane.cmd invocation must pass --allow-long: ${invocation}`);
});

test('wabot-roadmap-monitor.ps1 invokes poke-pane.cjs with --allow-long', () => {
  const src = fs.readFileSync(ps1Path, 'utf8');
  const invocation = src.split(/\r?\n/).find((line) => line.includes('$arguments = @($pokeScript'));
  assert.ok(invocation, 'expected the $arguments = @($pokeScript, ...) line in wabot-roadmap-monitor.ps1');
  assert.match(invocation, /--allow-long/, `wabot-roadmap-monitor.ps1 invocation must pass --allow-long: ${invocation}`);
});

test('wabot-roadmap-monitor.prompt.txt is over the 1200-char ceiling (documents why --allow-long is required)', () => {
  const promptLength = fs.readFileSync(promptPath, 'utf8').length;
  assert.ok(
    promptLength > 1200,
    `expected wabot-roadmap-monitor.prompt.txt > 1200 chars (was ${promptLength}) — this is the reason the monitor wrapper must opt into --allow-long`,
  );
});
