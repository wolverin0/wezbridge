'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pane0-watchdog-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP;
const wd = require('../src/pane0-watchdog.cjs');

const NOW = 1_700_000_000_000;
const noRecover = async () => { throw new Error('recover should not run'); };
const okRecover = async () => 99;

beforeEach(() => {
  wd._reset();
  wd.start();
});

test('absent pane inside the 90s grace window → wait, no respawn (close/reopen race)', async () => {
  const r = await wd.check({ now: NOW, beaconMs: NOW - 60_000, paneExists: false, recover: noRecover });
  assert.strictEqual(r.action, 'absent-grace');
});

test('P1 timing gate: absent + silence just past 90s → recovery fires (<2min reachable)', async () => {
  const r = await wd.check({ now: NOW, beaconMs: NOW - wd.ABSENT_STALE_MS - 1000, paneExists: false, recover: okRecover });
  assert.strictEqual(r.action, 'recovered');
  // Worst-case trigger latency = grace window + one check period, under the 2-min gate.
  assert.ok(wd.ABSENT_STALE_MS + wd.CHECK_MS <= 120_000);
});

test('stale beacon but pane present → no respawn (busy/quiet session is not death)', async () => {
  const r = await wd.check({ now: NOW, beaconMs: NOW - wd.STALE_MS - 1000, paneExists: true, recover: noRecover });
  assert.strictEqual(r.action, 'stale-but-present');
});

test('silence AND absent → recovery fires once, then cooldown blocks the next attempt', async () => {
  const r1 = await wd.check({ now: NOW, beaconMs: 0, paneExists: false, recover: okRecover });
  assert.strictEqual(r1.action, 'recovered');
  assert.strictEqual(r1.paneId, 99);
  // 5 minutes later — still stale+absent, but inside the 10-min cooldown.
  const r2 = await wd.check({ now: NOW + 5 * 60_000, beaconMs: 0, paneExists: false, recover: noRecover });
  assert.strictEqual(r2.action, 'cooldown');
  // Past cooldown it may try again.
  const r3 = await wd.check({ now: NOW + wd.COOLDOWN_MS + 60_000, beaconMs: 0, paneExists: false, recover: okRecover });
  assert.match(r3.action, /recovered/);
});

test('a fresh beacon after an attempt resets the consecutive-failure strikes', async () => {
  await wd.check({ now: NOW, beaconMs: 0, paneExists: false, recover: okRecover });
  assert.strictEqual(wd.health().consecutive_failures, 1); // provisional strike
  const r = await wd.check({ now: NOW + wd.COOLDOWN_MS + 1000, beaconMs: NOW + wd.COOLDOWN_MS, paneExists: true, recover: noRecover });
  assert.strictEqual(r.action, 'healthy');
  assert.strictEqual(wd.health().consecutive_failures, 0);
});

test('three consecutive failed recoveries → disabled + unhealthy surfaced, no respawn loop', async () => {
  const boom = async () => { throw new Error('spawn failed'); };
  let t = NOW;
  const r1 = await wd.check({ now: t, beaconMs: 0, paneExists: false, recover: boom });
  assert.strictEqual(r1.action, 'failed');
  t += wd.COOLDOWN_MS + 1000;
  const r2 = await wd.check({ now: t, beaconMs: 0, paneExists: false, recover: boom });
  assert.strictEqual(r2.action, 'failed');
  t += wd.COOLDOWN_MS + 1000;
  const r3 = await wd.check({ now: t, beaconMs: 0, paneExists: false, recover: boom });
  assert.strictEqual(r3.action, 'failed-disabled');
  const h = wd.health();
  assert.strictEqual(h.disabled, true);
  assert.strictEqual(h.unhealthy, true);
  assert.strictEqual(h.consecutive_failures, 3);
  // Disabled: no further attempts ever, even past cooldown.
  t += wd.COOLDOWN_MS + 1000;
  const r4 = await wd.check({ now: t, beaconMs: 0, paneExists: false, recover: noRecover });
  assert.strictEqual(r4.action, 'disabled');
});

test('lastOrchBeaconMs reads newest wezbridge-repo beacon from pane-events.jsonl', () => {
  const now = Date.now();
  const lines = [
    { time: new Date(now - 120_000).toISOString(), repo: 'wezbridge', session: 'a', event: 'turn-end', markers: [] },
    { time: new Date(now - 30_000).toISOString(), repo: 'other', session: 'b', event: 'turn-end', markers: [] },
    { time: new Date(now - 60_000).toISOString(), repo: 'wezbridge', session: 'a', event: 'turn-end', markers: [] },
  ];
  fs.writeFileSync(path.join(TMP, 'pane-events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const got = wd.lastOrchBeaconMs({ now });
  assert.strictEqual(got, Date.parse(lines[2].time)); // newest WEZBRIDGE beacon, not the newer other-repo one
});
