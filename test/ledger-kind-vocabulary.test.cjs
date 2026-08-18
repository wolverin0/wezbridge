'use strict';
/**
 * The closed kind vocabulary has to hold at the WRITE path, not only in an audit.
 *
 * intel-registries.test.cjs asserts that every kind on the board is in
 * kinds.json. That test went red on 2026-08-17 and stayed red, because nothing
 * stopped the kinds getting there: `fleetMinimumGate()` returns null for an
 * unknown kind exactly as it does for a genuinely ungated one, so an invented
 * slug took no gate and raised no warning. Thirteen tasks were created that way
 * (`test-infra`, `architecture`, `process`, `fleet-infra`) before anyone noticed.
 *
 * kinds.json has always declared the intended behaviour — "unknown slugs are
 * never honoured silently" — it simply had no implementation. An audit that
 * detects a breach nothing prevents is a report, not a gate.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LEDGER = path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const REAL_INTEL = path.join(__dirname, '..', '..', '_intel');

/** A throwaway ledger carrying the REAL vocabulary — never the real task files. */
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-kinds-'));
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(REAL_INTEL, 'kinds.json'), path.join(d, 'kinds.json'));
  return d;
}

function createTask(dir, kind) {
  return execFileSync(process.execPath, [
    LEDGER, 'create', '--title', 'probe', '--goal', 'probe', '--kind', kind,
  ], { env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir }, encoding: 'utf8', stdio: 'pipe' });
}

test('creating a task with a kind outside the vocabulary is REFUSED', () => {
  const dir = sandbox();
  try {
    assert.throws(() => createTask(dir, 'test-infra'), /unknown kind/i,
      'an invented slug must not reach the board');
    assert.strictEqual(fs.readdirSync(path.join(dir, 'tasks')).length, 0,
      'and nothing may be written when it is refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the refusal names the vocabulary so the caller can fix it without reading source', () => {
  const dir = sandbox();
  try {
    let msg = '';
    try { createTask(dir, 'fleet-infra'); } catch (e) { msg = (e.stderr || '') + (e.stdout || ''); }
    assert.match(msg, /test-repair/, 'the error must list the kinds that ARE allowed');
    assert.match(msg, /kinds\.json/, 'and say where the vocabulary lives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a REAL kind still creates normally — the guard must not seal the door shut', () => {
  // The other half of the planted pair. A guard that refuses everything would
  // pass the test above while breaking the ledger entirely.
  const dir = sandbox();
  try {
    createTask(dir, 'test-repair');
    const files = fs.readdirSync(path.join(dir, 'tasks'));
    assert.strictEqual(files.length, 1, 'a valid kind must still produce a task');
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', files[0]), 'utf8'));
    assert.strictEqual(t.kind, 'test-repair');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no kinds.json at all the ledger still works — the registry is not a dependency', () => {
  // Fail-closed on an unknown kind must not become fail-closed on a checkout
  // that has no registry: this repo is used without the fleet _intel dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-nokinds-'));
  try {
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    createTask(dir, 'anything-at-all');
    assert.strictEqual(fs.readdirSync(path.join(dir, 'tasks')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
