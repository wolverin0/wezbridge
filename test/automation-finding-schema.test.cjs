'use strict';
/**
 * automation-finding-schema.test.cjs — T-0598 Fase A. Validates
 * src/automation-finding-schema.cjs: required fields, fingerprint derivation
 * (explicit vs derived) and normalization used for dedupe.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFinding, computeFingerprint, normalizeSummary } = require('../src/automation-finding-schema.cjs');

function validFinding(overrides = {}) {
  return {
    task: 'daemon-sentinel', repo_owner: 'wezbridge', actionable: true,
    summary: 'daemon down 3 checks', evidence: 'deadman-touch.json stale 20min', severity: 'high', ...overrides,
  };
}

test('validateFinding accepts a well-formed finding', () => {
  const res = validateFinding(validFinding());
  assert.equal(res.ok, true);
});

test('validateFinding rejects missing repo_owner', () => {
  const f = validFinding(); delete f.repo_owner;
  const res = validateFinding(f);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(';'), /repo_owner/);
});

test('validateFinding rejects a non-boolean actionable', () => {
  const res = validateFinding(validFinding({ actionable: 'yes' }));
  assert.equal(res.ok, false);
});

test('validateFinding rejects an unknown severity', () => {
  const res = validateFinding(validFinding({ severity: 'urgent' }));
  assert.equal(res.ok, false);
});

test('computeFingerprint uses the explicit fingerprint verbatim when present', () => {
  const fp = computeFingerprint(validFinding({ fingerprint: 'svc-1234' }));
  assert.equal(fp, 'svc-1234');
});

test('computeFingerprint derives a stable hash from task+normalized summary', () => {
  const a = computeFingerprint(validFinding({ summary: '  Daemon Down  3 checks  ' }));
  const b = computeFingerprint(validFinding({ summary: 'daemon down 3 checks' }));
  assert.equal(a, b, 'whitespace/case differences in summary must not change the fingerprint');
});

test('computeFingerprint differs for different tasks with the same summary', () => {
  const a = computeFingerprint(validFinding({ task: 'daemon-sentinel' }));
  const b = computeFingerprint(validFinding({ task: 'gmail-recordatorios' }));
  assert.notEqual(a, b);
});

test('normalizeSummary trims, lowercases and collapses whitespace', () => {
  assert.equal(normalizeSummary('  Foo   Bar\n\tBaz '), 'foo bar baz');
});
