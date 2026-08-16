'use strict';
/**
 * Tests for fleet-board.cjs routineRuns() (T-0142).
 *
 * The property: a healthy routine whose run record uses a RELATIVE
 * findings_file must render its real verdict, never 'no artifact'. The
 * verbatim read resolved against process cwd, so the static board showed a
 * permanent false amber on compliant routines — and board-app inherited the
 * same line by porting it (fixed there first, in commit 7729310). 'no
 * artifact' remains correct ONLY for a genuinely absent file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { routineRuns } = require('../scripts/fleet-board.cjs');

function seed(dir, name, record) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(record, null, 2));
}

test('a relative findings_file resolves against the routine-findings dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));
  fs.writeFileSync(path.join(dir, 'demo-findings.json'), JSON.stringify({ verdict: 'clean' }));
  seed(dir, 'run-demo-wezbridge.json', {
    routine: 'demo', repo: 'wezbridge', exit_status: 0, cadence_hours: 2,
    findings_file: 'demo-findings.json',
  });
  const runs = routineRuns(dir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].verdict, 'clean');
});

test('an absolute findings_file passes through unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));
  const abs = path.join(dir, 'abs-findings.json');
  fs.writeFileSync(abs, JSON.stringify({ verdict: 'findings' }));
  seed(dir, 'run-abs-wezbridge.json', {
    routine: 'abs', repo: 'wezbridge', exit_status: 0, findings_file: abs,
  });
  assert.equal(routineRuns(dir)[0].verdict, 'findings');
});

test("'no artifact' is reserved for a genuinely absent file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));
  seed(dir, 'run-gone-wezbridge.json', {
    routine: 'gone', repo: 'wezbridge', exit_status: 0, findings_file: 'never-written.json',
  });
  assert.equal(routineRuns(dir)[0].verdict, 'no artifact');
});

test('a record with no findings_file at all is also no artifact, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-board-'));
  seed(dir, 'run-bare-wezbridge.json', { routine: 'bare', repo: 'wezbridge', exit_status: 0 });
  assert.equal(routineRuns(dir)[0].verdict, 'no artifact');
});
