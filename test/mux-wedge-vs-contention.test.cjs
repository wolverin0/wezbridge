// A busy mux and a wedged mux fail IDENTICALLY on the normal path, and the
// remedies are opposite: one needs patience, the other needs a WezTerm restart
// that kills every live pane. On 2026-08-18 bridge_health reported
// `reachable: false` on a loaded box while three panes were mid-task; a direct
// CLI call 30s later answered in 191ms. Acting on that report would have
// destroyed a working swarm to cure a traffic jam.
//
// These tests pin the rule that keeps them apart. They are pure — the only way
// to produce a genuinely wedged mux is to wedge the machine everyone is
// working on, so the classifier must be testable without one.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const wez = require('../src/wezterm.cjs');

const TIMEOUT_ERR = 'wezterm cli list --format json failed: spawnSync C:/Program Files/WezTerm/wezterm.exe ETIMEDOUT';

test('a late answer is contention, and must NOT be reported as unreachable', () => {
  const v = wez.classifyMuxProbe({
    fastError: TIMEOUT_ERR,
    confirm: { ok: true, elapsed_ms: 191, pane_count: 11 },
  });
  assert.equal(v.reachable, true, 'the mux answered — it is reachable, just slow');
  assert.equal(v.degraded, true, 'but the caller must still learn it was slow');
  assert.equal(v.pane_count, 11);
  assert.match(v.note, /slow/i);
});

test('a contention verdict actively warns against restarting WezTerm', () => {
  // The dangerous move is a restart, and the operator reads this string and
  // nothing else. If the warning ever gets dropped, this fails.
  const v = wez.classifyMuxProbe({
    fastError: TIMEOUT_ERR,
    confirm: { ok: true, elapsed_ms: 8000, pane_count: 3 },
  });
  assert.match(v.note, /do NOT restart/i, 'must tell the reader not to restart');
  assert.ok(!('diagnosis' in v), 'must not carry a wedge diagnosis when the mux answered');
});

test('total silence is reported as INCONCLUSIVE, never as a confident wedge', () => {
  // The trap this pins: on 2026-08-18 a merely-busy mux went silent past a 25s
  // budget while every pane was healthy, and the same mux had answered in
  // 191ms minutes before. A single reading cannot separate wedge from
  // contention, so the verdict must not pretend otherwise.
  const v = wez.classifyMuxProbe({
    fastError: TIMEOUT_ERR,
    confirm: { ok: false, elapsed_ms: 45000, error: TIMEOUT_ERR },
  });
  assert.equal(v.reachable, false);
  assert.equal(v.inconclusive, true, 'one sample is never conclusive');
  assert.match(v.diagnosis, /contention/i, 'must name contention as a live alternative');
  assert.match(v.diagnosis, /again|repeat/i, 'must tell the reader to take a second reading');
});

test('the restart is gated behind a REPEATED reading, not a single one', () => {
  const v = wez.classifyMuxProbe({
    fastError: TIMEOUT_ERR,
    confirm: { ok: false, elapsed_ms: 45000, error: TIMEOUT_ERR },
  });
  // "only after repeated..." — the destructive act must never read as the
  // immediate next step from one health call.
  assert.match(v.diagnosis, /only after repeated/i,
    'restarting must be conditioned on more than this one observation');
});

test('even then it points at the way back, not just at the restart', () => {
  // Per the decision contract: an irreversible action gets its reversal path
  // built before it is recommended. A restart without a snapshot loses the
  // pane layout, so the diagnosis must name the recovery.
  const v = wez.classifyMuxProbe({
    fastError: TIMEOUT_ERR,
    confirm: { ok: false, elapsed_ms: 45000, error: TIMEOUT_ERR },
  });
  assert.match(v.diagnosis, /snapshot/i, 'must mention checking a session snapshot');
  assert.match(v.diagnosis, /restore-session/, 'must name the restore command');
  assert.match(v.diagnosis, /kill|destroy/i, 'must state the cost of the restart');
});

test('a non-timeout failure is surfaced verbatim, not dressed up as a mux verdict', () => {
  // A missing binary is not a wedge and not contention. Diagnosing it as
  // either would send someone to restart a terminal over a PATH problem.
  const v = wez.classifyMuxProbe({ fastError: 'spawnSync wezterm.exe ENOENT', confirm: null });
  assert.equal(v.reachable, false);
  assert.equal(v.error, 'spawnSync wezterm.exe ENOENT');
  assert.ok(!('diagnosis' in v), 'no wedge claim for a non-timeout failure');
  assert.ok(!('degraded' in v));
});

test('probeMux reports elapsed time on both paths so slowness is measurable', () => {
  // Against the real mux: whatever the verdict, the caller must be able to say
  // HOW slow. A boolean cannot distinguish 200ms from 20s.
  const r = wez.probeMux({ timeoutMs: 25000 });
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.elapsed_ms, 'number');
  assert.ok(r.elapsed_ms >= 0);
  if (r.ok) assert.ok(r.pane_count === null || typeof r.pane_count === 'number');
  else assert.equal(typeof r.error, 'string');
});
