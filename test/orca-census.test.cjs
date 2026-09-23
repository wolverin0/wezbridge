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

test('suite hermeticity: test/setup.cjs keeps daemons from polling the real Orca', () => {
  assert.equal(process.env.WEZBRIDGE_ORCA_CENSUS, '0');
});
