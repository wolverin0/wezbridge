'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Isolated environment BEFORE requiring the module: temp intel dir + a temp
// ledger copy (real ledger.cjs, synthetic sweeper-config + repo contract) so
// contractFor/born-blocked runs against the REAL enforcement code without
// touching fleet state.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtrol-bridge-'));
const INTEL = path.join(TMP, '_intel');
const LEDGER = path.join(TMP, '_docs-curation');
const REPO = path.join(TMP, 'fakerepo');
fs.mkdirSync(INTEL, { recursive: true });
fs.mkdirSync(LEDGER, { recursive: true });
fs.mkdirSync(path.join(REPO, '.agent-workflow'), { recursive: true });
// Locate the real ledger.cjs regardless of checkout depth: repo root sits at
// <Py Apps>/wezbridge (2 up from test/), <Py Apps>/_worktrees/<name> (3 up),
// OR <Py Apps>/wezbridge/.claude/worktrees/<name> (5 up — workflow worktrees).
const LEDGER_SRC = [
  path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(__dirname, '..', '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(__dirname, '..', '..', '..', '..', '..', '_docs-curation', 'ledger.cjs'),
].find((p) => fs.existsSync(p));
if (!LEDGER_SRC) throw new Error('cannot locate _docs-curation/ledger.cjs from this checkout');
fs.copyFileSync(LEDGER_SRC, path.join(LEDGER, 'ledger.cjs'));
fs.writeFileSync(path.join(LEDGER, 'sweeper-config.json'), JSON.stringify({
  root: TMP,
  repos: [{ name: 'fakerepo', path: 'fakerepo' }],
}));
fs.writeFileSync(path.join(REPO, '.agent-workflow', 'graph.json'), JSON.stringify({
  version: 1,
  repo: 'fakerepo',
  defaults: { mode: 'scoped_write' },
  kinds: {
    'safe-kind': { mode: 'read_mostly', gate: null },
    deploy: { mode: 'none', gate: 'operator' },
  },
}));
process.env.WEZBRIDGE_INTEL_DIR = INTEL;
process.env.WEZBRIDGE_LEDGER_DIR = LEDGER;
const bridge = require('../src/clawtrol-bridge.cjs');

function writeIntelFile(name, lines) {
  fs.writeFileSync(path.join(INTEL, name), lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
}

test('cursor delta: reads complete lines with offsets, replays on unchanged cursor', () => {
  writeIntelFile('events.jsonl', [{ time: 't1', event: 'a', corr: 'c1' }, { time: 't2', event: 'b', corr: 'c2' }]);
  const first = bridge.readDelta('events.jsonl', {});
  assert.strictEqual(first.entries.length, 2);
  assert.strictEqual(first.entries[0].offset, 0);
  // Unpersisted cursor (failed sync) → same delta replays.
  const replay = bridge.readDelta('events.jsonl', {});
  assert.strictEqual(replay.entries.length, 2);
  // Persisted cursor → nothing new.
  const after = bridge.readDelta('events.jsonl', { 'events.jsonl': first.nextOffset });
  assert.strictEqual(after.entries.length, 0);
});

test('cursor rotation/truncation: cursor beyond size resets to 0 and rereads', () => {
  writeIntelFile('events.jsonl', [{ time: 't3', event: 'after-rotation' }]);
  const size = fs.statSync(path.join(INTEL, 'events.jsonl')).size;
  const res = bridge.readDelta('events.jsonl', { 'events.jsonl': size + 5000 });
  assert.strictEqual(res.entries.length, 1);
  assert.match(res.entries[0].line, /after-rotation/);
});

test('toWireEvent: task-scoped lines map with attempt>=1; fleet lines return null', () => {
  const taskLine = { line: JSON.stringify({ time: 't', event: 'ledger.update', task_id: 'T-0042', attempt: 2 }), offset: 10 };
  const wire = bridge.toWireEvent('events.jsonl', taskLine);
  assert.strictEqual(wire.task_id, 'T-0042');
  assert.strictEqual(wire.attempt, 2);
  assert.strictEqual(wire.seq, bridge.FILE_SEQ_BASE['events.jsonl'] + 10 + 1);
  assert.strictEqual(wire.external_id, 'events.jsonl:10');
  // Fleet-level beacon → null (v1 boundary: Rails rejects null task_id).
  const beacon = { line: JSON.stringify({ time: 't', event: 'turn-end', repo: 'x', markers: [] }), offset: 0 };
  assert.strictEqual(bridge.toWireEvent('pane-events.jsonl', beacon), null);
});

test('fleetSummary: beacons count by repo, notable = permission-wait/GATE markers', () => {
  const entries = {
    'pane-events.jsonl': [
      { line: JSON.stringify({ repo: 'a', event: 'turn-end', markers: [] }), offset: 0 },
      { line: JSON.stringify({ repo: 'a', event: 'permission-wait', time: 'tt' }), offset: 50 },
    ],
    'events.jsonl': [{ line: JSON.stringify({ event: 'a2a.sent' }), offset: 0 }],
  };
  const s = bridge.fleetSummary(entries);
  assert.strictEqual(s.beacons_by_repo.a, 2);
  assert.strictEqual(s.a2a_envelopes, 1);
  assert.strictEqual(s.last_notable.event, 'permission-wait');
});

test('message provenance: only orchestrator|worker sync up; operator stays local', () => {
  const mk = (prov) => ({ line: JSON.stringify({ time: 't', task_id: 'T-0001', provenance: prov, content: 'x' }), offset: 0 });
  assert.ok(bridge.toWireMessage(mk('orchestrator')));
  assert.ok(bridge.toWireMessage(mk('worker')));
  assert.strictEqual(bridge.toWireMessage(mk('operator')), null);
  assert.strictEqual(bridge.toWireMessage(mk(undefined)), null);
});

test('defect-1 regression: create_task accepts Rails wire keys {project, brief, acceptance}', async () => {
  const r = await bridge.applyIntent({
    id: 'i-wire1', kind: 'create_task',
    payload: { project: 'fakerepo', kind: 'safe-kind', title: 'wire-shape task', brief: 'created via project/brief keys', priority: 'high', acceptance: ['criterion A', 'criterion B'] },
  });
  assert.strictEqual(r.status, 'applied');
  assert.match(String(r.result.task_id), /^T-\d+$/);
  assert.match(String(r.result.note || ''), /priority not persisted/);
});

test('defect-2 regression: task id resolves from task_origin_key when payload lacks task_id', async () => {
  assert.strictEqual(bridge.resolveTaskId({ payload: { task_id: 'T-0042' } }), 'T-0042');
  assert.strictEqual(bridge.resolveTaskId({ payload: {}, task_origin_key: 'wezbridge:wolverin0:task:T-0099' }), 'T-0099');
  assert.strictEqual(bridge.resolveTaskId({ payload: {}, task_origin_key: 'wezbridge:u1:T-0099:attempt:2' }), null); // wrong shape → no guess
  // cancel via origin key against a real created task
  const created = await bridge.applyIntent({ id: 'i-ok1', kind: 'create_task', payload: { project: 'fakerepo', kind: 'safe-kind', title: 'to cancel', brief: 'x' } });
  const cancelled = await bridge.applyIntent({ id: 'i-ok2', kind: 'cancel', payload: {}, task_origin_key: `wezbridge:test:task:${created.result.task_id}` });
  assert.strictEqual(cancelled.status, 'applied');
  assert.strictEqual(cancelled.result.task_state, 'cancelled');
});

test('defect-3 regression: seq namespaced per file (no cross-file collision) and payload allowlisted', () => {
  const mk = (line, offset) => ({ line, offset });
  const taskLine = JSON.stringify({ time: 't', event: 'ledger.update', task_id: 'T-0001', attempt: 1, corr: 'c', secret_blob: 'MUST-NOT-SHIP', body: 'raw content MUST-NOT-SHIP' });
  const e1 = bridge.toWireEvent('events.jsonl', mk(taskLine, 500));
  const e2 = bridge.toWireEvent('pane-events.jsonl', mk(JSON.stringify({ time: 't', event: 'turn-end', task_id: 'T-0001', repo: 'r' }), 500));
  assert.notStrictEqual(e1.seq, e2.seq); // same offset, different files → distinct seq
  assert.ok(Number.isSafeInteger(e1.seq) && Number.isSafeInteger(e2.seq));
  assert.ok(e1.seq > 0 && e2.seq > 0);
  // Allowlist: metadata fields survive, unknown/content fields do NOT.
  assert.strictEqual(e1.payload.corr, 'c');
  assert.strictEqual(e1.payload.file, 'events.jsonl');
  assert.strictEqual(e1.payload.cursor, 500);
  assert.strictEqual(e1.payload.secret_blob, undefined);
  assert.strictEqual(e1.payload.body, undefined);
  assert.ok(!JSON.stringify(e1.payload).includes('MUST-NOT-SHIP'));
});

test('applyIntent: unknown kind rejected with structured result', async () => {
  const r = await bridge.applyIntent({ id: 'i-x1', kind: 'reassign', payload: {} });
  assert.strictEqual(r.status, 'rejected');
  assert.match(r.result.reason, /unknown intent kind/);
});

test('applyIntent create_task: contractFor applies — gated kind BORN BLOCKED, safe kind not', async () => {
  const gated = await bridge.applyIntent({ id: 'i-g1', kind: 'create_task', payload: { repo: 'fakerepo', kind: 'deploy', title: 'deploy it', goal: 'ship' } });
  assert.strictEqual(gated.status, 'applied');
  assert.match(String(gated.result.task_id), /^T-\d+$/);
  assert.strictEqual(gated.result.task_state, 'blocked'); // operator gate → born blocked, no matter the source
  const safe = await bridge.applyIntent({ id: 'i-s1', kind: 'create_task', payload: { repo: 'fakerepo', kind: 'safe-kind', title: 'scan', goal: 'read stuff' } });
  assert.strictEqual(safe.status, 'applied');
  assert.notStrictEqual(safe.result.task_state, 'blocked');
});

test('applyIntent message: appends operator-provenance line locally', async () => {
  const r = await bridge.applyIntent({ id: 'i-m1', kind: 'message', payload: { task_id: 'T-0001', content: 'hola desde clawtrol' } });
  assert.strictEqual(r.status, 'applied');
  const lines = fs.readFileSync(path.join(INTEL, 'task-messages.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.provenance, 'operator');
  assert.strictEqual(last.intent_id, 'i-m1');
});

test('question creation notifies the reasoner exactly once with its new task binding', async () => {
  bridge.writeNotifiedState(new Set());
  const result = await bridge.applyIntent({
    id: 'i-fleet-question',
    kind: 'create_task',
    payload: {
      project: '_fleet',
      kind: 'question',
      title: 'Assess every open pane',
      brief: 'Recommend the next action for every live project.',
    },
  });

  assert.strictEqual(result.status, 'applied');
  assert.match(result.result.task_id, /^T-\d+$/);
  const messages = fs.readFileSync(path.join(INTEL, 'task-messages.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const question = messages.find((message) => message.intent_id === 'i-fleet-question');
  assert.deepStrictEqual(
    {
      task_id: question.task_id,
      message_type: question.message_type,
      provenance: question.provenance,
      content: question.content,
    },
    {
      task_id: result.result.task_id,
      message_type: 'operator_question',
      provenance: 'operator',
      content: 'Assess every open pane\n\nRecommend the next action for every live project.',
    },
  );

  const delivered = [];
  const notify = async (message) => {
    delivered.push(message.intent_id);
    return true;
  };
  await bridge.deliverOperatorMessages(new Set(['_fleet']), notify);
  await bridge.deliverOperatorMessages(new Set(['_fleet']), notify);
  assert.deepStrictEqual(delivered, ['i-fleet-question']);
});

test('operator message delivery: wakes once after durable append and retries failures', async () => {
  writeIntelFile('task-messages.jsonl', []);
  bridge.writeNotifiedState(new Set());
  const projects = new Set(['fakerepo']);
  const task = bridge.buildTasks(projects)[0];
  assert.ok(task);
  bridge.appendTaskMessage({
    task_id: task.id,
    message_type: 'operator_message',
    content: 'wake the reasoner',
    provenance: 'operator',
    intent_id: 'i-wake-once',
  });

  const delivered = [];
  const first = await bridge.deliverOperatorMessages(projects, async (message) => {
    delivered.push(message.intent_id);
    return true;
  });
  assert.deepStrictEqual(delivered, ['i-wake-once']);
  assert.strictEqual(first.delivered, 1);

  await bridge.deliverOperatorMessages(projects, async (message) => {
    delivered.push(message.intent_id);
    return true;
  });
  assert.deepStrictEqual(delivered, ['i-wake-once']);

  bridge.appendTaskMessage({
    task_id: task.id,
    message_type: 'operator_message',
    content: 'retry this wake',
    provenance: 'operator',
    intent_id: 'i-wake-retry',
  });
  const failed = await bridge.deliverOperatorMessages(projects, async () => false);
  assert.strictEqual(failed.pending, 1);
  const retried = await bridge.deliverOperatorMessages(projects, async (message) => {
    delivered.push(message.intent_id);
    return true;
  });
  assert.strictEqual(retried.delivered, 1);
  assert.deepStrictEqual(delivered, ['i-wake-once', 'i-wake-retry']);
});

test('crash-after-apply replay: persisted result blocks re-application of the same intent id', async () => {
  // Simulate: intent applied + result persisted, then "crash" before ack —
  // ClawTrol re-delivers the same intent; appliedIntentIds must exclude it.
  const result = await bridge.applyIntent({ id: 'i-r1', kind: 'message', payload: { content: 'once only' } });
  bridge.persistResult(result);
  const before = fs.readFileSync(path.join(INTEL, 'task-messages.jsonl'), 'utf8').split('\n').filter((l) => l.includes('once only')).length;
  const done = bridge.appliedIntentIds();
  assert.ok(done.has('i-r1'));
  // The sync loop's guard: skip when id already in appliedIntentIds.
  if (!done.has('i-r1')) await bridge.applyIntent({ id: 'i-r1', kind: 'message', payload: { content: 'once only' } });
  const after = fs.readFileSync(path.join(INTEL, 'task-messages.jsonl'), 'utf8').split('\n').filter((l) => l.includes('once only')).length;
  assert.strictEqual(after, before);
  // And the unacked result ships until acked, then stops.
  assert.ok(bridge.unackedResults(new Set()).some((r) => r.id === 'i-r1'));
  assert.ok(!bridge.unackedResults(new Set(['i-r1'])).some((r) => r.id === 'i-r1'));
});

test('fake-ClawTrol integration: sync posts wire body, applies intent, acks result on next sync', async () => {
  writeIntelFile('events.jsonl', [{ time: 't', event: 'ledger.update', task_id: 'T-0009', attempt: 1 }]);
  writeIntelFile('pane-events.jsonl', [{ time: 't', event: 'turn-end', repo: 'fakerepo', markers: [] }]);
  const seen = { bodies: [], auth: null };
  let pendingIntents = [{ id: 'i-int1', kind: 'message', payload: { task_id: 'T-0009', content: 'integration ping' }, created_at: 't' }];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.auth = req.headers.authorization;
      const body = JSON.parse(raw);
      seen.bodies.push(body);
      // Re-deliver the intent until a result for it arrives (wire contract).
      if ((body.intent_results || []).some((r) => r.id === 'i-int1')) pendingIntents = [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ server_time: 't', accepted: {}, intents: pendingIntents }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, token: 'test-token-not-logged', profile: 'testprof', projects: new Set(['fakerepo']) };

  const first = await bridge.syncOnce(cfg, { fullSnapshot: true });
  assert.strictEqual(first.intents, 1);
  const second = await bridge.syncOnce(cfg, { fullSnapshot: false });
  server.close();

  assert.strictEqual(seen.auth, 'Bearer test-token-not-logged');
  const b1 = seen.bodies[0];
  assert.strictEqual(b1.profile, 'testprof');
  assert.ok(b1.generated_at && b1.health && b1.health.fleet);
  assert.ok(Array.isArray(b1.tasks)); // full snapshot
  assert.ok((b1.events || []).every((e) => e.task_id && e.attempt >= 1 && e.seq > 0));
  // Second sync carries the applied-intent result; server stops re-delivering.
  const b2 = seen.bodies[1];
  assert.ok(b2.intent_results.some((r) => r.id === 'i-int1' && r.status === 'applied'));
  assert.strictEqual(second.intents, 0);
  // The operator message landed locally with provenance.
  const msgs = fs.readFileSync(path.join(INTEL, 'task-messages.jsonl'), 'utf8');
  assert.match(msgs, /integration ping/);
});

test('sync retry: failed POST leaves cursors unpersisted so the delta replays', async () => {
  writeIntelFile('events.jsonl', [{ time: 't', event: 'ledger.update', task_id: 'T-0011', attempt: 1 }]);
  bridge.writeCursors({}); // reset
  const cfg = { url: 'http://127.0.0.1:1', token: 'x', profile: 'p', projects: new Set(['fakerepo']) }; // nothing listens
  await assert.rejects(() => bridge.syncOnce(cfg, { fullSnapshot: false }));
  assert.deepStrictEqual(bridge.readCursors(), {}); // not advanced
  const replay = bridge.readDelta('events.jsonl', bridge.readCursors());
  assert.strictEqual(replay.entries.length, 1); // delta still there
});

test('env-file loader: CLAWTROL_ keys load from owner file, other keys ignored, env wins', () => {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtrol-env-'));
  const envFile = path.join(envDir, 'clawtrol.env');
  fs.writeFileSync(envFile, '# comment\nCLAWTROL_URL=http://vm.example:3000\nCLAWTROL_TOKEN=tok-from-file\nCLAWTROL_PROFILE=prof1\nPATH=EVIL\nNOT_CLAWTROL=x\n');
  delete process.env.CLAWTROL_URL; delete process.env.CLAWTROL_TOKEN; delete process.env.CLAWTROL_PROFILE;
  const prevPath = process.env.PATH;
  process.env.WEZBRIDGE_CLAWTROL_ENV = envFile;
  // config() triggers the loader (module re-read of env each call).
  const cfgTest = require('../src/clawtrol-bridge.cjs');
  const h = cfgTest.health(); // health() calls config()
  assert.strictEqual(h.enabled, true);
  assert.strictEqual(process.env.CLAWTROL_URL, 'http://vm.example:3000');
  assert.strictEqual(process.env.CLAWTROL_TOKEN, 'tok-from-file');
  assert.strictEqual(process.env.PATH, prevPath); // non-CLAWTROL keys never touched
  assert.strictEqual(process.env.NOT_CLAWTROL, undefined);
  delete process.env.CLAWTROL_URL; delete process.env.CLAWTROL_TOKEN; delete process.env.CLAWTROL_PROFILE;
  delete process.env.WEZBRIDGE_CLAWTROL_ENV;
});

test('canary allowlist: unset ships nothing task-scoped; allowlisted repo ships; others filtered', async () => {
  // Tasks on disk belong to 'fakerepo' (created by earlier tests via the real ledger).
  const none = bridge.buildTasks(new Set());
  assert.strictEqual(none.length, 0); // fail-closed: empty allowlist = no tasks
  const some = bridge.buildTasks(new Set(['fakerepo']));
  assert.ok(some.length >= 1 && some.every((t) => t.project === 'fakerepo'));
  const other = bridge.buildTasks(new Set(['whatsappbot-final']));
  assert.strictEqual(other.length, 0); // non-matching allowlist filters everything
  // Event filtering goes through allowedTaskIds inside syncOnce — prove via a
  // fake server: same event delta, allowlist off → 0 events shipped.
  const taskId = some[0].id;
  writeIntelFile('events.jsonl', [{ time: 't', event: 'ledger.update', task_id: taskId, attempt: 1 }]);
  bridge.writeCursors({});
  const seen = [];
  const http2 = require('node:http');
  const srv = http2.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => { seen.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ intents: [] })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = { url: `http://127.0.0.1:${srv.address().port}`, token: 't', profile: 'p' };
  await bridge.syncOnce({ ...base, projects: new Set() }, { fullSnapshot: false });
  bridge.writeCursors({}); // replay same delta with allowlist ON
  await bridge.syncOnce({ ...base, projects: new Set(['fakerepo']) }, { fullSnapshot: false });
  srv.close();
  assert.strictEqual((seen[0].events || []).length, 0); // fail-closed
  assert.ok((seen[1].events || []).some((e) => e.task_id === taskId)); // canary ships
});

test('canary boundary: task-less messages NEVER ship, even with a non-empty allowlist', async () => {
  bridge.appendTaskMessage({ task_id: null, message_type: 'note', content: 'fleet prose must not leak', provenance: 'orchestrator' });
  bridge.writeCursors({});
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => { seen.push(JSON.parse(raw)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ intents: [] })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await bridge.syncOnce({ url: `http://127.0.0.1:${srv.address().port}`, token: 't', profile: 'p', projects: new Set(['fakerepo']) }, { fullSnapshot: false });
  srv.close();
  assert.ok(!(seen[0].messages || []).some((m) => /fleet prose/.test(m.content)));
});

test('latency fix: syncOnce reports applied count so tick can expedite the follow-up', async () => {
  // Regression for the ~115s applied->visible lag. The contract the scheduler
  // relies on: syncOnce returns applied>0 EXACTLY on the sync that applied an
  // intent, and 0 on replay — so tick() can shorten the next delay once and
  // never loops. Durable-before-ack ordering is asserted below, unchanged.
  const seen = { bodies: [] };
  let pending = [{
    id: 'i-lat1', kind: 'create_task', created_at: 't',
    payload: { repo: 'fakerepo', kind: 'safe-kind', title: 'latency proof', goal: 'render fast' },
  }];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw); seen.bodies.push(body);
      if ((body.intent_results || []).some((r) => r.id === 'i-lat1')) pending = [];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ server_time: 't', accepted: {}, intents: pending }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = { url: `http://127.0.0.1:${srv.address().port}`, token: 't', profile: 'p', projects: new Set(['fakerepo']) };

  const first = await bridge.syncOnce(cfg, { fullSnapshot: false });
  assert.strictEqual(first.applied, 1, 'sync that applies an intent must report applied=1');

  // The result is durable BEFORE any ack could have shipped it (crash-safety).
  const persisted = bridge.appliedIntentIds();
  assert.ok(persisted.has('i-lat1'), 'result must be persisted before the acking sync runs');
  assert.ok(!(seen.bodies[0].intent_results || []).some((r) => r.id === 'i-lat1'),
    'the applying sync must NOT have already acked it');

  // The expedited follow-up carries BOTH the ack and the new card.
  const second = await bridge.syncOnce(cfg, { fullSnapshot: true });
  srv.close();
  assert.strictEqual(second.applied, 0, 'replay must not re-apply — no follow-up loop');
  const b2 = seen.bodies[1];
  assert.ok(b2.intent_results.some((r) => r.id === 'i-lat1' && r.status === 'applied'));
  assert.ok(Array.isArray(b2.tasks) && b2.tasks.some((t) => /latency proof/.test(t.title || '')),
    'the follow-up full snapshot must carry the newly created task card');
});

test('latency fix: crash-replay safety retained — re-offered intent is not applied twice', async () => {
  // Same intent id re-delivered (e.g. the ack POST never reached Rails). The
  // ledger must not gain a second task, and applied must stay 0.
  const before = fs.readdirSync(path.join(INTEL, 'tasks')).length;
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        server_time: 't', accepted: {},
        intents: [{ id: 'i-lat1', kind: 'create_task', created_at: 't',
          payload: { repo: 'fakerepo', kind: 'safe-kind', title: 'latency proof', goal: 'render fast' } }],
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = { url: `http://127.0.0.1:${srv.address().port}`, token: 't', profile: 'p', projects: new Set(['fakerepo']) };
  const r = await bridge.syncOnce(cfg, { fullSnapshot: false });
  srv.close();
  assert.strictEqual(r.applied, 0, 'already-applied intent must not re-apply');
  assert.strictEqual(fs.readdirSync(path.join(INTEL, 'tasks')).length, before, 'no duplicate task created');
});

test('phase-1 enrichment: buildTasks ships the CONTRACT, corr and context_refs', () => {
  // The cockpit could show a task was blocked but never that the graph contract
  // blocked it, nor which gate/kind/mode did — an effect with no visible cause.
  const dir = path.join(INTEL, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'T-9001.json'), JSON.stringify({
    id: 'T-9001', title: 'gated thing', goal: 'g', kind: 'write-rpc', repo: 'fakerepo',
    state: 'blocked', blocker: 'operator gate (graph contract, kind=write-rpc)',
    contract: { mode: 'none', gate: 'operator', _note: 'moves money' },
    corr: 'T-9001-thread', context_refs: ['verified by pane-0: commits present'],
    attempt: 1, depends_on: [], created_at: 't', updated_at: 't',
  }));

  const [wire] = bridge.buildTasks(new Set(['fakerepo'])).filter((t) => t.id === 'T-9001');
  assert.ok(wire, 'task must ship for an allowlisted repo');
  assert.strictEqual(wire.contract.gate, 'operator', 'the gate must reach the operator UI');
  assert.strictEqual(wire.contract.mode, 'none');
  assert.strictEqual(wire.corr, 'T-9001-thread');
  assert.deepStrictEqual(wire.context_refs, ['verified by pane-0: commits present']);
  assert.match(wire.blocker, /graph contract/);
});

test('phase-1 enrichment: canary allowlist STILL fail-closed after enrichment', () => {
  // Enriching the payload must not widen who receives it.
  assert.strictEqual(bridge.buildTasks(new Set()).length, 0, 'empty allowlist ships nothing');
  assert.strictEqual(bridge.buildTasks(new Set(['otherrepo'])).some((t) => t.id === 'T-9001'), false);
});

test('phase-1 enrichment: payload allowlist gains trust fields but STILL excludes content', () => {
  // role/markers_prose_only let the UI tell a report from an action; scrollback
  // and free content must remain impossible to leak.
  const line = JSON.stringify({
    time: 't', event: 'turn-end', task_id: 'T-0009', repo: 'fakerepo',
    role: 'orchestrator', markers_prose_only: true, owner: 'pane-37',
    message: 'Claude is waiting for your input',
    lastLines: 'SECRET SCROLLBACK', rawText: 'SECRET', env: 'SECRET', content: 'SECRET',
  });
  const wire = bridge.toWireEvent('pane-events.jsonl', { line, offset: 0 });
  assert.strictEqual(wire.payload.role, 'orchestrator');
  assert.strictEqual(wire.payload.markers_prose_only, true);
  assert.strictEqual(wire.payload.owner, 'pane-37');
  assert.match(wire.payload.message, /waiting for your input/);
  for (const banned of ['lastLines', 'rawText', 'env', 'content']) {
    assert.strictEqual(wire.payload[banned], undefined, `${banned} must never ship`);
  }
});

test('allowlist edits take effect without a daemon restart', () => {
  // The allowlist is fail-closed and widened by hand-editing the owner env
  // file. v1 cached every CLAWTROL_* key at first read, so after the operator
  // added a repo the running daemon kept shipping the OLD set with no error,
  // no log line, and a healthy /api/panes — the operator would believe a repo
  // was wired up while its tasks stayed invisible. Found 2026-07-29 while
  // adding pedrito + CRM.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtrol-env-'));
  const envFile = path.join(dir, 'clawtrol.env');
  const prior = {
    WEZBRIDGE_CLAWTROL_ENV: process.env.WEZBRIDGE_CLAWTROL_ENV,
    CLAWTROL_URL: process.env.CLAWTROL_URL,
    CLAWTROL_TOKEN: process.env.CLAWTROL_TOKEN,
    CLAWTROL_PROJECTS: process.env.CLAWTROL_PROJECTS,
  };
  try {
    delete process.env.CLAWTROL_URL;
    delete process.env.CLAWTROL_TOKEN;
    delete process.env.CLAWTROL_PROJECTS;
    process.env.WEZBRIDGE_CLAWTROL_ENV = envFile;

    fs.writeFileSync(envFile, 'CLAWTROL_URL=http://x\nCLAWTROL_TOKEN=t\nCLAWTROL_PROJECTS=alpha\n');
    const first = bridge.__test_config();
    assert.deepStrictEqual([...first.projects], ['alpha'], 'first read picks up the file');

    // Operator widens the allowlist while the daemon keeps running.
    fs.writeFileSync(envFile, 'CLAWTROL_URL=http://x\nCLAWTROL_TOKEN=t\nCLAWTROL_PROJECTS=alpha,pedrito\n');
    const second = bridge.__test_config();
    assert.deepStrictEqual([...second.projects].sort(), ['alpha', 'pedrito'],
      'the edit must be live without a restart');

    // Narrowing must be live too — revoking access cannot wait for a restart.
    fs.writeFileSync(envFile, 'CLAWTROL_URL=http://x\nCLAWTROL_TOKEN=t\nCLAWTROL_PROJECTS=alpha\n');
    assert.deepStrictEqual([...bridge.__test_config().projects], ['alpha'],
      'removing a repo must revoke it immediately');

    // Secrets stay cached: rotating a token SHOULD require a deliberate restart.
    assert.strictEqual(process.env.CLAWTROL_TOKEN, 't', 'secrets are not re-read per tick');
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Solid Cable flood containment (2026-08-12).
// The bridge shipped ~76 mirrored tasks every 30s regardless of whether
// anything changed; the receiving ingestor save!s unconditionally and each
// arrival broadcast rendered kanban HTML — 300-600 msgs/min, ~5.2 GB/24h.
// These assert the PRODUCER never spends a write on a snapshot that says
// nothing, while never suppressing one that does.
// ---------------------------------------------------------------------------

test('an unchanged task snapshot is NOT sent', () => {
  const tasks = [{ id: 't1', state: 'ready' }];
  const digest = bridge.tasksDigest(tasks);
  assert.strictEqual(
    bridge.shouldSendTasks({ forced: false, digest, lastDigest: digest, tick: 10, lastSentTick: 9 }),
    false,
    'a byte-identical snapshot teaches the server nothing and must not ship');
});

test('a CHANGED task snapshot is always sent', () => {
  const before = bridge.tasksDigest([{ id: 't1', state: 'ready' }]);
  const after = bridge.tasksDigest([{ id: 't1', state: 'done' }]);
  assert.notStrictEqual(before, after, 'the digest must actually observe the change');
  assert.strictEqual(
    bridge.shouldSendTasks({ forced: false, digest: after, lastDigest: before, tick: 10, lastSentTick: 9 }),
    true,
    'suppression must never swallow a real state transition');
});

test('an applied intent forces the snapshot even when unchanged', () => {
  const digest = bridge.tasksDigest([{ id: 't1', state: 'ready' }]);
  assert.strictEqual(
    bridge.shouldSendTasks({ forced: true, digest, lastDigest: digest, tick: 10, lastSentTick: 9 }),
    true,
    'the operator is waiting on the card — forced always wins');
});

test('reconcile cadence ships an unchanged snapshot so the server can self-heal', () => {
  const digest = bridge.tasksDigest([{ id: 't1', state: 'ready' }]);
  const n = bridge.RECONCILE_EVERY_TICKS;
  assert.strictEqual(
    bridge.shouldSendTasks({ forced: false, digest, lastDigest: digest, tick: n, lastSentTick: 0 }),
    true,
    'divergence must heal on a fixed cadence, not on the next unrelated edit');
  assert.strictEqual(
    bridge.shouldSendTasks({ forced: false, digest, lastDigest: digest, tick: n - 1, lastSentTick: 0 }),
    false,
    'and not one tick early, or suppression buys nothing');
});

test('the first snapshot after a restart ships (no remembered digest)', () => {
  const digest = bridge.tasksDigest([{ id: 't1', state: 'ready' }]);
  assert.strictEqual(
    bridge.shouldSendTasks({ forced: false, digest, lastDigest: null, tick: 1, lastSentTick: 0 }),
    true,
    'a daemon that has lost its memory of server state must re-baseline');
});
