'use strict';
/**
 * fleet-digest.test.cjs — T-0409. AC1 classifier (real fixture lines from
 * test/fixtures/pane-events-20260923-24.jsonl, a scrubbed excerpt of 23-24/09
 * pane-events.jsonl), AC2 digest builder, AC3 durable cursor/sent.jsonl/--count-day
 * against an isolated state dir, AC4 stateless replay against the REAL
 * _intel/pane-events.jsonl, AC5 pane-event-watcher.py --kinds filter.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  classifyEvent, buildDigests, resolveLane, runOnce, runReplay, countDay, DEFAULT_WINDOW_MS,
  resolveIntelDir,
} = require('../src/fleet-digest.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'pane-events-20260923-24.jsonl');
// Resolved by walking up from __dirname (not a fixed "../.." guess) so this finds the
// real Py Apps/_intel even when the suite runs inside a git worktree several levels
// deeper than <repo>/.claude/worktrees/<id>/ — see resolveIntelDir's doc comment.
const REAL_EVENTS = path.join(resolveIntelDir(__dirname), 'pane-events.jsonl');

function readFixtureEvents() {
  return fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── AC1: classifier, fail-first on real fixture lines ─────────────────────────────

test('AC1 classifyEvent: suborch_question from the real fixture is immediate', () => {
  const events = readFixtureEvents();
  const questions = events.filter((e) => e.event === 'suborch_question');
  assert.ok(questions.length > 0, 'fixture must contain at least one real suborch_question line');
  for (const evt of questions) assert.equal(classifyEvent(evt), 'immediate');
});

test('AC1 classifyEvent: suborch_done (outcome succeeded) from the real fixture is digest', () => {
  const events = readFixtureEvents();
  const done = events.filter((e) => e.event === 'suborch_done');
  assert.ok(done.length > 0, 'fixture must contain at least one real suborch_done line');
  for (const evt of done) {
    assert.equal(evt.outcome, 'succeeded', 'fixture sample assumption — adjust if the excerpt changes');
    assert.equal(classifyEvent(evt), 'digest');
  }
});

test('AC1 classifyEvent: suborch_handoff from the real fixture is digest', () => {
  const events = readFixtureEvents();
  const handoffs = events.filter((e) => e.event === 'suborch_handoff');
  assert.ok(handoffs.length > 0, 'fixture must contain at least one real suborch_handoff line');
  for (const evt of handoffs) assert.equal(classifyEvent(evt), 'digest');
});

test('AC1 classifyEvent: suborch_status / turn-end / permission-wait from the real fixture all drop', () => {
  const events = readFixtureEvents();
  const dropKinds = ['suborch_status', 'turn-end', 'permission-wait'];
  const sample = events.filter((e) => dropKinds.includes(e.event));
  assert.ok(sample.length > 100, 'fixture must be dominated by drop-kind noise, like the real file');
  for (const evt of sample) assert.equal(classifyEvent(evt), 'drop');
});

// worker-done (outcome=failed) and a bare worker-done do not occur in this excerpt window
// (orca-census.cjs only just started emitting worker-done; none landed 23-24/09) — covered
// with constructed objects of the SAME shape orca-census.cjs writes (see pollWorkerDone).
test('AC1 classifyEvent: worker-done/suborch_done outcome=failed is immediate; outcome=null is digest', () => {
  assert.equal(classifyEvent({ event: 'worker-done', task_id: 'T-1', outcome: 'failed' }), 'immediate');
  assert.equal(classifyEvent({ event: 'suborch_done', task_id: 'T-1', outcome: 'failed' }), 'immediate');
  assert.equal(classifyEvent({ event: 'worker-done', task_id: 'T-1', outcome: null }), 'digest');
  assert.equal(classifyEvent({ event: 'worker-done', task_id: 'T-1' }), 'digest');
});

test('AC1 classifyEvent: a line that only echoes a brief (ECHO_MARKERS) produces nothing', () => {
  // Same template placeholder orca-census.cjs's ECHO_MARKERS filters before this ever
  // reaches pane-events.jsonl — checked again here as defense-in-depth (see isEchoEvent doc).
  const echoed = {
    event: 'suborch_done', task_id: 'T-NNNN', outcome: 'succeeded',
    line: '[SUBORCH_DONE] task_id=T-NNNN outcome=succeeded|failed report=<path>',
  };
  assert.equal(classifyEvent(echoed), 'drop');
});

test('AC1 classifyEvent: malformed input never throws and always drops', () => {
  assert.equal(classifyEvent(null), 'drop');
  assert.equal(classifyEvent({}), 'drop', 'no `event` field at all: nothing to classify');
});

test('AC1 classifyEvent: an unrecognized event kind digests rather than vanishing silently', () => {
  // A brand-new `event` value orca-census.cjs might start writing tomorrow must still
  // surface (bounded, in the next digest) instead of disappearing forever — this default
  // is what the AC6 mutation test proves is load-bearing.
  assert.equal(classifyEvent({ event: 'something-new' }), 'digest');
});

// ── AC2: digest builder ────────────────────────────────────────────────────────────

test('AC2 buildDigests: one message per window, grouped by lane, with task_id/outcome/report', () => {
  const roster = { lanes: [{ lane: 'wezbridge', handle: 'term_abc' }, { lane: 'pedrito', handle: 'term_xyz' }] };
  const events = [
    { event: 'suborch_done', task_id: 'T-100', outcome: 'succeeded', report: 'PR#1', terminal: 'term_abc', time: '2026-09-23T10:05:00Z' },
    { event: 'suborch_done', task_id: 'T-101', outcome: 'succeeded', report: 'PR#2', terminal: 'term_xyz', time: '2026-09-23T10:12:00Z' },
    { event: 'suborch_handoff', path: '_intel/briefs/h.md', terminal: 'term_abc', time: '2026-09-23T10:20:00Z' },
    // next window (30 min later)
    { event: 'suborch_done', task_id: 'T-102', outcome: 'succeeded', terminal: 'term_xyz', time: '2026-09-23T10:40:00Z' },
  ];
  const digests = buildDigests(events, { windowMs: DEFAULT_WINDOW_MS, roster });
  assert.equal(digests.length, 2, 'two distinct 30-min windows -> two digest messages');
  assert.equal(digests[0].items.length, 3);
  assert.deepEqual(new Set(digests[0].lanes), new Set(['wezbridge', 'pedrito']));
  assert.ok(digests[0].items.some((i) => i.task_id === 'T-100' && i.outcome === 'succeeded'));
  assert.match(digests[0].message, /wezbridge:.*T-100/);
  assert.match(digests[0].message, /pedrito:.*T-101/);
  assert.equal(digests[1].items[0].task_id, 'T-102');
});

test('AC2 buildDigests: a window with no digest events produces nothing (no empty digests)', () => {
  assert.deepEqual(buildDigests([], { windowMs: DEFAULT_WINDOW_MS, roster: { lanes: [] } }), []);
});

test('AC2 resolveLane: falls back to repo when no roster handle matches', () => {
  assert.equal(resolveLane({ terminal: 'term_unknown', repo: 'pedrito' }, { lanes: [] }), 'pedrito');
  assert.equal(resolveLane({ repo: 'wezbridge' }, { lanes: [] }), 'wezbridge');
});

// ── AC3: durable cursor + sent.jsonl + --count-day, isolated state dir ────────────

test('AC3 runOnce: cursor advances, immediate sends land in sent.jsonl, dry-run never calls send()', (t) => {
  const dir = tmpDir(t, 'fleet-digest-ac3-');
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, '.fleet-digest');
  fs.writeFileSync(eventsPath, '');
  // A fresh cursor starts at EOF (same convention as orchestrator-waker.cjs: a digest
  // signals new activity, it never replays history) — the FIRST runOnce on an empty
  // file establishes that baseline; only lines appended AFTER it are ingested.
  runOnce({ eventsPath, stateDir, roster: { lanes: [] }, now: () => Date.parse('2026-09-23T09:59:00Z') });
  const line = (evt) => fs.appendFileSync(eventsPath, `${JSON.stringify(evt)}\n`);
  line({ event: 'suborch_question', task_id: 'T-200', q: 'approve?', terminal: 'term_abc', repo: 'wezbridge', time: '2026-09-23T10:00:00Z' });
  line({ event: 'turn-end', repo: 'wezbridge', time: '2026-09-23T10:00:05Z' });

  let sendCalls = 0;
  const result = runOnce({
    eventsPath, stateDir, roster: { lanes: [] },
    sendEnabled: false, send: () => { sendCalls += 1; return { ok: true }; },
    now: () => Date.parse('2026-09-23T10:00:10Z'),
  });
  assert.equal(sendCalls, 0, 'dry-run must never call send()');
  assert.equal(result.immediateSent.length, 1);
  assert.match(result.immediateSent[0].message, /T-200/);

  const cursor = JSON.parse(fs.readFileSync(path.join(stateDir, 'cursor.json'), 'utf8'));
  assert.equal(cursor.bytes, fs.statSync(eventsPath).size, 'cursor advanced to end of the ingested bytes');

  const sent = fs.readFileSync(path.join(stateDir, 'sent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'immediate');
  assert.equal(sent[0].delivered, null, 'dry-run records delivered:null, not a fabricated true/false');
  assert.equal(sent[0].n_events, 1);

  // a second tick with no new lines must not re-send the same event
  const second = runOnce({
    eventsPath, stateDir, roster: { lanes: [] }, sendEnabled: false,
    now: () => Date.parse('2026-09-23T10:00:20Z'),
  });
  assert.equal(second.immediateSent.length, 0);
});

test('AC3 runOnce --send: send() is called and delivered reflects its result', (t) => {
  const dir = tmpDir(t, 'fleet-digest-ac3-send-');
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, '.fleet-digest');
  fs.writeFileSync(eventsPath, '');
  runOnce({ eventsPath, stateDir, roster: { lanes: [] }, now: () => Date.parse('2026-09-23T09:59:00Z') });
  fs.appendFileSync(eventsPath, `${JSON.stringify({ event: 'suborch_question', task_id: 'T-201', terminal: 't', repo: 'r', time: '2026-09-23T10:00:00Z' })}\n`);
  const sentMessages = [];
  const result = runOnce({
    eventsPath, stateDir, roster: { lanes: [] }, sendEnabled: true,
    send: (message) => { sentMessages.push(message); return { ok: true }; },
    now: () => Date.parse('2026-09-23T10:00:01Z'),
  });
  assert.equal(sentMessages.length, 1, 'send() stub was invoked — never a real notify_orchestrator.py call');
  assert.equal(result.immediateSent[0].entry.delivered, true);
});

test('AC3 digest flushes once its window closes, not before', (t) => {
  const dir = tmpDir(t, 'fleet-digest-ac3-window-');
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, '.fleet-digest');
  fs.writeFileSync(eventsPath, '');
  runOnce({ eventsPath, stateDir, roster: { lanes: [] }, now: () => Date.parse('2026-09-23T09:59:00Z') });
  fs.appendFileSync(eventsPath, `${JSON.stringify({ event: 'suborch_done', task_id: 'T-300', outcome: 'succeeded', terminal: 't', repo: 'r', time: '2026-09-23T10:05:00Z' })}\n`);

  const early = runOnce({ eventsPath, stateDir, roster: { lanes: [] }, now: () => Date.parse('2026-09-23T10:10:00Z') });
  assert.equal(early.digestSent, null, 'window has not closed yet (30-min window starting 10:00Z ends 10:30Z)');

  const late = runOnce({ eventsPath, stateDir, roster: { lanes: [] }, now: () => Date.parse('2026-09-23T10:35:00Z') });
  assert.ok(late.digestSent, 'window closed -> exactly one digest message flushed');
  assert.equal(late.digestSent.entry.n_events, 1);

  const sent = fs.readFileSync(path.join(stateDir, 'sent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(sent.filter((e) => e.kind === 'digest').length, 1, 'exactly one digest message for the window, not one per event');
});

test('AC3 --count-day counts only sends recorded on that UTC day', (t) => {
  const dir = tmpDir(t, 'fleet-digest-ac3-countday-');
  const stateDir = path.join(dir, '.fleet-digest');
  fs.mkdirSync(stateDir, { recursive: true });
  const sentFile = path.join(stateDir, 'sent.jsonl');
  fs.writeFileSync(sentFile, [
    { at: '2026-09-23T10:00:00Z', kind: 'immediate', n_events: 1, lanes: ['a'], message_sha1: 'x', delivered: null },
    { at: '2026-09-23T18:00:00Z', kind: 'digest', n_events: 3, lanes: ['a'], message_sha1: 'y', delivered: null },
    { at: '2026-09-24T00:30:00Z', kind: 'immediate', n_events: 1, lanes: ['b'], message_sha1: 'z', delivered: null },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(countDay(stateDir, '2026-09-23'), 2);
  assert.equal(countDay(stateDir, '2026-09-24'), 1);
  assert.equal(countDay(stateDir, '2026-09-25'), 0);
});

test('AC3 tests never touch the real _intel state dir', () => {
  const real = path.join(resolveIntelDir(__dirname), '.fleet-digest');
  const before = fs.existsSync(real) ? fs.readdirSync(real) : null;
  // (the suite above only ever passes tmpDir() state dirs — this asserts that invariant held)
  const after = fs.existsSync(real) ? fs.readdirSync(real) : null;
  assert.deepEqual(before, after, 'no test in this file may create or modify _intel/.fleet-digest');
});

// ── AC4: stateless replay against the REAL pane-events.jsonl ──────────────────────

test('AC4 runReplay: 23/09 00:00Z-24/09 00:00Z predicts under 10 sends/day and never writes state', () => {
  assert.ok(fs.existsSync(REAL_EVENTS), 'real _intel/pane-events.jsonl must exist to replay against');
  const realStateDir = path.join(resolveIntelDir(__dirname), '.fleet-digest');
  const before = fs.existsSync(realStateDir) ? JSON.stringify(fs.readdirSync(realStateDir).sort()) : null;

  const r = runReplay({
    eventsPath: REAL_EVENTS, from: '2026-09-23T00:00:00Z', to: '2026-09-24T00:00:00Z',
    windowMs: DEFAULT_WINDOW_MS, roster: { lanes: [] },
  });

  const after = fs.existsSync(realStateDir) ? JSON.stringify(fs.readdirSync(realStateDir).sort()) : null;
  assert.equal(before, after, 'replay is read-only: it must not create or touch _intel/.fleet-digest');

  assert.ok(r.rawEvents > 0, 'the replay window must contain real events');
  assert.ok(r.predictedSendsPerDay < 10, `S6 requires <10 predicted sends/day, got ${r.predictedSendsPerDay}`);
  // Regression-baseline snapshot for the CLOSED calendar day 2026-09-23 (safe to pin
  // exactly: that day is in the past, so future appends to the real file — which only
  // ever land with later timestamps — can never change these counts). AC6: a mutation
  // that removes 'suborch_status' from the drop set turns 37 status lines (see the
  // T-0409 scope report) into `digest` events; they still batch into few messages by
  // 30-min window, but the digest_messages count here moves 1 -> 2 and this assertion
  // goes red, even though predictedSendsPerDay alone would not (yet) cross 10.
  assert.equal(r.immediateCount, 3, 'baseline: 3 immediate (suborch_question) events on 23/09');
  assert.equal(r.digestMessageCount, 1, 'baseline: 1 digest window on 23/09 — see AC6 mutation comment above');
  console.log(`[AC4 evidence] raw_events=${r.rawEvents} immediate=${r.immediateCount} digest_messages=${r.digestMessageCount} predicted_sends/day=${r.predictedSendsPerDay.toFixed(2)}`);
});

test('AC4 CLI: --dry-run --replay prints raw event count next to the predicted sends/day', () => {
  const res = spawnSync('node', [
    path.join(__dirname, '..', 'scripts', 'fleet-digest.cjs'),
    '--dry-run', '--replay', '--from', '2026-09-23T00:00:00Z', '--to', '2026-09-24T00:00:00Z',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /raw_events=\d+/);
  assert.match(res.stdout, /predicted_sends\/day=\d+(\.\d+)?/);
});

// ── AC5: pane-event-watcher.py --kinds filter ──────────────────────────────────────
// The watcher's own filter logic (parse_kinds/should_emit/format_alert) has a
// dedicated python unittest: scripts/test_pane_event_watcher.py (same convention as
// scripts/orchestration/test_codex_worker.py — run with `python scripts/test_pane_event_watcher.py -v`,
// not part of `npm test`, which only runs test/*.test.cjs). This is a CLI-level smoke
// test: without --kinds, --help/argv parsing does not crash and the flag is accepted.

test('AC5 pane-event-watcher.py: python unit tests (parse_kinds/should_emit/format_alert) pass', () => {
  const res = spawnSync('python', [path.join(__dirname, '..', 'scripts', 'test_pane_event_watcher.py'), '-v'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
});

test('AC5 pane-event-watcher.py: --kinds is accepted on argv and reported at startup, no crash', (t) => {
  const dir = tmpDir(t, 'fleet-digest-watcher-cli-');
  const eventsFile = path.join(dir, 'pane-events.jsonl');
  fs.writeFileSync(eventsFile, `${JSON.stringify({ event: 'turn-end', repo: 'r' })}\n`);
  const watcher = path.join(__dirname, '..', 'scripts', 'pane-event-watcher.py');
  const proc = spawnSync('python', [
    watcher, '--events-file', eventsFile, '--kinds', 'suborch_question,worker-done',
  ], { encoding: 'utf8', timeout: 2000 });
  // The watcher's main loop never exits on its own (tails forever) — spawnSync times
  // out and kills it; what matters here is startup did not crash before the timeout,
  // and the WATCHER-STARTED line names the active filter.
  assert.match(proc.stdout || '', /\[WATCHER-STARTED\].*kinds filter: \['suborch_question', 'worker-done'\]/);
});
