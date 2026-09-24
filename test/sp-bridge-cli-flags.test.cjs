'use strict';
/**
 * T-0577 — sp-bridge CLI parse(): boolean flags must not swallow the next token.
 * Bug: a bare trailing `--confirm` (e.g. `cleanup-act-links --confirm`) set
 * opts.confirm = undefined (argv[i+1] out of range), so the CLI silently took
 * the dry-run branch instead of the live-write branch — operator believed it
 * had applied. AC1 proves the CLI branch decision via parse() output alone
 * (no SP, no client): opts.confirm === true for a bare trailing --confirm.
 * AC2 covers --confirm true (back-compat) and that value flags (--ext, --at,
 * --notes, --by, --task, --verb, --until, --due) still consume the next token.
 * AC3 covers the exact dry-run message text.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const sp = require('../scripts/sp-bridge.cjs');

test('AC1: bare trailing --confirm is true (RED on origin/main: was undefined)', () => {
  const { opts } = sp.parse(['cleanup-act-links', '--confirm']);
  assert.equal(opts.confirm, true);
});

test('AC2: --confirm true still works (back-compat)', () => {
  const { opts } = sp.parse(['cleanup-act-links', '--confirm', 'true']);
  assert.equal(opts.confirm, true);
});

test('AC2: --confirm false is falsy', () => {
  const { opts } = sp.parse(['cleanup-act-links', '--confirm', 'false']);
  assert.equal(opts.confirm, false);
});

test('AC2: value flags still consume the next token', () => {
  const { opts, pos } = sp.parse(['task', 'proj', 'title', '--ext', 'abc123', '--notes', 'hola', '--due', '2026-01-01']);
  assert.equal(opts.ext, 'abc123');
  assert.equal(opts.notes, 'hola');
  assert.equal(opts.due, '2026-01-01');
  assert.deepEqual(pos, ['task', 'proj', 'title']);
});

test('AC2: bare boolean flag mid-argv does not eat the following positional/value flag', () => {
  const { opts, pos } = sp.parse(['cleanup-act-links', '--confirm', 'extra']);
  // "--confirm" bare (no boolean-parseable next token) => true, and "extra" is positional.
  assert.equal(opts.confirm, true);
  assert.deepEqual(pos, ['cleanup-act-links', 'extra']);
});

test('AC3: dry-run output states the exact message', () => {
  const intelDir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'sp-intel-'));
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'sp-bridge.cjs'), 'cleanup-act-links'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: intelDir },
  }).toString();
  assert.match(out, /DRY-RUN: nothing written \(use --confirm\)/);
});
