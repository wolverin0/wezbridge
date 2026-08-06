/**
 * Tests for the audit fixes of 2026-08-06 (holes 3-6 of the loop audit).
 *
 * Covers: daemon heartbeat + liveness alerts (holes 3+4), honest poke text when
 * no graph is open (hole 5). Hole 6 (clawtrol log noise) is covered in
 * clawtrol-bridge's own suite.
 *
 * The governing rule for every alert here: it must stay SILENT on a healthy
 * system. An alert that fires when nothing is wrong trains everyone to ignore
 * it, which is strictly worse than having no alert at all — so each firing case
 * below is paired with a stays-quiet case.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ds = require('../src/daemon-status.cjs');
const { createWaker } = require('../src/orchestrator-waker.cjs');

const T0 = Date.parse('2026-08-06T12:00:00.000Z');
const beatAt = (msAgo, services = {}) => ({
  ts: new Date(T0 - msAgo).toISOString(), services,
});
const healthyWaker = { orchestrator_waker: { armed: true, cursorLagBytes: 0, reason: 'armed' } };

// ── heartbeat writing ──────────────────────────────────────────────────────
test('heartbeat writes atomically and carries the service snapshot', () => {
  ds._reset();
  ds.set('demo', { armed: true, reason: 'armed for the test' });
  const writes = [];
  const stop = ds.startHeartbeat({
    file: 'X', intervalMs: 999999, now: () => T0,
    write: (f, data) => writes.push({ f, data }),
  });
  stop();
  assert.equal(writes.length, 1, 'must beat immediately, not only after one interval');
  const beat = JSON.parse(writes[0].data);
  assert.equal(beat.ts, new Date(T0).toISOString());
  assert.equal(beat.services.demo.armed, true, 'the beat must carry service state, not just a timestamp');
});

test('a failing write never throws — a broken beat must not take the daemon down', () => {
  ds._reset();
  assert.doesNotThrow(() => {
    const stop = ds.startHeartbeat({
      file: 'X', intervalMs: 999999, write: () => { throw new Error('disk full'); },
    });
    stop();
  });
});

// ── HOLE 3: daemon death is detectable ─────────────────────────────────────
test('HOLE 3: a dead daemon is reported from the heartbeat FILE, which outlives it', () => {
  const v = ds.assessLiveness({ heartbeat: beatAt(40 * 60 * 1000), daemonReachable: false, now: T0 });
  assert.equal(v.ok, false);
  assert.match(v.alerts[0], /DAEMON DOWN/);
  assert.match(v.alerts[0], /40min/, 'must say HOW LONG it has been dead');
  assert.match(v.alerts[0], /npm run dashboard/, 'must name the remedy');
});

test('HOLE 3: a daemon that answers HTTP but stopped beating is WEDGED, not healthy', () => {
  // The failure a port check cannot see: process alive, timers dead.
  const v = ds.assessLiveness({ heartbeat: beatAt(10 * 60 * 1000, healthyWaker), daemonReachable: true, now: T0 });
  assert.equal(v.ok, false);
  assert.match(v.alerts[0], /WEDGED/);
});

test('HOLE 3: no heartbeat file at all is still a clear verdict, not a crash', () => {
  const v = ds.assessLiveness({ heartbeat: null, daemonReachable: false, now: T0 });
  assert.match(v.alerts[0], /DAEMON DOWN/);
});

test('a healthy daemon with a fresh beat produces ZERO alerts', () => {
  const v = ds.assessLiveness({ heartbeat: beatAt(5000, healthyWaker), daemonReachable: true, now: T0 });
  assert.deepEqual(v.alerts, [], 'alerts must be silent when nothing is wrong');
  assert.equal(v.ok, true);
});

test('a beat slightly older than one interval does NOT cry wolf', () => {
  // 45s: one missed beat on a busy machine. Three missed beats is the threshold.
  const v = ds.assessLiveness({ heartbeat: beatAt(45 * 1000, healthyWaker), daemonReachable: true, now: T0 });
  assert.deepEqual(v.alerts, []);
});

// ── HOLE 4: numbers become sentences ───────────────────────────────────────
test('HOLE 4: a disarmed waker is stated in words, with its reason', () => {
  const v = ds.assessLiveness({
    heartbeat: beatAt(5000, { orchestrator_waker: { armed: false, reason: 'no config file' } }),
    daemonReachable: true, now: T0,
  });
  assert.match(v.alerts[0], /WAKER OFF/);
  assert.match(v.alerts[0], /no config file/, 'the reason must survive into the alert');
});

test('HOLE 4: a waker falling behind is caught by lag, not left as a raw number', () => {
  const v = ds.assessLiveness({
    heartbeat: beatAt(5000, { orchestrator_waker: { armed: true, cursorLagBytes: 99999 } }),
    daemonReachable: true, now: T0,
  });
  assert.match(v.alerts[0], /FALLING BEHIND/);
});

test('HOLE 4: small lag between ticks is normal and stays quiet', () => {
  const v = ds.assessLiveness({
    heartbeat: beatAt(5000, { orchestrator_waker: { armed: true, cursorLagBytes: 400 } }),
    daemonReachable: true, now: T0,
  });
  assert.deepEqual(v.alerts, []);
});

test('HOLE 4: a daemon that never registered a waker is reported as missing', () => {
  const v = ds.assessLiveness({ heartbeat: beatAt(5000, {}), daemonReachable: true, now: T0 });
  assert.match(v.alerts[0], /WAKER MISSING/);
});

test('waker alerts are suppressed while the daemon is down — one root cause, one alert', () => {
  const v = ds.assessLiveness({ heartbeat: beatAt(60 * 60 * 1000, {}), daemonReachable: false, now: T0 });
  assert.equal(v.alerts.length, 1, 'a dead daemon must not also emit a derived waker alarm');
});

// ── HOLE 5: the poke stops asserting a mode it did not check ───────────────
function wakerWith(hasOpenGraph) {
  const sent = [];
  const os = require('node:os');
  const fs = require('node:fs');
  const p = require('node:path');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'wk-'));
  fs.writeFileSync(p.join(dir, 'events.jsonl'), '');
  const w = createWaker({
    eventsPath: p.join(dir, 'events.jsonl'),
    stateDir: p.join(dir, 'state'),
    watchRepos: ['brlite'],
    hasOpenGraph,
    discoverPanes: () => [{ paneId: 0, isClaude: true, project: '/x/wezbridge', status: 'idle', title: 'w' }],
    resolveTarget: () => 0,
    send: {
      sendPromptDeferredEnter: async (_id, text) => { sent.push(text); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted',
    },
  });
  return { w, sent };
}

test('HOLE 5: with NO open graph the poke reports what happened and claims nothing', async () => {
  const { w, sent } = wakerWith(() => false);
  w._state.pending = { abc123: { repo: 'brlite', event: 'turn-end', time: '2026-08-06T01:00:00Z', attempts: 0 } };
  await w.tick(); await w.tick(); // settleTicks = 2
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /advance the graph/, 'must not order a graph advance when no graph is open');
  assert.match(sent[0], /No open graph/);
});

test('HOLE 5: with an open graph the harvest instruction is still given', async () => {
  const { w, sent } = wakerWith(() => true);
  w._state.pending = { abc123: { repo: 'brlite', event: 'turn-end', time: '2026-08-06T01:00:00Z', attempts: 0 } };
  await w.tick(); await w.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /advance the graph/);
});

test('HOLE 5: a graph whose nodes are all terminal counts as CLOSED', () => {
  // The live 2026-08-06 case: brlite-graph-1 sealed, all 4 nodes done, yet the
  // poke still said "advance the graph" and pointed at stale results.
  const os = require('node:os'); const fs = require('node:fs'); const p = require('node:path');
  const root = fs.mkdtempSync(p.join(os.tmpdir(), 'repos-'));
  const orch = p.join(root, 'brlite', '.orchestrator');
  fs.mkdirSync(orch, { recursive: true });
  fs.mkdirSync(p.join(root, '_intel'), { recursive: true });
  fs.writeFileSync(p.join(root, '_intel', 'events.jsonl'), '');
  const write = (nodes) => fs.writeFileSync(p.join(orch, 'graph.json'), JSON.stringify({ nodes }));

  const build = () => createWaker({
    eventsPath: p.join(root, '_intel', 'events.jsonl'),
    stateDir: p.join(root, '_intel', 'st'),
    watchRepos: ['brlite'],
    discoverPanes: () => [],
    send: { sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' },
  });

  write([{ id: 'a', state: 'done' }, { id: 'b', state: 'done' }]);
  assert.equal(build()._openGraph('brlite'), false, 'all-terminal graph must read as closed');

  write([{ id: 'a', state: 'done' }, { id: 'b', state: 'ready' }]);
  assert.equal(build()._openGraph('brlite'), true, 'one live node keeps it open');

  write([{ id: 'a' }]);
  assert.equal(build()._openGraph('brlite'), true, 'a node with no state yet has not run — open');

  assert.equal(build()._openGraph('nosuchrepo'), false, 'missing graph file is not graph mode');
});

// ── HOLE 6: log noise policy ───────────────────────────────────────────────
// Overnight the bridge printed ~25 "sync FAILING (1 consecutive)" lines for
// blips that healed on the next tick, into the same stream the waker logs to.
// Alarming lines about nothing are not merely useless: they buried a real
// 2h45m outage.
const clawtrol = require('../src/clawtrol-bridge.cjs');

test('HOLE 6: an isolated blip that the retry handles logs NOTHING', () => {
  assert.equal(clawtrol.shouldLogFailure(1), false);
});

test('HOLE 6: a sustained outage still speaks, and keeps speaking', () => {
  assert.equal(clawtrol.shouldLogFailure(2), true, 'second consecutive failure = real outage');
  assert.equal(clawtrol.shouldLogFailure(5), true);
  assert.equal(clawtrol.shouldLogFailure(10), true);
});

test('HOLE 6: it does not log on EVERY tick of a long outage', () => {
  const noisy = [3, 4, 6, 7, 8, 9].filter((n) => clawtrol.shouldLogFailure(n));
  assert.deepEqual(noisy, [], 'between milestones a long outage must stay quiet');
});

test('HOLE 6: recovery is announced only for outages that were announced', () => {
  assert.equal(clawtrol.shouldLogRecovery(0), false, 'a clean tick is not news');
  assert.equal(clawtrol.shouldLogRecovery(1), false, 'a blip nobody was told about needs no all-clear');
  assert.equal(clawtrol.shouldLogRecovery(2), true, 'an outage must have an END in the log, not just a start');
});

// ── COMPOSITION ROOT: the heartbeat is actually started ────────────────────
// Every test above exercises assessLiveness in isolation, and all of them pass
// happily if nothing ever beats. That is exactly the trap that produced the
// 2026-08-06 outage, so the wiring gets asserted where the daemon wires it.
test('COMPOSITION ROOT: startBackgroundServices writes a heartbeat file', () => {
  const fs = require('node:fs'); const os = require('node:os'); const p = require('node:path');
  const intel = fs.mkdtempSync(p.join(os.tmpdir(), 'intel-'));
  const prev = { ...process.env };
  process.env.WEZBRIDGE_INTEL_DIR = intel;
  process.env.WEZBRIDGE_SESSION_SNAPSHOT = '0';
  process.env.WEZBRIDGE_ORCH_WAKER = '0';
  try {
    const { createEventHandlers } = require('../src/handlers/event-handlers.cjs');
    createEventHandlers({
      log: () => {}, path: p, fs, SRC_DIR: p.join(__dirname, '..', 'src'),
      ipc: { wez: { listPanes: () => [] }, discoverPanes: () => [] },
      wez: { listPanes: () => [] }, discoverPanes: () => [],
      a2aState: new Map(), broadcastSSE: () => {},
      a2aHeartbeat: { startWatcher: () => {} },
      sessionSnapshot: { startWatcher: () => {} },
      teamManifest: { replay: () => ({ teams: new Map(), worktrees: new Map() }) },
      teamsRegistry: new Map(), worktreeRegistry: new Map(),
      safetyPolicy: { evaluate: () => ({ allowed: true }) },
    }).startBackgroundServices();

    const beatFile = p.join(intel, '.daemon-heartbeat.json');
    assert.ok(fs.existsSync(beatFile), 'the daemon must publish liveness, not merely be able to');
    const beat = JSON.parse(fs.readFileSync(beatFile, 'utf8'));
    assert.ok(beat.ts, 'beat carries a timestamp');
    assert.equal(beat.pid, process.pid);
    // And the beat must be usable as the liveness witness end-to-end.
    const v = ds.assessLiveness({ heartbeat: beat, daemonReachable: false, now: Date.parse(beat.ts) });
    assert.match(v.alerts[0], /DAEMON DOWN/, 'a written beat + unreachable daemon = a usable death verdict');
  } finally { process.env = prev; }
});

test('ORDERING: the first beat already contains the waker — no false MISSING window', () => {
  // The heartbeat beats immediately. If it started before the watchers
  // registered, anyone reading in that window would be told "WAKER MISSING"
  // about a healthy daemon. Ordering is the fix, so ordering is asserted.
  const fs = require('node:fs'); const os = require('node:os'); const p = require('node:path');
  const intel = fs.mkdtempSync(p.join(os.tmpdir(), 'intel-ord-'));
  // MUST reset: the status registry is a module singleton, so an earlier test's
  // registration leaks in and makes this assertion pass vacuously — verified by
  // mutation, which stayed green until this line existed.
  ds._reset();
  const prev = { ...process.env };
  process.env.WEZBRIDGE_INTEL_DIR = intel;
  process.env.WEZBRIDGE_SESSION_SNAPSHOT = '0';
  process.env.WEZBRIDGE_ORCH_WAKER = '0'; // registers armed:false — still REGISTERED
  try {
    const { createEventHandlers } = require('../src/handlers/event-handlers.cjs');
    createEventHandlers({
      log: () => {}, path: p, fs, SRC_DIR: p.join(__dirname, '..', 'src'),
      ipc: { wez: { listPanes: () => [] }, discoverPanes: () => [] },
      wez: { listPanes: () => [] }, discoverPanes: () => [],
      a2aState: new Map(), broadcastSSE: () => {},
      a2aHeartbeat: { startWatcher: () => {} },
      sessionSnapshot: { startWatcher: () => {} },
      teamManifest: { replay: () => ({ teams: new Map(), worktrees: new Map() }) },
      teamsRegistry: new Map(), worktreeRegistry: new Map(),
      safetyPolicy: { evaluate: () => ({ allowed: true }) },
    }).startBackgroundServices();

    const beat = JSON.parse(fs.readFileSync(p.join(intel, '.daemon-heartbeat.json'), 'utf8'));
    assert.ok(beat.services.orchestrator_waker,
      'the FIRST beat must already know about the waker, or health lies during startup');
    const v = ds.assessLiveness({ heartbeat: beat, daemonReachable: true, now: Date.parse(beat.ts) });
    assert.equal(v.alerts.filter((a) => /MISSING/.test(a)).length, 0,
      'a healthy startup must never produce a MISSING alert');
  } finally { process.env = prev; }
});

test('HOLE 5b: a graph in ANY graph*.json counts — not just graph.json', () => {
  // Live gap: brlite's graph.json held the SEALED graph-1 while the live
  // milestone was authored as graph-3.json. Reading one fixed filename would
  // have reported "no open graph" about a graph dispatched minutes earlier.
  const os = require('node:os'); const fs = require('node:fs'); const p = require('node:path');
  const root = fs.mkdtempSync(p.join(os.tmpdir(), 'repos2-'));
  const orch = p.join(root, 'brlite', '.orchestrator');
  fs.mkdirSync(orch, { recursive: true });
  fs.mkdirSync(p.join(root, '_intel'), { recursive: true });
  fs.writeFileSync(p.join(root, '_intel', 'events.jsonl'), '');
  const build = () => createWaker({
    eventsPath: p.join(root, '_intel', 'events.jsonl'),
    stateDir: p.join(root, '_intel', 'st'),
    watchRepos: ['brlite'], discoverPanes: () => [],
    send: { sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' },
  });

  // The real shape: sealed graph.json + live graph-3.json
  fs.writeFileSync(p.join(orch, 'graph.json'), JSON.stringify({ nodes: [{ id: 'a', state: 'done' }] }));
  assert.equal(build()._openGraph('brlite'), false, 'only a sealed graph -> closed');

  fs.writeFileSync(p.join(orch, 'graph-3.json'), JSON.stringify({ nodes: [{ id: 'f1', state: 'ready' }] }));
  assert.equal(build()._openGraph('brlite'), true, 'a live graph-3.json must count as open');

  // An explicitly closed graph is closed even with non-terminal nodes left in it
  fs.writeFileSync(p.join(orch, 'graph-3.json'),
    JSON.stringify({ graph_state: 'closed', nodes: [{ id: 'f1', state: 'ready' }] }));
  assert.equal(build()._openGraph('brlite'), false, 'graph_state:closed is authoritative');
});

// ── RESULTS-FILE TRIGGER: a completion signal that needs no hook ───────────
// Codex panes do not reliably fire a Stop hook (confirmed on mutual 2026-08-06:
// the beacon hook is registered for codex and works standalone, yet emitted
// nothing all day while the pane worked). That locked every non-Claude pane out
// of the loop. A results file is the contract anyway — harvest-by-file — so it
// is the better trigger: a beacon says "a turn ended", a results file says "a
// NODE COMPLETED".
function resultsWaker() {
  const fs = require('node:fs'); const os = require('node:os'); const p = require('node:path');
  const root = fs.mkdtempSync(p.join(os.tmpdir(), 'rw-'));
  fs.mkdirSync(p.join(root, '_intel'), { recursive: true });
  fs.writeFileSync(p.join(root, '_intel', 'events.jsonl'), '');
  const resDir = p.join(root, 'mutual', '.orchestrator', 'results');
  fs.mkdirSync(resDir, { recursive: true });
  const sent = [];
  const w = createWaker({
    eventsPath: p.join(root, '_intel', 'events.jsonl'),
    stateDir: p.join(root, '_intel', 'st'),
    watchRepos: ['mutual'],
    hasOpenGraph: () => true,
    discoverPanes: () => [{ paneId: 0, isClaude: true, project: '/x/wezbridge', status: 'idle', title: 'w' }],
    resolveTarget: () => 0,
    send: {
      sendPromptDeferredEnter: async (_id, t) => { sent.push(t); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted',
    },
  });
  return { w, sent, resDir, fs, p };
}

test('RESULTS TRIGGER: first sight seeds silently — a repo full of old results is not replayed', async () => {
  const { w, sent, resDir, fs, p } = resultsWaker();
  fs.writeFileSync(p.join(resDir, 'OLD-node.json'), '{}');
  await w.tick(); await w.tick();
  assert.equal(sent.length, 0, 'pre-existing results must not fire — same discipline as the events cursor starting at EOF');
});

test('RESULTS TRIGGER: a NEW results file pokes, and names the node', async () => {
  const { w, sent, resDir, fs, p } = resultsWaker();
  await w.tick();                                   // seed
  fs.writeFileSync(p.join(resDir, 'M1-coverage.json'), '{"verdict":"done"}');
  await w.tick(); await w.tick();                   // settleTicks = 2
  assert.equal(sent.length, 1);
  assert.match(sent[0], /RESULT FILE\(S\) written: M1-coverage/);
});

test('RESULTS TRIGGER: an unchanged file never re-fires', async () => {
  const { w, sent, resDir, fs, p } = resultsWaker();
  await w.tick();
  fs.writeFileSync(p.join(resDir, 'M1.json'), '{"a":1}');
  await w.tick(); await w.tick();
  const after = sent.length;
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(sent.length, after, 'a stable results file must poke exactly once');
});

test('RESULTS TRIGGER: a REWRITTEN result fires again — a retry attempt is news', async () => {
  const { w, sent, resDir, fs, p } = resultsWaker();
  await w.tick();
  const f = p.join(resDir, 'M1.json');
  fs.writeFileSync(f, '{"verdict":"failed"}');
  await w.tick(); await w.tick();
  const afterFirst = sent.length;
  fs.writeFileSync(f, '{"verdict":"done","attempt":2,"padding":"different size"}');
  w._state.lastAttemptAt = {};                      // bypass per-repo cooldown for the test
  await w.tick(); await w.tick();
  assert.ok(sent.length > afterFirst, 'attempt 2 overwriting attempt 1 must be seen');
});

test('RESULTS TRIGGER: a repo with no .orchestrator dir is skipped without throwing', async () => {
  const { w } = resultsWaker();
  await assert.doesNotReject(() => w.tick());
});
