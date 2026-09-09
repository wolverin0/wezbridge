'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const entry = path.resolve(__dirname, '../scripts/lease-reconcile.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify({ repos: { tmp: { path: 'tmp' } } }));
  fs.writeFileSync(path.join(dir, 'tasks/T-9001.json'), JSON.stringify({
    id: 'T-9001', repo: 'tmp', state: 'running', lease: { owner: 'tmp' } }));
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir } });
  return { code: result.status, report: JSON.parse(result.stdout) };
}

test('T0417 CLI reads actual files and reports counted healthy lease against mocked mux', t => {
  const dir = fixture(t);
  const result = run(dir);
  assert.equal(result.code, 0);
  assert.equal(result.report.census_available, true);
  assert.deepEqual(result.report.counts, { open_leases: 1, verified: 1, unverified: 0 });
  assert.equal(result.report.leases[0].id, 'T-9001');
});

test('T0417 CLI unavailable registry does not disguise a lease as verified', t => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'repos.json'));
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.equal(result.report.registry_available, false);
  assert.equal(result.report.counts.unverified, 1);
});

test('T0417 CLI malformed card is visible and prevents successful exit', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'tasks/T-9002.json'), '{');
  const result = run(dir);
  assert.equal(result.code, 1);
  assert.equal(result.report.task_read_errors.length, 1);
  assert.equal(result.report.counts.verified, 1);
  const missing = run(path.join(dir, 'missing'));
  assert.equal(missing.code, 1);
  assert.equal(missing.report.counts, null);
  assert.match(missing.report.error, /ENOENT/);
});
