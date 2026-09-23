/**
 * waker-target-unreachable.test.cjs — T-0419. deliverPending() returned early
 * on a non-idle target BEFORE touching any intent's attempts (src/orchestrator
 * -waker.cjs ~L619), so a target that is permanently 'unknown' (dead selector,
 * pane gone) let pending intents pile up forever: the maxAttempts cap and the
 * flags.json writer never fired because they live downstream of a poke that
 * was never attempted. scripts/waker-gate.cjs still went RED by age, but its
 * text ("pokes produced and not consumed") blames the CONSUMER when the real
 * fault is the DESTINATION. These tests pin: (1) an 'unknown' target gets its
 * pending intents flagged with a destination-named reason after a bounded,
 * configurable window: (2) a target that is merely 'working' (briefly OR for
 * a long burst) is never flagged that way — busy is alive, unreachable is not
 * — matching the card's intent that this is not "flag any non-idle pane".
 * Isolated tmp state dir per test; never touches the real _intel.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWaker, DEFAULTS } = require('../src/orchestrator-waker.cjs');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-unreachable-'));
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(eventsPath, '');
  return { dir, eventsPath, stateDir };
}

function beacon(env, evt) {
  fs.appendFileSync(env.eventsPath, `${JSON.stringify(evt)}\n`);
}

function fakeSend() {
  const calls = [];
  return {
    calls,
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
  };
}

function readFlags(w) {
  try { return JSON.parse(fs.readFileSync(w._files.flags, 'utf8')); } catch { return {}; }
}

const TARGET_ID = 0;

function makeWaker(env, over = {}) {
  let nowMs = over.startNow ?? 1_000_000;
  const clock = { get: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const w = createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: over.discoverPanes || (() => [{ paneId: TARGET_ID, project: 'G:/Py Apps/wezbridge', title: 'orch', status: over.status || 'unknown' }]),
    send: over.send || fakeSend(),
    settleTicks: over.settleTicks ?? 1,
    cooldownMs: over.cooldownMs ?? 0,
    debounceMs: over.debounceMs ?? 0,
    maxAttempts: over.maxAttempts ?? 3,
    unreachableWindowMs: over.unreachableWindowMs,
    now: () => clock.get(),
    log: over.log || (() => {}),
    watchRepos: over.watchRepos || ['walksim'],
  });
  return { w, clock };
}

// ── AC1/AC2: the bug, made executable ───────────────────────────────────────

test('target stuck at status "unknown" for the window: pending intent leaves pending and is flagged with a destination-named reason', async () => {
  const env = makeEnv();
  const WINDOW = 5000;
  const { w, clock } = makeWaker(env, { status: 'unknown', unreachableWindowMs: WINDOW });
  beacon(env, { repo: 'walksim', session: 's', time: new Date(1_000_000).toISOString(), event: 'turn-end' });

  // N ticks spanning the window, target never idle.
  for (let i = 0; i < 6; i++) {
    await w.tick();
    clock.advance(1200);
  }

  const pendingCount = Object.keys(w._state.pending).length;
  const flags = readFlags(w);
  const flagIds = Object.keys(flags);

  // This is the AC1 red assertion against origin/main HEAD (pre-fix): pending
  // never drains and flags.json stays empty because deliverPending returns
  // before touching the intent at all. Post-fix both flip.
  assert.equal(pendingCount, 0, 'intent must leave pending once the target has been unreachable for the window');
  assert.equal(flagIds.length, 1, 'the intent must be flagged, not silently dropped or left pending forever');
  const reason = flags[flagIds[0]].reason || '';
  assert.match(reason, /target-unreachable/, 'reason must be its OWN category, not the attempt-cap text');
  assert.doesNotMatch(reason, /attempt cap/, 'must not reuse the failed-attempts cap reason for a destination fault');
  assert.match(reason, new RegExp(String(TARGET_ID)), 'reason must name the destination pane');
});

// ── AC3: guard — briefly busy is not unreachable ────────────────────────────

test('GUARD: target "working" for a short burst under the window is NOT flagged; intent stays pending', async () => {
  const env = makeEnv();
  const WINDOW = 5000;
  const { w, clock } = makeWaker(env, { status: 'working', unreachableWindowMs: WINDOW });
  beacon(env, { repo: 'walksim', session: 's', time: new Date(1_000_000).toISOString(), event: 'turn-end' });

  for (let i = 0; i < 3; i++) { await w.tick(); clock.advance(1000); } // 3s < 5s window

  assert.equal(Object.keys(w._state.pending).length, 1, 'intent stays pending — nothing to flag yet');
  assert.equal(Object.keys(readFlags(w)).length, 0, 'a brief busy burst must never be flagged');
});

test('GUARD: target "working" continuously for LONGER than the window is still NOT flagged — busy is alive, not unreachable', async () => {
  const env = makeEnv();
  const WINDOW = 3000;
  const { w, clock } = makeWaker(env, { status: 'working', unreachableWindowMs: WINDOW });
  beacon(env, { repo: 'walksim', session: 's', time: new Date(1_000_000).toISOString(), event: 'turn-end' });

  // Well past the window, but always 'working' — never 'unknown'.
  for (let i = 0; i < 10; i++) { await w.tick(); clock.advance(1000); }

  assert.equal(Object.keys(readFlags(w)).length, 0,
    'a long-working target must not be flagged as unreachable — the card scopes this to unknown/unreachable, not "any non-idle pane"');
  assert.equal(Object.keys(w._state.pending).length, 1, 'still queued for whenever the pane goes idle');
});

// ── AC5: window is a configurable, greppable operational value ─────────────

test('unreachable window has a real default in DEFAULTS and is overridable per-instance', () => {
  assert.ok(Number.isFinite(DEFAULTS.unreachableWindowMs) && DEFAULTS.unreachableWindowMs > 0,
    'DEFAULTS.unreachableWindowMs must exist and be a positive, greppable operational value');
});

test('a shorter configured window flags sooner than a longer one (same elapsed non-idle time)', async () => {
  const env1 = makeEnv();
  const { w: wShort, clock: c1 } = makeWaker(env1, { status: 'unknown', unreachableWindowMs: 2000 });
  beacon(env1, { repo: 'walksim', session: 's', time: new Date(1_000_000).toISOString(), event: 'turn-end' });
  for (let i = 0; i < 3; i++) { await wShort.tick(); c1.advance(1000); }
  assert.equal(Object.keys(readFlags(wShort)).length, 1, 'short window: flagged within 3s');

  const env2 = makeEnv();
  const { w: wLong, clock: c2 } = makeWaker(env2, { status: 'unknown', unreachableWindowMs: 60_000 });
  beacon(env2, { repo: 'walksim', session: 's', time: new Date(1_000_000).toISOString(), event: 'turn-end' });
  for (let i = 0; i < 3; i++) { await wLong.tick(); c2.advance(1000); }
  assert.equal(Object.keys(readFlags(wLong)).length, 0, 'long window: not flagged yet after the same 3s');
});

// ── "dead selector" from the problem statement: no live pane resolves AT ALL ─

test('target resolution finds NO live pane at all (dead selector): pending is also flagged as target-unreachable after the window', async () => {
  const env = makeEnv();
  const WINDOW = 4000;
  let nowMs = 1_000_000;
  const w = createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: () => [],
    resolveTarget: () => null, // mirrors pane-identity resolve() with zero hits
    send: fakeSend(),
    settleTicks: 1,
    cooldownMs: 0,
    debounceMs: 0,
    maxAttempts: 3,
    unreachableWindowMs: WINDOW,
    now: () => nowMs,
    log: () => {},
    watchRepos: ['walksim'],
  });
  beacon(env, { repo: 'walksim', session: 's', time: new Date(1_000_000).toISOString(), event: 'turn-end' });

  for (let i = 0; i < 5; i++) { await w.tick(); nowMs += 1000; }

  const flags = readFlags(w);
  const flagIds = Object.keys(flags);
  assert.equal(Object.keys(w._state.pending).length, 0, 'a permanently unresolved target must not hold intents forever either');
  assert.equal(flagIds.length, 1, 'must be flagged, not silently dropped');
  assert.match(flags[flagIds[0]].reason, /target-unreachable/);
});

// ── bug found by independent verification: '(unresolved)' clock never resets ─

test('a single transient resolve blip at t=0, then a HEALTHY target for well over the window, then a NEW intent hitting one more resolve blip: must NOT be immediately flagged', async () => {
  const env = makeEnv();
  const WINDOW = 5000;
  let resolveCalls = 0;
  let nowMs = 1_000_000;
  const w = createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: () => [{ paneId: TARGET_ID, project: 'G:/Py Apps/wezbridge', title: 'orch', status: 'idle' }],
    // resolveTarget is only called by deliverPending while pending is
    // non-empty, so it fires exactly once per intent lifecycle here: call 1
    // is the t=0 blip on the FIRST intent, call 2 resolves it (delivered,
    // pending drained), call 3 is the single-tick blip on the SECOND intent.
    resolveTarget: () => {
      resolveCalls += 1;
      if (resolveCalls === 1 || resolveCalls === 3) return null;
      return TARGET_ID;
    },
    send: fakeSend(),
    settleTicks: 1,
    cooldownMs: 0,
    debounceMs: 0,
    maxAttempts: 3,
    unreachableWindowMs: WINDOW,
    now: () => nowMs,
    log: () => {},
    watchRepos: ['walksim'],
  });

  // t=0 (clock starts): transient resolve failure starts the '(unresolved)' clock.
  beacon(env, { repo: 'walksim', session: 'first', time: new Date(nowMs).toISOString(), event: 'turn-end' });
  await w.tick(); // resolveCalls=1 -> null -> noteUnreachable('(unresolved)', ...)
  nowMs += 1000;

  // Next tick: target resolves fine and is idle -> the first intent is
  // delivered, pending drains to empty.
  await w.tick(); // resolveCalls=2 -> TARGET_ID, status idle -> delivered
  assert.equal(Object.keys(w._state.pending).length, 0, 'first intent must have been delivered');
  assert.equal(Object.keys(readFlags(w)).length, 0, 'a healthy, resolving target must never be flagged');

  // Target stays healthy/reachable (no pending intents -> resolveTarget is
  // not even invoked) for well over the window: 35 minutes of wall-clock.
  nowMs += 35 * 60_000;

  // A brand-new intent arrives and hits a single-tick resolve blip.
  beacon(env, { repo: 'walksim', session: 'second', time: new Date(nowMs).toISOString(), event: 'turn-end' });
  await w.tick(); // resolveCalls=3 -> null -> noteUnreachable('(unresolved)', ...) again

  const flags = readFlags(w);
  assert.equal(Object.keys(flags).length, 0,
    'a single-tick resolve blip on a fresh intent must not be flagged as 35min-unreachable — the (unresolved) clock from the FIRST blip must have been cleared once the target resolved again');
  assert.equal(Object.keys(w._state.pending).length, 1, 'the new intent must still be pending, not flagged away');
});
