'use strict';
/**
 * setup-wezterm-bin-isolation.test.cjs — T-0400 fix-up.
 *
 * WEZBRIDGE_WEZTERM_BIN is the SAME env var production code (src/wezterm.cjs)
 * reads to find the real wezterm binary. test/setup.cjs must therefore NEVER
 * let an ambient value (e.g. a developer's real wezterm.exe left set in their
 * shell from manual debugging) leak into `npm test` — a test that spawns
 * mcp-server.cjs/poke-pane.cjs as a child would otherwise drive the REAL
 * wezterm and could type into live panes.
 *
 * Repro (measured): `WEZBRIDGE_WEZTERM_BIN=/nonexistent/fake-wezterm-9999.exe
 * npm test` produced 14 failures on the branch that made setup.cjs respect a
 * pre-set value, vs 1-2 on origin/main which always clobbers it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SETUP = path.join(__dirname, 'setup.cjs');
const DEFAULT_MOCK = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');

test('setup.cjs never lets an ambient WEZBRIDGE_WEZTERM_BIN reach a test child', () => {
  const bogus = '/nonexistent/fake-wezterm-9999.exe';
  const out = execFileSync(process.execPath, [
    '--require', SETUP.replace(/\\/g, '/'),
    '-e', 'process.stdout.write(String(process.env.WEZBRIDGE_WEZTERM_BIN))',
  ], {
    env: { ...process.env, WEZBRIDGE_WEZTERM_BIN: bogus },
    encoding: 'utf8',
  }).trim();

  assert.notEqual(out, bogus, 'an ambient WEZBRIDGE_WEZTERM_BIN must never survive setup.cjs');
  assert.equal(out, DEFAULT_MOCK, 'setup.cjs must fall back to the default mock');
});

// T-0567: scripts/poke-pane.cjs (and rotate-pane / others) read the PLAIN
// `WEZTERM_BIN` var, not `WEZBRIDGE_WEZTERM_BIN`. setup.cjs never touched
// WEZTERM_BIN, so an ambient value pointing at a real wezterm binary was
// inherited by any test that spawns those scripts without overriding it
// itself — risking a live pane being driven by the suite.
test('setup.cjs never lets an ambient WEZTERM_BIN reach a test child', () => {
  const bogus = '/nonexistent/real-wezterm.exe';
  const out = execFileSync(process.execPath, [
    '--require', SETUP.replace(/\\/g, '/'),
    '-e', 'process.stdout.write(String(process.env.WEZTERM_BIN))',
  ], {
    env: { ...process.env, WEZTERM_BIN: bogus },
    encoding: 'utf8',
  }).trim();

  assert.notEqual(out, bogus, 'an ambient WEZTERM_BIN must never survive setup.cjs');
  assert.equal(out, DEFAULT_MOCK, 'setup.cjs must force WEZTERM_BIN to the mock too');
});
