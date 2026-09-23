// T-0419: scripts/waker-gate.cjs must separate "consumer not consuming"
// (attempt cap / unverified twice — a poke WAS attempted against a live
// pane) from "destination unreachable" (target-unreachable — no poke was
// ever attempted, the pane itself vanished/stayed unknown) in its RED
// output. Before this, both printed under the same "hit the attempt cap"
// header, which sent the operator to inspect delivery when the real fault
// was the destination. Same mkIntel/runGate harness as
// waker-consumer-can-fail.test.cjs (isolated tmp intel dir per test).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'scripts', 'waker-gate.cjs');

function runGate(intelDir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: { ...process.env, WEZBRIDGE_INTEL_DIR: intelDir, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function mkIntel(cfg, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-gate-unreachable-'));
  if (cfg !== undefined) fs.writeFileSync(path.join(dir, 'orch-waker.json'), JSON.stringify(cfg));
  if (state) {
    const sd = path.join(dir, '.orch-waker-state');
    fs.mkdirSync(sd);
    for (const [name, val] of Object.entries(state)) {
      fs.writeFileSync(path.join(sd, `${name}.json`), JSON.stringify(val));
    }
  }
  return dir;
}

const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

test('GATE RED: target-unreachable flag prints DESTINATION UNREACHABLE, not attempt-cap language', () => {
  const dir = mkIntel({ enabled: true, repos: ['walksim'] }, {
    pending: {},
    flags: {
      dead1: {
        repo: 'walksim',
        flagged_at: minsAgo(2),
        reason: 'target-unreachable: pane 0 (wezbridge) not idle for 30min (status=unknown), window=30min',
      },
    },
  });
  const r = runGate(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /DESTINATION UNREACHABLE/, 'must call out the destination, not the consumer');
  assert.match(r.out, /target-unreachable/);
  assert.match(r.out, /pane 0/, 'must name the pane');
  assert.doesNotMatch(r.out, /CONSUMER NOT CONSUMING/, 'a pure destination-unreachable batch must not also claim consumer failure');
});

test('GATE RED: attempt-cap flag (no reason) still prints CONSUMER NOT CONSUMING with the word "attempt cap"', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, {
    pending: {},
    flags: { dead1: { repo: 'x', flagged_at: minsAgo(5) } },
  });
  const r = runGate(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /CONSUMER NOT CONSUMING/);
  assert.match(r.out, /attempt cap/);
  assert.doesNotMatch(r.out, /DESTINATION UNREACHABLE/);
});

test('GATE RED: a mixed batch (both kinds of flag) prints BOTH sections, each with its own count', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, {
    pending: {},
    flags: {
      unreach1: { repo: 'x', flagged_at: minsAgo(1), reason: 'target-unreachable: pane 3 (x) not idle for 30min (status=unknown), window=30min' },
      cap1: { repo: 'x', flagged_at: minsAgo(1), reason: 'attempt cap reached — poke undeliverable, needs a human look' },
      unverified1: { repo: 'x', flagged_at: minsAgo(1), reason: 'unverified twice: composer unreadable (pane 3)' },
    },
  });
  const r = runGate(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /DESTINATION UNREACHABLE/);
  assert.match(r.out, /1 intent\(s\) flagged: DESTINATION UNREACHABLE/);
  assert.match(r.out, /CONSUMER NOT CONSUMING/);
  assert.match(r.out, /2 intent\(s\) flagged: CONSUMER NOT CONSUMING/);
});
