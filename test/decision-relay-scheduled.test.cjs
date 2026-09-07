'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadRuns, auditRoutines, boardVerdict } = require('../scripts/routine-audit.cjs');
const { evaluate } = require('../scripts/steward-gate.cjs');

test('scheduled relay exit 1 remains visible to the real routine reader and gate after a clean run', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scheduled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (mode) => spawnSync(process.execPath, ['--require',
    path.join(__dirname, 'fixtures/decision-relay-result.cjs'),
    path.join(__dirname, '../scripts/decision-relay.cjs'), '--once', '--json'], {
    encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir, RELAY_TEST_RESULT: mode },
  });
  const failed = run('flagged');
  assert.equal(failed.status, 1, failed.stderr);
  const output = JSON.parse(failed.stdout);
  assert.equal(output.flagged[0].task, 'T-0351');
  let runs = loadRuns(path.join(dir, 'routine-findings'));
  assert.ok(runs.some(r => r.exit_status === 1 && r.findings.flagged[0].task === 'T-0351'),
    'exit 1 JSON must have a real consumer, not disappear with the hidden console');
  const clean = run('clean');
  assert.equal(clean.status, 0, clean.stderr);
  runs = loadRuns(path.join(dir, 'routine-findings'));
  assert.ok(runs.some(r => r.exit_status === 1), 'next clean pass must preserve unresolved failure evidence');
  assert.ok(runs.some(r => boardVerdict(r) === 'clean'), 'positive control publishes a clean run');
  const findings = auditRoutines(dir, Date.now() + 49 * 3600000);
  assert.equal(evaluate({ findings, rulings: [], now: Date.now() + 49 * 3600000 }).verdict, 'RED');
  const fatal = run('fatal');
  assert.equal(fatal.status, 1);
  assert.ok(loadRuns(path.join(dir, 'routine-findings')).some(r => r.findings?.error === 'fixture fatal'));
});
