'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SHIM_DIR = path.join(REPO, 'bin', 'guard-shims');
const SEP = process.platform === 'win32' ? ';' : ':';

/**
 * Run a tiny node program that requires guard-bootstrap, then echoes PATH +
 * the bootstrap signal. Inherits parent env (so cmd.exe / bash can resolve
 * `node`), then applies overrides; resets the BOOTSTRAPPED signal so each
 * child sees a fresh state. Uses process.execPath as an absolute reference
 * to avoid shell PATH lookups.
 */
function runChild(envOverrides) {
  const env = { ...process.env, ...envOverrides };
  // Always reset the one-shot bootstrap signal unless the test pins it
  if (!('WEZBRIDGE_GUARD_BOOTSTRAPPED' in envOverrides)) {
    env.WEZBRIDGE_GUARD_BOOTSTRAPPED = '';
  }
  // Default WEZBRIDGE_GUARD_SHIMS off unless the test explicitly sets it
  if (!('WEZBRIDGE_GUARD_SHIMS' in envOverrides)) {
    delete env.WEZBRIDGE_GUARD_SHIMS;
  }
  const code =
    "require('./src/guard-bootstrap.cjs'); " +
    "process.stdout.write(JSON.stringify({ PATH: process.env.PATH || '', BOOT: process.env.WEZBRIDGE_GUARD_BOOTSTRAPPED || '' }))";
  const out = execSync(`"${process.execPath}" -e "${code}"`, {
    cwd: REPO,
    encoding: 'utf8',
    env,
  });
  return JSON.parse(out);
}

test('prepends shim dir when WEZBRIDGE_GUARD_SHIMS=1', () => {
  const r = runChild({ WEZBRIDGE_GUARD_SHIMS: '1' });
  assert.equal(r.PATH.startsWith(SHIM_DIR + SEP), true, `PATH should start with ${SHIM_DIR}, got: ${r.PATH.slice(0, 200)}`);
  assert.equal(r.BOOT, '1');
});

test('no-op when WEZBRIDGE_GUARD_SHIMS unset', () => {
  const r = runChild({}); // no flag
  assert.equal(r.PATH.startsWith(SHIM_DIR + SEP), false);
  assert.equal(r.BOOT, '');
});

test('no-op when WEZBRIDGE_GUARD_SHIMS=0', () => {
  const r = runChild({ WEZBRIDGE_GUARD_SHIMS: '0' });
  assert.equal(r.PATH.startsWith(SHIM_DIR + SEP), false);
  assert.equal(r.BOOT, '');
});

test('idempotent — does not double-prepend', () => {
  // Pre-seed PATH to already contain the shim dir somewhere
  const seededPath = `/some/other/dir${SEP}${SHIM_DIR}${SEP}/usr/bin`;
  const r = runChild({ WEZBRIDGE_GUARD_SHIMS: '1', PATH: seededPath });
  const parts = r.PATH.split(SEP);
  const occurrences = parts.filter((p) => p === SHIM_DIR).length;
  assert.equal(occurrences, 1, `shim dir should appear exactly once, got: ${parts}`);
  assert.equal(parts[0], SHIM_DIR, 'shim dir should be first');
});
