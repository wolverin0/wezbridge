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
fs.copyFileSync(
  path.join(__dirname, '..', '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(LEDGER, 'ledger.cjs'));
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
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, token: 'test-token-not-logged', profile: 'testprof' };

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
  const cfg = { url: 'http://127.0.0.1:1', token: 'x', profile: 'p' }; // nothing listens
  await assert.rejects(() => bridge.syncOnce(cfg, { fullSnapshot: false }));
  assert.deepStrictEqual(bridge.readCursors(), {}); // not advanced
  const replay = bridge.readDelta('events.jsonl', bridge.readCursors());
  assert.strictEqual(replay.entries.length, 1); // delta still there
});
