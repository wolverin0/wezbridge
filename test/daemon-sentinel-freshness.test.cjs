'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runSentinel(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-freshness-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, '.daemon-heartbeat.json'), JSON.stringify({ ts: new Date(Date.now() - 42 * 60000).toISOString() }));
  const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/sentinel-observation.cjs'),
    path.join(__dirname, '../scripts/daemon-heartbeat-sentinel.cjs')], {
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir, SENTINEL_FIXTURE_MODE: mode },
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  const pokes = path.join(dir, 'sentinel-pokes.jsonl');
  const log = path.join(dir, 'evidence/wezbridge/daemon-sentinel.jsonl');
  return { ...result, pokes: fs.existsSync(pokes) ? fs.readFileSync(pokes, 'utf8') : '',
    evidence: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

for (const mode of ['during-probe', 'during-discovery']) {
  test(`T-0379 AC4 killer: recovery ${mode} suppresses a stale restart alert in the real sentinel`, t => {
    const result = runSentinel(t, mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.pokes, '', 'a fresh heartbeat at delivery time must not request a restart');
    assert.match(result.evidence, /recovered-before-alert/, 'the past outage must remain distinguishable from a current one');
  });
}

test('T-0379 AC4 control: a currently stale heartbeat still alerts even if HTTP answers', t => {
  const result = runSentinel(t, 'still-stale');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.pokes, /DAEMON WEDGED/);
});

test('T-0379 AC4 control: a heartbeat that disappears is not recovery and does not crash the sentinel', t => {
  const result = runSentinel(t, 'missing-during-probe');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.pokes, /DAEMON WEDGED/);
  assert.doesNotMatch(result.evidence, /recovered-before-alert/);
});
