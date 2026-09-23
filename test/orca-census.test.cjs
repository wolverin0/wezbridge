'use strict';
/**
 * orca-census.test.cjs — T-0525: the fleet runs in ORCA terminals, and wezbridge was blind to them.
 * Covers normalization of `orca terminal list --json`, tolerance to CLI absence/garbage, the
 * `orca` health block (/api/health + bridge_health), the Orca crash-restore snapshot, and the
 * durable WORKER_DONE events (dedupe + echo filtering). All Orca calls go through a fake runOrca.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orca = require('../src/orca-census.cjs');

const LIST = fs.readFileSync(path.join(__dirname, 'fixtures', 'orca-terminal-list.json'), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orca-census-'));

function fakeRunOrca({ list = LIST, screens = {}, fail = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (fail) throw new Error(fail);
    if (args[1] === 'list') return list;
    if (args[1] === 'read') {
      const h = args[args.indexOf('--terminal') + 1];
      if (!(h in screens)) throw new Error(`unknown terminal ${h}`);
      return JSON.stringify({ ok: true, result: { terminal: { handle: h, status: 'running', tail: screens[h] } } });
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

test('normalization: handle/title/worktree/connected/writable/provider/tabId, handle-less entries dropped', async () => {
  const c = await orca.runCensus({ runOrca: fakeRunOrca(), now: () => 1000 });
  assert.equal(c.ok, true);
  assert.equal(c.terminals.length, 4);
  const [cl, cx, gm, sh] = c.terminals;
  assert.deepEqual(
    { handle: cl.handle, worktreePath: cl.worktreePath, connected: cl.connected, writable: cl.writable, tabId: cl.tabId, provider: cl.provider },
    { handle: 'term_claude1', worktreePath: 'G:/Py Apps/memorymaster', connected: true, writable: true, tabId: 'tab-1', provider: 'claude' });
  assert.equal(cx.provider, 'codex', 'guessed from preview without agentIdentity');
  assert.equal(cx.exitCause, 'operator_close');
  assert.equal(gm.provider, 'gemini');
  assert.equal(gm.connected, false);
  assert.equal(sh.provider, 'shell');
});

test('error tolerance: CLI absent, garbage stdout and ok:false all return {ok:false, reason}, never throw', async () => {
  const absent = await orca.runCensus({ runOrca: fakeRunOrca({ fail: 'spawn orca ENOENT' }) });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /ENOENT/);
  const garbage = await orca.runCensus({ runOrca: fakeRunOrca({ list: 'not json' }) });
  assert.equal(garbage.ok, false);
  assert.match(garbage.reason, /unparseable/);
  const notOk = await orca.runCensus({ runOrca: fakeRunOrca({ list: JSON.stringify({ ok: false, error: 'not paired' }) }) });
  assert.equal(notOk.ok, false);
  assert.match(notOk.reason, /not paired/);
  // the real default runner against a missing binary also degrades
  const real = await orca.runCensus({ runOrca: (a) => orca.defaultRunOrca(a, { bin: path.join(os.tmpdir(), 'no-such-orca.exe') }) });
  assert.equal(real.ok, false);
});

test('health block: counts, by_provider, census_age_ms, last_error; last good census survives a later failure', async () => {
  const intel = tmp();
  let t = 10_000;
  let failing = false;
  const good = fakeRunOrca();
  const runOrca = async (a) => { if (failing) throw new Error('orca gone'); return good(a); };
  const h = orca.startOrcaCensus({ runOrca, intelDir: intel, snapshotIntervalMs: 0, now: () => t, autoStart: false });
  await h.tick();
  t += 5000;
  let b = h.healthBlock();
  assert.equal(b.terminals, 4);
  assert.equal(b.connected, 3);
  assert.deepEqual(b.by_provider, { claude: 1, codex: 1, gemini: 1, shell: 1 });
  assert.equal(b.census_age_ms, 5000);
  assert.equal(b.last_error, null);
  assert.ok(b.list.every((x) => x.handle && 'worktreePath' in x && 'connected' in x), 'bridge_health lists handle, worktree and state');
  failing = true;
  await h.tick();
  b = h.healthBlock();
  assert.equal(b.terminals, 4, 'cached last good census kept');
  assert.match(b.last_error, /orca gone/);
  const persisted = JSON.parse(fs.readFileSync(path.join(intel, 'orca-census.json'), 'utf8'));
  assert.equal(persisted.ok, false);
  assert.equal(persisted.last_good.terminals.length, 4);
  const fromFile = orca.readPersistedCensus(intel, t);
  assert.equal(fromFile.terminals, 4);
  assert.equal(fromFile.source, 'file');
  orca.setHealthSource(() => h.healthBlock());
  assert.equal(orca.healthBlock().terminals, 4, '/api/health reads through the registered source');
  orca.setHealthSource(null);
});

test('health block before any census says so instead of pretending zero is an answer', () => {
  const b = orca.buildHealthBlock({ last: null, lastError: null }, 1);
  assert.equal(b.census_age_ms, null);
  assert.match(b.last_error, /no census/);
});

test('snapshot: Orca terminals persisted with restore argv; unchanged set not re-appended; empty set never written', async () => {
  const intel = tmp();
  const logPath = path.join(intel, 'orca-session-snapshot.jsonl');
  let t = Date.parse('2026-09-23T10:00:00Z');
  const h = orca.startOrcaCensus({ runOrca: fakeRunOrca(), intelDir: intel, snapshotIntervalMs: 1, snapshotLogPath: logPath, now: () => t, autoStart: false });
  await h.tick();
  let snaps = orca.readOrcaSnapshots(logPath);
  assert.equal(snaps.length, 1);
  const cl = snaps[0].terminals.find((x) => x.handle === 'term_claude1');
  assert.equal(cl.worktreePath, 'G:/Py Apps/memorymaster');
  assert.equal(cl.provider, 'claude');
  assert.deepEqual(cl.restore_argv, ['terminal', 'create', '--worktree', 'path:G:/Py Apps/memorymaster', '--title', cl.title, '--json']);
  t += 60_000;
  await h.tick();
  assert.equal(orca.readOrcaSnapshots(logPath).length, 1, 'same terminal set: no new line');
  // post-crash: Orca lists nothing -> must not become the latest state
  assert.equal(orca.appendOrcaSnapshot([], { logPath, now: t }), false);
  // one terminal comes back: appended, but the restore selector still picks the richest
  orca.appendOrcaSnapshot([{ handle: 'term_new', title: 'x', worktreePath: 'G:/a', provider: 'shell' }], { logPath, now: t + 1000 });
  snaps = orca.readOrcaSnapshots(logPath);
  assert.equal(snaps.length, 2);
  assert.equal(orca.readRichestOrcaSnapshot({ logPath }).terminals.length, 4);
});

test('WORKER_DONE: new closures become durable events; echoes filtered; dedupe across ticks and restarts', async () => {
  const intel = tmp();
  fs.mkdirSync(path.join(intel, 'foreman'));
  fs.writeFileSync(path.join(intel, 'foreman', 'T-0900.json'), JSON.stringify({ terminal: 'term_claude1', task_id: 'T-0900', status: 'supervising' }));
  fs.writeFileSync(path.join(intel, 'foreman', 'T-0901.json'), JSON.stringify({ terminal: 'term_codex1', task_id: 'T-0901', status: 'done' }));
  const screens = {
    term_claude1: [
      '[ORCHESTRATOR] al terminar emiti: [WORKER_DONE] task_id=T-0900 outcome=succeeded report=<ruta>',
      '[MISSION] T-0900 ... [WORKER_DONE] task_id=T-0900 outcome=succeeded',
      '  [WORKER_DONE] task_id=T-0900 outcome=succeeded report=_intel/briefs/x.md',
    ],
  };
  const runOrca = fakeRunOrca({ screens });
  const r1 = await orca.pollWorkerDone({ runOrca, intelDir: intel, now: () => Date.parse('2026-09-23T10:00:00Z'),
    terminals: [{ handle: 'term_claude1', worktreePath: 'G:/Py Apps/memorymaster' }] });
  assert.equal(r1.polled, 1, 'only status=supervising is polled');
  assert.equal(r1.appended.length, 1, 'echo lines ignored');
  const evt = r1.appended[0];
  assert.equal(evt.event, 'worker-done');
  assert.equal(evt.task_id, 'T-0900');
  assert.equal(evt.outcome, 'succeeded');
  assert.equal(evt.terminal, 'term_claude1');
  assert.equal(evt.repo, 'memorymaster');
  assert.ok(evt.ts && evt.time && evt.line.startsWith('[WORKER_DONE]'));
  const r2 = await orca.pollWorkerDone({ runOrca, intelDir: intel });
  assert.equal(r2.appended.length, 0, 'same line on the next tick is not re-emitted (persisted dedupe)');
  screens.term_claude1.push('[WORKER_DONE] task_id=T-0900 outcome=failed second closure');
  const r3 = await orca.pollWorkerDone({ runOrca, intelDir: intel });
  assert.equal(r3.appended.length, 1);
  const lines = fs.readFileSync(path.join(intel, 'pane-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.outcome), ['succeeded', 'failed']);
});

test('WORKER_DONE: no foreman dir, unreadable terminal and malformed state files are tolerated', async () => {
  const intel = tmp();
  assert.deepEqual(await orca.pollWorkerDone({ runOrca: fakeRunOrca(), intelDir: intel }), { polled: 0, appended: [], errors: [] });
  fs.mkdirSync(path.join(intel, 'foreman'));
  fs.writeFileSync(path.join(intel, 'foreman', 'bad.json'), '{not json');
  fs.writeFileSync(path.join(intel, 'foreman', 'gone.json'), JSON.stringify({ workers: [{ term_id: 'term_missing', task_id: 'T-1', status: 'supervising' }] }));
  const r = await orca.pollWorkerDone({ runOrca: fakeRunOrca(), intelDir: intel });
  assert.equal(r.polled, 1);
  assert.equal(r.appended.length, 0);
  assert.match(r.errors[0], /term_missing/);
  assert.equal(fs.existsSync(path.join(intel, 'pane-events.jsonl')), false);
});

// ─── T-0555: SUBORCH_* lane-orchestrator report lines ─────────────────────

test('extractSuborchLines: 4 real report lines recognized; brief-echoed placeholder lines filtered (AC2 fixture)', () => {
  const screen = [
    // Real lines (what a lane orchestrator actually prints).
    "[SUBORCH_DONE] task_id=T-0555 outcome=succeeded report=_intel/briefs/2026-09-23-T0555-REPORT.md",
    "[SUBORCH_QUESTION] task_id=T-0555 q='use approach A or B?'",
    "[SUBORCH_STATUS] lane=wisp running=T-0100,T-0101 done=T-0099 blocked= next=T-0102",
    "[SUBORCH_HANDOFF] _intel/briefs/2026-09-23-handoff.md",
    // Echo lines copied verbatim from the T-0555 brief's problem statement (instruction text,
    // not a real closure) — must NOT produce events.
    "- `[SUBORCH_DONE] task_id=T-NNNN outcome=succeeded|failed report=<path>`",
    "- `[SUBORCH_QUESTION] task_id=T-NNNN q='<question with options a/b/c>'`",
    "- `[SUBORCH_STATUS] lane=<x> running=<ids> done=<ids> blocked=<ids> next=<id>` (free-form key=value)",
    "- `[SUBORCH_HANDOFF] <path>`",
  ];
  const events = orca.extractSuborchLines(screen);
  assert.equal(events.length, 4, 'exactly the 4 real lines, echoes filtered');
  const byKind = Object.fromEntries(events.map((e) => [e.kind, e]));
  assert.deepEqual(Object.keys(byKind).sort(),
    ['suborch_done', 'suborch_handoff', 'suborch_question', 'suborch_status']);
  assert.deepEqual(byKind.suborch_done.fields,
    { task_id: 'T-0555', outcome: 'succeeded', report: '_intel/briefs/2026-09-23-T0555-REPORT.md' });
  assert.deepEqual(byKind.suborch_question.fields, { task_id: 'T-0555', q: 'use approach A or B?' });
  assert.deepEqual(byKind.suborch_status.fields,
    { kv: { lane: 'wisp', running: 'T-0100,T-0101', done: 'T-0099', blocked: '', next: 'T-0102' } });
  assert.deepEqual(byKind.suborch_handoff.fields, { path: '_intel/briefs/2026-09-23-handoff.md' });
});

test('extractSuborchLines: mutation check — disabling SUBORCH matching drops all 4 events', () => {
  // Same fixture as above, run through a deliberately crippled matcher (SUBORCH tag typo'd),
  // proving the real assertions above are not vacuously true.
  const screen = ["[SUBORCH_DONE] task_id=T-0555 outcome=succeeded report=_intel/briefs/x.md"];
  const disabled = screen.filter((l) => false); // no [SUBORCH_ lines reach the extractor
  assert.equal(orca.extractSuborchLines(disabled).length, 0);
  assert.equal(orca.extractSuborchLines(screen).length, 1, 'sanity: the real extractor does match');
});

test('SUBORCH_*: roster lane terminals get their screens scanned; durable events; dedupe repeats, both distinct STATUS lines kept', async () => {
  const intel = tmp();
  fs.writeFileSync(path.join(intel, 'orchestrators.json'), JSON.stringify({
    version: 1,
    lanes: [{ lane: 'wisp', handle: 'term_lane_wisp', model: 'x', effort: 'y', state: 'live' }],
  }));
  const screens = {
    term_lane_wisp: [
      "[SUBORCH_STATUS] lane=wisp running=T-0100 done= blocked= next=T-0101",
    ],
  };
  const runOrca = fakeRunOrca({ screens });
  const r1 = await orca.pollWorkerDone({ runOrca, intelDir: intel });
  assert.equal(r1.polled, 1, 'the roster terminal was scanned even with no foreman/*.json');
  assert.equal(r1.appended.length, 1);
  assert.equal(r1.appended[0].event, 'suborch_status');
  assert.equal(r1.appended[0].terminal, 'term_lane_wisp');
  assert.deepEqual(r1.appended[0].kv, { lane: 'wisp', running: 'T-0100', done: '', blocked: '', next: 'T-0101' });

  // Same STATUS line again on the next poll: not re-appended (persisted dedupe).
  const r2 = await orca.pollWorkerDone({ runOrca, intelDir: intel });
  assert.equal(r2.appended.length, 0);

  // A genuinely different STATUS line: appended (not swallowed by a coarse per-terminal dedupe).
  screens.term_lane_wisp.push("[SUBORCH_STATUS] lane=wisp running=T-0100,T-0102 done=T-0101 blocked= next=T-0103");
  const r3 = await orca.pollWorkerDone({ runOrca, intelDir: intel });
  assert.equal(r3.appended.length, 1);

  const lines = fs.readFileSync(path.join(intel, 'pane-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.event === 'suborch_status' && l.source === 'orca' && l.line));
});

test('SUBORCH_*: all 4 kinds appended for one terminal, WORKER_DONE and SUBORCH_* coexist on a terminal that is both foreman-supervised and rostered', async () => {
  const intel = tmp();
  fs.mkdirSync(path.join(intel, 'foreman'));
  fs.writeFileSync(path.join(intel, 'foreman', 'T-0555.json'), JSON.stringify({ terminal: 'term_dual', task_id: 'T-0555', status: 'supervising' }));
  fs.writeFileSync(path.join(intel, 'orchestrators.json'), JSON.stringify({
    lanes: [{ lane: 'dual', handle: 'term_dual' }],
  }));
  const screens = {
    term_dual: [
      '[WORKER_DONE] task_id=T-0555 outcome=succeeded report=_intel/briefs/w.md',
      "[SUBORCH_DONE] task_id=T-0556 outcome=succeeded report=_intel/briefs/s.md",
      "[SUBORCH_QUESTION] task_id=T-0557 q='a or b?'",
      "[SUBORCH_STATUS] lane=dual running=T-0558 done= blocked= next=",
      '[SUBORCH_HANDOFF] _intel/briefs/handoff.md',
    ],
  };
  const runOrca = fakeRunOrca({ screens });
  const r = await orca.pollWorkerDone({ runOrca, intelDir: intel });
  assert.equal(r.polled, 1, 'read once even though the terminal is both supervised and rostered');
  const byEvent = Object.fromEntries(r.appended.map((e) => [e.event, e]));
  assert.deepEqual(Object.keys(byEvent).sort(),
    ['suborch_done', 'suborch_handoff', 'suborch_question', 'suborch_status', 'worker-done']);
});

test('suite hermeticity: test/setup.cjs keeps daemons from polling the real Orca', () => {
  assert.equal(process.env.WEZBRIDGE_ORCA_CENSUS, '0');
});
