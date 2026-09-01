/**
 * orchestrator-waker.test.cjs — deterministic, injected-deps tests for the
 * daemon-side pane-0 waker. The failure modes pinned here are the two
 * historical ones: poke-storms into a busy composer, and silent no-ops where
 * events never produce a wake. Plus the durability contract: state survives
 * restart, delivered intents never re-send, cursor never re-reads.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWaker, intentId, isNoiseEvent, paneRunsBypass } = require('../src/orchestrator-waker.cjs');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-'));
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(eventsPath, '');
  return { dir, eventsPath, stateDir };
}

function beacon(env, evt) {
  fs.appendFileSync(env.eventsPath, `${JSON.stringify(evt)}\n`);
}

function fakeSend(plan = {}) {
  const calls = [];
  return {
    calls,
    sendPromptDeferredEnter: async (paneId, text) => {
      calls.push({ paneId, text });
      if (plan.throwOnSend) throw new Error('pane gone');
      return plan.delivered || 'ok';
    },
    verifyPromptSubmission: async () => plan.submitted || 'submitted',
  };
}

const IDLE_PANE = { paneId: 0, project: 'G:/Py Apps/wezbridge', title: 'orch', status: 'idle' };

function makeWaker(env, over = {}) {
  return createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: over.discoverPanes || (() => [IDLE_PANE]),
    send: over.send || fakeSend(),
    settleTicks: over.settleTicks ?? 2,
    cooldownMs: over.cooldownMs ?? 0,
    maxAttempts: over.maxAttempts ?? 3,
    now: over.now || (() => 1_000_000),
    log: over.log || (() => {}),
    watchRepos: over.watchRepos || ['walksim'],
  });
}

test('turn-end + idle settle -> exactly one verified poke, intent delivered', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const w = makeWaker(env, { send });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick(); // ingest + idle streak 1 — settle not met, no send
  assert.equal(send.calls.length, 0, 'no poke before settle');
  await w.tick(); // idle streak 2 — poke
  assert.equal(send.calls.length, 1, 'exactly one poke');
  // Payload-first single line: truncation eats the HEAD of long messages, so the
  // substance must lead. Deliberately NOT asserting "Harvest" — this fixture has
  // no graph, and after 2026-08-06 the poke only claims graph mode when a graph
  // is actually open (see daemon-liveness.test.cjs for both variants).
  assert.match(send.calls[0].text, /^\[orch-waker\] walksim\b/, 'payload-first single line, repo leads');
  assert.equal(Object.keys(w._state.pending).length, 0, 'intent removed from pending');
  await w.tick();
  assert.equal(send.calls.length, 1, 'no re-poke after delivery');
});

test('busy target blocks the poke; idle after busy resets the settle count', async () => {
  const env = makeEnv();
  const send = fakeSend();
  let status = 'working';
  const w = makeWaker(env, {
    send,
    discoverPanes: () => [{ ...IDLE_PANE, status }],
  });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  await w.tick(); await w.tick();
  assert.equal(send.calls.length, 0, 'never pokes a working pane');
  status = 'idle';
  await w.tick(); // streak 1
  assert.equal(send.calls.length, 0, 'settle restarts from zero after busy');
  await w.tick(); // streak 2 -> poke
  assert.equal(send.calls.length, 1);
});

test('unverified sends retry, then hit the cap and are flagged — never infinite', async () => {
  const env = makeEnv();
  const send = fakeSend({ submitted: 'stuck' });
  const w = makeWaker(env, { send, settleTicks: 1, maxAttempts: 3 });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  for (let i = 0; i < 6; i++) await w.tick();
  assert.equal(send.calls.length, 3, 'exactly maxAttempts sends, then silence');
  assert.equal(Object.keys(w._state.pending).length, 0, 'capped intent leaves pending');
  const flags = JSON.parse(fs.readFileSync(w._files.flags, 'utf8'));
  assert.equal(Object.keys(flags).length, 1, 'cap exhaustion is FLAGGED, not swallowed');
  assert.match(Object.values(flags)[0].reason, /cap/);
});

test('a throwing send counts as a failed attempt, not a crash', async () => {
  const env = makeEnv();
  const send = fakeSend({ throwOnSend: true });
  const w = makeWaker(env, { send, settleTicks: 1, maxAttempts: 2 });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(send.calls.length, 2, 'capped after maxAttempts throws');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(w._files.flags, 'utf8'))).length, 1);
});

test('multiple pending events coalesce into ONE poke', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const w = makeWaker(env, { send, settleTicks: 1 });
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  beacon(env, { repo: 'walksim', session: 'a', time: 't2', event: 'turn-end' });
  beacon(env, { repo: 'walksim', session: 'a', time: 't3', event: 'permission-wait' });
  await w.tick();
  assert.equal(send.calls.length, 1, 'one poke for the whole batch');
  assert.match(send.calls[0].text, /3 turn-end\+permission-wait event\(s\)/);
});

test('restart survives: pending persists, delivered never re-sends, cursor never re-reads', async () => {
  const env = makeEnv();
  const send1 = fakeSend({ submitted: 'stuck' }); // first instance fails to deliver
  const w1 = makeWaker(env, { send: send1, settleTicks: 1, maxAttempts: 5 });
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w1.tick();
  assert.equal(Object.keys(w1._state.pending).length, 1, 'undelivered stays pending');

  // restart -> new instance over the same state dir
  const send2 = fakeSend();
  const w2 = makeWaker(env, { send: send2, settleTicks: 1 });
  assert.equal(Object.keys(w2._state.pending).length, 1, 'pending survived restart');
  await w2.tick();
  assert.equal(send2.calls.length, 1, 'delivered on restarted instance');

  // third instance: nothing pending, cursor is past the old line
  const send3 = fakeSend();
  const w3 = makeWaker(env, { send: send3, settleTicks: 1 });
  await w3.tick(); await w3.tick();
  assert.equal(send3.calls.length, 0, 'no replay of consumed events after restart');
});

test('filters: other repos, other event types, corrupt lines — all skipped silently', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const w = makeWaker(env, { send, settleTicks: 1 });
  beacon(env, { repo: 'cafebar', session: 's', time: 't1', event: 'turn-end' });
  beacon(env, { repo: 'walksim', session: 's', time: 't2', event: 'some-other-event' });
  fs.appendFileSync(env.eventsPath, 'THIS IS NOT JSON\n');
  beacon(env, { repo: 'walksim', session: 's', time: 't3', event: 'turn-end' });
  await w.tick();
  assert.equal(send.calls.length, 1, 'only the matching event poked');
  assert.match(send.calls[0].text, /1 turn-end event\(s\)/);
});

test('ambiguous or missing target pane -> no poke, intent stays pending', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const two = [IDLE_PANE, { ...IDLE_PANE, paneId: 9 }];
  const w = makeWaker(env, { send, settleTicks: 1, discoverPanes: () => two });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  await w.tick(); await w.tick();
  assert.equal(send.calls.length, 0, 'fail closed on ambiguity');
  assert.equal(Object.keys(w._state.pending).length, 1, 'intent preserved for when resolution clears');
});

test('cooldown spaces retry attempts', async () => {
  const env = makeEnv();
  let clock = 0;
  const send = fakeSend({ submitted: 'stuck' });
  const w = makeWaker(env, {
    send, settleTicks: 1, maxAttempts: 5, cooldownMs: 1000, now: () => clock,
  });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  await w.tick(); // attempt 1 at t=0
  await w.tick(); // still inside cooldown
  assert.equal(send.calls.length, 1, 'second attempt suppressed by cooldown');
  clock = 2000;
  await w.tick();
  assert.equal(send.calls.length, 2, 'retry after cooldown expires');
});

test('event file rotation/truncation resets the cursor instead of blinding the waker', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const w = makeWaker(env, { send, settleTicks: 1 });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  await w.tick();
  assert.equal(send.calls.length, 1);
  // rotate: file replaced with a smaller one
  fs.writeFileSync(env.eventsPath, '');
  beacon(env, { repo: 'walksim', session: 's', time: 't9', event: 'turn-end' });
  await w.tick();
  assert.equal(send.calls.length, 2, 'post-rotation events still ingested');
});

test('intentId is stable and collision-scoped to repo+session+time+event', () => {
  const a = intentId({ repo: 'walksim', session: 's', time: 't', event: 'turn-end' });
  const b = intentId({ repo: 'walksim', session: 's', time: 't', event: 'turn-end' });
  const c = intentId({ repo: 'walksim', session: 's', time: 't2', event: 'turn-end' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('non-Claude panes sharing the target cwd do not make resolution ambiguous', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const daemonShellPane = { paneId: 14, project: 'G:/Py Apps/wezbridge', title: 'npm run dashboard', status: 'idle', isClaude: false };
  const w = makeWaker(env, {
    send, settleTicks: 1,
    discoverPanes: () => [{ ...IDLE_PANE, isClaude: true }, daemonShellPane],
  });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'turn-end' });
  await w.tick();
  assert.equal(send.calls.length, 1, 'daemon shell pane filtered out; Claude pane poked');
  assert.equal(send.calls[0].paneId, 0);
});

// --- mm-d216: permission-wait from a bypass-permissions pane is NOISE -------

const BYPASS_WALKSIM_PANE = {
  paneId: 7, project: 'G:/Py Apps/walksim', title: 'walksim dev', status: 'working',
  lastLines: 'some output\n⏵⏵ bypass permissions on (shift+tab to cycle)',
};

test('isNoiseEvent: only permission-wait AND bypass together are noise', () => {
  assert.equal(isNoiseEvent({ event: 'permission-wait' }, true), true);
  assert.equal(isNoiseEvent({ event: 'permission-wait' }, false), false);
  assert.equal(isNoiseEvent({ event: 'turn-end' }, true), false);
  assert.equal(isNoiseEvent(null, true), false);
});

test('paneRunsBypass matches the repo pane by path suffix and reads the status bar', () => {
  const panes = [IDLE_PANE, BYPASS_WALKSIM_PANE];
  assert.equal(paneRunsBypass(panes, 'walksim'), true);
  assert.equal(paneRunsBypass(panes, 'wezbridge'), false, 'orch pane shows no bypass marker');
  assert.equal(paneRunsBypass(panes, 'other-repo'), false, 'invisible pane fails open');
  assert.equal(paneRunsBypass([], 'walksim'), false);
  // nested repo paths match too (e.g. "whatsappbot-prod - Copy - Copy/whatsappbot-final")
  const nested = [{ paneId: 3, project: 'G:/Py Apps/a/b', lastLines: '⏵⏵ bypass permissions on' }];
  assert.equal(paneRunsBypass(nested, 'a/b'), true);
  assert.equal(paneRunsBypass(nested, 'b'), true);
});

test('ingest side: permission-wait from a visible bypass pane never becomes an intent', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const w = makeWaker(env, {
    send, settleTicks: 1,
    discoverPanes: () => [IDLE_PANE, BYPASS_WALKSIM_PANE],
  });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'permission-wait' });
  await w.tick();
  assert.equal(Object.keys(w._state.pending).length, 0, 'noise never entered pending');
  assert.equal(send.calls.length, 0, 'and nothing was poked');
  // turn-end from the same bypass pane is NOT filtered — mm-d216 is only about permission-wait
  beacon(env, { repo: 'walksim', session: 's', time: 't2', event: 'turn-end' });
  await w.tick();
  assert.equal(send.calls.length, 1, 'turn-end still pokes');
  assert.match(send.calls[0].text, /1 turn-end event\(s\)/);
});

test('ingest side: cfg.isBypassPane overrides pane sniffing (injectable for wiring)', async () => {
  const env = makeEnv();
  const send = fakeSend();
  // no bypass pane visible, but the injected predicate says bypass
  const w3 = createWaker({
    eventsPath: env.eventsPath, stateDir: env.stateDir,
    discoverPanes: () => [IDLE_PANE], send, settleTicks: 1, cooldownMs: 0,
    now: () => 1_000_000, log: () => {}, watchRepos: ['walksim'],
    isBypassPane: (evt) => evt.repo === 'walksim',
  });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'permission-wait' });
  await w3.tick();
  assert.equal(Object.keys(w3._state.pending).length, 0, 'predicate verdict respected');
  assert.equal(send.calls.length, 0);
});

test('poke side: intents ingested before the pane was visible are dropped at delivery, not poked', async () => {
  const env = makeEnv();
  const send = fakeSend();
  let panes = [IDLE_PANE]; // source pane NOT visible at ingest -> intent is kept (fail open)
  const w = makeWaker(env, { send, settleTicks: 2, discoverPanes: () => panes });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'permission-wait' });
  await w.tick(); // ingest + idle streak 1 — settle not met, nothing delivered yet
  assert.equal(Object.keys(w._state.pending).length, 1, 'kept while mode unknowable');
  // pane becomes visible, running bypass -> twin filter drops it at poke time
  panes = [IDLE_PANE, BYPASS_WALKSIM_PANE];
  await w.tick();
  assert.equal(send.calls.length, 0, 'noise never woke the orchestrator');
  assert.equal(Object.keys(w._state.pending).length, 0, 'dropped, not left to rot');
  await w.tick();
  assert.equal(send.calls.length, 0, 'and it never comes back');
});

test('poke side: mixed group keeps real events — only the permission-wait noise is dropped', async () => {
  const env = makeEnv();
  const send = fakeSend();
  let panes = [IDLE_PANE]; // ingest both while source pane is invisible
  const w = makeWaker(env, { send, settleTicks: 2, discoverPanes: () => panes });
  beacon(env, { repo: 'walksim', session: 's', time: 't1', event: 'permission-wait' });
  beacon(env, { repo: 'walksim', session: 's', time: 't2', event: 'turn-end' });
  await w.tick(); // ingest + idle streak 1 — settle not met, nothing delivered yet
  assert.equal(Object.keys(w._state.pending).length, 2);
  panes = [IDLE_PANE, BYPASS_WALKSIM_PANE];
  await w.tick();
  assert.equal(send.calls.length, 1, 'the real turn-end still pokes');
  assert.match(send.calls[0].text, /1 turn-end event\(s\)/, 'noise excluded from the count');
  assert.equal(Object.keys(w._state.pending).length, 0);
});

test('fresh state starts at END of an existing events file — history is not replayed', async () => {
  const env = makeEnv();
  beacon(env, { repo: 'walksim', session: 'old', time: 't-old-1', event: 'turn-end' });
  beacon(env, { repo: 'walksim', session: 'old', time: 't-old-2', event: 'turn-end' });
  const send = fakeSend();
  const w = makeWaker(env, { send, settleTicks: 1 }); // first construction AFTER history exists
  await w.tick();
  assert.equal(send.calls.length, 0, 'stale history produced no intents');
  beacon(env, { repo: 'walksim', session: 'new', time: 't-new', event: 'turn-end' });
  await w.tick();
  assert.equal(send.calls.length, 1, 'events after arming are ingested normally');
  assert.match(send.calls[0].text, /1 turn-end event\(s\)/);
});

// ---------------------------------------------------------------------------
// 2026-09-01 20:0x ART, medido en vivo: el archivo de eventos cambio "por debajo"
// del cursor (hash de la cola distinto), el waker reinicio el cursor a 0 y
// REPLAYO 18.697 lineas desde el 25-08 — pokes de yolo26, axion y memorymaster,
// panes que ya no existen. Un reinicio de cursor salta a EOF, nunca replaya; y
// un evento mas viejo que STALE_EVENT_MS no se ingesta nunca.
// ---------------------------------------------------------------------------
test('rotacion/mismatch del archivo: el cursor se reinicia y queda CONTADO; la re-lectura no vuelve a poke-ar lo entregado ni lo viejo', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const NOW = 10_000_000_000;
  const w = makeWaker(env, { send, now: () => NOW, watchRepos: ['walksim'] });
  beacon(env, { time: new Date(NOW - 60000).toISOString(), repo: 'walksim', session: 'a', event: 'turn-end' });
  await w.tick(); await w.tick();
  assert.equal(send.calls.length, 1, 'el primer evento se entrega normal');
  // Reescritura in-place por debajo del cursor: el mismo evento ya entregado (dedupe),
  // uno de hace 2 dias (stale) y uno reciente nuevo (ese SI debe entrar).
  const rewritten = [
    { time: new Date(NOW - 60000).toISOString(), repo: 'walksim', session: 'a', event: 'turn-end' },
    { time: new Date(NOW - 2 * 24 * 3600000).toISOString(), repo: 'walksim', session: 'viejo', event: 'turn-end' },
    { time: new Date(NOW - 30000).toISOString(), repo: 'walksim', session: 'nuevo', event: 'turn-end' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(env.eventsPath, ' '.repeat(8) + rewritten); // bytes distintos antes del cursor
  await w.tick(); await w.tick();
  assert.equal(w.status().cursorResets, 1, 'el reinicio queda contado en status()');
  assert.equal(w.status().staleDropped, 1, 'el evento de hace 2 dias se descarto');
  assert.equal(send.calls.length, 2, 'solo el evento reciente nuevo produjo un poke: ni el ya entregado ni el viejo');
});

test('un evento mas viejo que STALE_EVENT_MS no se ingesta: se cuenta como stale, no se poke-a', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const NOW = 10_000_000_000;
  const w = makeWaker(env, { send, now: () => NOW, watchRepos: ['walksim'] });
  beacon(env, { time: new Date(NOW - 8 * 3600000).toISOString(), repo: 'walksim', session: 'old', event: 'turn-end' });
  beacon(env, { time: new Date(NOW - 60000).toISOString(), repo: 'walksim', session: 'new', event: 'turn-end' });
  await w.tick(); await w.tick();
  assert.equal(send.calls.length, 1);
  assert.match(send.calls[0].text, /walksim/);
  assert.equal(w.status().staleDropped, 1, 'el evento de hace 8 h se descarto y quedo contado');
  assert.equal(Object.keys(w._state.pending).length, 0);
});
