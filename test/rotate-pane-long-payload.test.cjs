'use strict';
/**
 * T-0473 follow-up: rotate-pane's poke-payload ceiling regression.
 *
 * scripts/poke-pane.cjs refuses (exit 13) any payload over
 * POKE_PAYLOAD_CEILING (1200 chars, src/poke-payload-ceiling.cjs) unless the
 * caller passes --allow-long. rotate-pane.cjs never passed it, so its
 * payload-carrying dispatch (--next) and post-/clear resume prompt hard-abort
 * (die(4)/die(7)) on any real-world envelope over 1200 chars — measured: 4 of
 * the last 20 real _intel/turns payloads (1379/1439/1699/3737 chars) exceed
 * the ceiling. rotate-pane already gates delivery on its own /clear
 * interlock and composer-integrity checks in poke-pane, so it is the caller
 * that "accepts the risk" per poke-payload-ceiling's own contract.
 *
 * This drives the REAL rotate-pane.cjs -> REAL poke-pane.cjs subprocess chain
 * against the shared wezterm-mock (test/setup.cjs's mockPath, intercepted via
 * NODE_OPTIONS propagation into both child processes) so the ceiling check
 * actually fires — no fake-send seam here, that would bypass poke-pane
 * entirely and prove nothing about this regression.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'rotate-pane.cjs');
const MOCK_WEZTERM = path.join(ROOT, 'test', 'mocks', 'wezterm-mock.cjs');
const LONG_PAYLOAD = `${'x'.repeat(1400)} done`; // over POKE_PAYLOAD_CEILING (1200)

function runRotate(nextText) {
  const nextFile = path.join(os.tmpdir(), `rotate-long-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(nextFile, nextText);
  const r = spawnSync(process.execPath, [SCRIPT, '--project', 'tmp', '--mode', 'compact', '--next', nextFile], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, WEZTERM_BIN: MOCK_WEZTERM, WEZBRIDGE_CLEAR_SETTLE_MS: '10' },
  });
  fs.rmSync(nextFile, { force: true });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('T-0473: a >1200-char dispatch payload must not hit the poke-pane ceiling refusal', () => {
  const r = runRotate(LONG_PAYLOAD);
  assert.ok(
    !/FAIL\(13\)/.test(r.out) && !/exit 13/.test(r.out),
    `rotate-pane's dispatch was refused by poke-pane's payload ceiling (needs --allow-long): ${r.out}`,
  );
});

test('control: a short control payload (/compact) is unaffected', () => {
  // The compact prompt itself (no --next) must keep behaving exactly as before:
  // short, no ceiling anywhere near it.
  const r = spawnSync(process.execPath, [SCRIPT, '--project', 'tmp', '--mode', 'compact'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, WEZTERM_BIN: MOCK_WEZTERM, WEZBRIDGE_CLEAR_SETTLE_MS: '10' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(!/FAIL\(13\)/.test(out), `unexpected ceiling refusal on a short control poke: ${out}`);
});
