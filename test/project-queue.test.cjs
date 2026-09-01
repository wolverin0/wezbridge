'use strict';
/**
 * project-queue.test.cjs — B1: durable per-project A2A queue + deterministic
 * consumer. Covers the generalized waker mechanics (sha1 dedupe, tmp+rename
 * atomic state, attempt cap flag-and-stop, cooldown, age expiry anti-replay)
 * and the auto-ack bookkeeping on verified result redelivery. All IO points at
 * a temp dir via WEZBRIDGE_INTEL_DIR; sends and clocks are injected.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'project-queue-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP;
const pq = require('../src/project-queue.cjs');
const intel = require('../src/a2a-intel.cjs');

let tmpCounter = 0;
function freshBase() {
  const dir = path.join(TMP, `case-${tmpCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function goodSend(calls = []) {
  return {
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
  };
}

function badSend(calls = []) {
  return {
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'stuck',
  };
}

const IDLE_PANE = { paneId: 7, agent: 'claude', status: 'idle', project: 'G:/x/wezbridge', tabTitle: null, title: null };

function makeConsumer(base, over = {}) {
  return pq.createConsumer({
    project: 'wezbridge',
    base,
    discoverPanes: () => [IDLE_PANE],
    send: goodSend(),
    logAction: () => {},
    ...over,
  });
}

// ── entryId / enqueue ────────────────────────────────────────────────────────

test('entryId: stable for the same logical message, distinct for a changed body', () => {
  const a = { project: 'wezbridge', corr: 'T-1', type: 'request', from_pane: 0, body: 'do it' };
  assert.strictEqual(pq.entryId(a), pq.entryId({ ...a }));
  assert.notStrictEqual(pq.entryId(a), pq.entryId({ ...a, body: 'do it differently' }));
  assert.notStrictEqual(pq.entryId(a), pq.entryId({ ...a, corr: 'T-2' }));
});

test('enqueue: appends one JSONL line under <intel>/queues/<project>.jsonl', () => {
  const base = freshBase();
  const r = pq.enqueue({ project: 'wezbridge', corr: 'T-9', type: 'request', from_pane: 0, resolved_pane: 7, submitted: 'submitted', delivered: 'ok', ok: true, body: 'hola' }, { base });
  assert.strictEqual(r.ok, true);
  const lines = fs.readFileSync(path.join(base, 'queues', 'wezbridge.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.id, r.id);
  assert.strictEqual(rec.project, 'wezbridge');
  assert.strictEqual(rec.ok, true);
  assert.strictEqual(rec.body, 'hola');
  assert.ok(rec.time);
});

test('enqueue: fail-soft — an invalid project never throws, reports ok:false', () => {
  assert.doesNotThrow(() => {
    const r = pq.enqueue({ project: '', corr: 'x', type: 'request', from_pane: 0, body: 'b' });
    assert.strictEqual(r.ok, false);
  });
});

test('sanitizeProject: filenames stay boring', () => {
  assert.strictEqual(pq.sanitizeProject('Wez Bridge/../X'), 'wez-bridge-..-x'.replace(/[^a-z0-9._-]+/g, '-'));
  assert.strictEqual(pq.sanitizeProject('wezbridge'), 'wezbridge');
  assert.strictEqual(pq.sanitizeProject(''), null);
});

// ── consumer: ingest ─────────────────────────────────────────────────────────

test('ingest: ok:true lines are never retried; ok:false lines become pending', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-a', type: 'request', from_pane: 0, ok: true, body: 'delivered already' }, { base });
  pq.enqueue({ project: 'wezbridge', corr: 'T-b', type: 'request', from_pane: 0, ok: false, body: 'failed delivery' }, { base });
  const c = makeConsumer(base, { discoverPanes: () => [] }); // no panes -> no delivery, pure ingest
  const out = await c.drain();
  assert.strictEqual(out.added, 1, 'only the undelivered line is retry work');
  assert.strictEqual(c.status().pending, 1);
});

test('ingest: sha1 dedupe — the same logical message enqueued twice is ONE pending entry', async () => {
  const base = freshBase();
  const e = { project: 'wezbridge', corr: 'T-dup', type: 'request', from_pane: 0, ok: false, body: 'same' };
  pq.enqueue(e, { base });
  pq.enqueue(e, { base });
  const c = makeConsumer(base, { discoverPanes: () => [] });
  const out = await c.drain();
  assert.strictEqual(out.added, 1);
});

test('ingest: a later verified re-send supersedes the earlier failed copy', async () => {
  const base = freshBase();
  const e = { project: 'wezbridge', corr: 'T-sup', type: 'request', from_pane: 0, body: 'same' };
  pq.enqueue({ ...e, ok: false }, { base });
  const c = makeConsumer(base, { discoverPanes: () => [] });
  await c.drain();
  assert.strictEqual(c.status().pending, 1);
  pq.enqueue({ ...e, ok: true }, { base }); // caller re-sent and it verified
  await c.drain();
  assert.strictEqual(c.status().pending, 0, 'the pending copy must not re-deliver');
});

test('ingest: entries older than maxAgeMs expire instead of replaying (anti-replay)', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-old', type: 'request', from_pane: 0, ok: false, body: 'ancient' }, { base });
  const future = Date.now() + 25 * 60 * 60 * 1000; // 25h later
  const c = makeConsumer(base, { discoverPanes: () => [], now: () => future });
  const out = await c.drain();
  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.expired, 1);
  assert.strictEqual(c.status().pending, 0);
});

test('ingest: a corrupt line is skipped, never crashes, later lines still ingest', async () => {
  const base = freshBase();
  const file = path.join(base, 'queues', 'wezbridge.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, '{corrupt-not-json\n');
  pq.enqueue({ project: 'wezbridge', corr: 'T-after', type: 'request', from_pane: 0, ok: false, body: 'fine' }, { base });
  const c = makeConsumer(base, { discoverPanes: () => [] });
  const out = await c.drain();
  assert.strictEqual(out.added, 1);
});

test('atomicity: consumer state is valid JSON with no leftover .tmp files', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-atom', type: 'request', from_pane: 0, ok: false, body: 'x' }, { base });
  const c = makeConsumer(base, { discoverPanes: () => [] });
  await c.drain();
  const stateDir = path.join(base, 'queues', 'state', 'wezbridge');
  for (const f of ['cursor.json', 'pending.json']) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')), `${f} must be valid JSON`);
  }
  const leftovers = fs.readdirSync(stateDir).filter((n) => n.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'tmp+rename must leave no .tmp behind');
});

test('cursor survives across consumer instances — lines are never re-ingested', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-c1', type: 'request', from_pane: 0, ok: false, body: 'one' }, { base });
  const c1 = makeConsumer(base, { discoverPanes: () => [] });
  const out1 = await c1.drain();
  assert.strictEqual(out1.added, 1);
  const c2 = makeConsumer(base, { discoverPanes: () => [] }); // fresh instance, same durable state
  const out2 = await c2.drain();
  assert.strictEqual(out2.added, 0, 'the durable cursor must prevent re-ingest');
  assert.strictEqual(c2.status().pending, 1, 'pending persisted across instances');
});

// ── consumer: delivery ───────────────────────────────────────────────────────

test('delivery: pending entry is delivered to the pane resolved NOW, not the stale one', async () => {
  const base = freshBase();
  // Enqueued when the project's pane was 3; by drain time the pane is 7.
  pq.enqueue({ project: 'wezbridge', corr: 'T-d1', type: 'request', from_pane: 0, resolved_pane: 3, ok: false, body: 'ship it' }, { base });
  const calls = [];
  const c = makeConsumer(base, { send: goodSend(calls) });
  const out = await c.drain();
  assert.strictEqual(out.delivered, 1);
  assert.strictEqual(calls[0].paneId, 7, 'must re-resolve via pane-identity at delivery time');
  // El requisito es "no se reenvia el sobre viejo", no "el header dice pane-7".
  // Desde 2026-08-29 el header direcciona por NOMBRE DE PROYECTO, que es la
  // unica direccion estable (el mismo pane es 11 en el espacio MCP y 15 en el
  // del CLI de wezterm). Este aserto se reancla al requisito: el sobre entregado
  // NO puede llevar el pane obsoleto con el que se encolo.
  assert.doesNotMatch(calls[0].text, /pane-3\b/,
    'el sobre NO puede reenviarse con el pane obsoleto (3) que vio el emisor original');
  assert.match(calls[0].text, /^\[A2A from pane-0 to wezbridge \| corr=T-d1 \| type=request\]\n/,
    'envelope rebuilt: destino por nombre de proyecto, cuerpo intacto');
  assert.strictEqual(c.status().pending, 0);
});

test('delivery: busy pane -> skip with NO attempt consumed', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-busy', type: 'request', from_pane: 0, ok: false, body: 'x' }, { base });
  const c = makeConsumer(base, { discoverPanes: () => [{ ...IDLE_PANE, status: 'working' }] });
  const out = await c.drain();
  assert.strictEqual(out.delivered, 0);
  assert.strictEqual(c._state.pending[Object.keys(c._state.pending)[0]].attempts, 0,
    'a busy pane is not a failed attempt');
});

test('retry + flag-and-stop: attempts increment on failed send; cap flags and drops', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-flag', type: 'request', from_pane: 0, ok: false, body: 'x' }, { base });
  let t = 0;
  const c = makeConsumer(base, { send: badSend(), now: () => (t += 10 * 60 * 1000) }); // each call 10min later: cooldown never blocks
  await c.drain();
  const id = Object.keys(c._state.pending)[0];
  assert.strictEqual(c._state.pending[id].attempts, 1);
  await c.drain();
  await c.drain(); // third failure hits maxAttempts=3
  assert.strictEqual(c.status().pending, 0, 'capped entry leaves pending');
  const flags = JSON.parse(fs.readFileSync(c._files.flags, 'utf8'));
  assert.ok(flags[id], 'capped entry must be FLAGGED for a human');
  assert.match(flags[id].reason, /attempt cap/);
  const out4 = await c.drain();
  assert.strictEqual(out4.delivered, 0, 'flagged entries are never retried');
});

test('cooldown: a second attempt within cooldownMs is blocked; first is never blocked', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-cool', type: 'request', from_pane: 0, ok: false, body: 'x' }, { base });
  let clock = 1_000_000;
  const c = makeConsumer(base, { send: badSend(), now: () => clock });
  await c.drain(); // first attempt at t0 — allowed (undefined = never attempted)
  const id = Object.keys(c._state.pending)[0];
  assert.strictEqual(c._state.pending[id].attempts, 1);
  clock += 60 * 1000; // 1 min < 5 min cooldown
  await c.drain();
  assert.strictEqual(c._state.pending[id].attempts, 1, 'cooldown must block the retry');
  clock += 5 * 60 * 1000;
  await c.drain();
  assert.strictEqual(c._state.pending[id].attempts, 2, 'after cooldown the retry runs');
});

test('delivery: verified result redelivery auto-acks the thread (bookkeeping only)', async () => {
  const base = freshBase();
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = base; // a2a-threads.json lives beside the queues
  try {
    // The thread is awaiting-ack because a result was SENT but delivery failed.
    intel.updateThreads({ fromPane: 5, toPane: 3, corr: 'T-ack', type: 'request' });
    intel.updateThreads({ fromPane: 3, toPane: 5, corr: 'T-ack', type: 'result' });
    pq.enqueue({ project: 'wezbridge', corr: 'T-ack', type: 'result', from_pane: 3, ok: false, body: 'criteria:\n- g: pass — done' }, { base });
    const actions = [];
    const c = makeConsumer(base, { logAction: (a, d) => actions.push({ a, d }) });
    const out = await c.drain();
    assert.strictEqual(out.delivered, 1);
    const threads = JSON.parse(fs.readFileSync(path.join(base, 'a2a-threads.json'), 'utf8')).threads;
    assert.strictEqual(threads['T-ack'], undefined, 'verified result delivery closes the thread with no LLM turn');
    assert.ok(actions.some((x) => x.a === 'auto_ack'), 'auto_ack must be logged');
    assert.ok(actions.some((x) => x.a === 'queue_deliver'), 'delivery itself must be logged');
  } finally {
    process.env.WEZBRIDGE_INTEL_DIR = prior;
  }
});

test('delivery: unresolvable project (no pane / ambiguous) delivers nothing, keeps pending', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-nores', type: 'request', from_pane: 0, ok: false, body: 'x' }, { base });
  const twoPanes = [IDLE_PANE, { ...IDLE_PANE, paneId: 9 }];
  const c = makeConsumer(base, { discoverPanes: () => twoPanes });
  const out = await c.drain();
  assert.strictEqual(out.delivered, 0, 'ambiguous resolution must fail closed');
  assert.strictEqual(c.status().pending, 1);
});

test('drain --dry-run: reports without sending or consuming state', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-dry', type: 'request', from_pane: 0, ok: false, body: 'x' }, { base });
  const calls = [];
  const c = makeConsumer(base, { send: goodSend(calls) });
  await c.drain(); // ingest + deliver -> pending 0
  pq.enqueue({ project: 'wezbridge', corr: 'T-dry2', type: 'request', from_pane: 0, ok: false, body: 'y' }, { base });
  const before = calls.length;
  const dry = await c.drain({ dryRun: true });
  assert.strictEqual(calls.length, before, 'dry-run must not send');
  assert.strictEqual(dry.added, 0, 'dry-run must not consume the cursor');
});

test('listQueues: enumerates projects that have a queue file', () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'a', type: 'request', from_pane: 0, ok: true, body: 'x' }, { base });
  pq.enqueue({ project: 'mutual', corr: 'b', type: 'request', from_pane: 0, ok: true, body: 'y' }, { base });
  assert.deepStrictEqual(pq.listQueues({ base }).sort(), ['mutual', 'wezbridge']);
});

// ── no new coordinator: the module must never grow the always-on shape ──────

test('project-queue is NOT a coordinator: no setInterval anywhere in the module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'project-queue.cjs'), 'utf8');
  assert.ok(!src.includes('setInterval'),
    'a timer loop here would be always-on coordinator iteration #7 — the consumer is cron-driven by design');
});

// ── T-0221 regression: silent-empty body was a dropper ──────────────────────
// Root cause 2026-08-22: two real dispatches passed `envelope:` instead of
// `body:`; the lenient String(entry.body || '') swallowed it and both
// deliveries arrived as a bare A2A header. These tests FAIL without the
// fail-closed guard in enqueue() (rule: regression test must fail sans fix).

test('T-0221: enqueue refuses an empty body with a caller-facing error', () => {
  const base = freshBase();
  const r = pq.enqueue({ project: 'wezbridge', corr: 't0221', type: 'request', from_pane: 0 }, { base });
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error || ''), /body required/);
});

test('T-0221: enqueue refuses the exact caller bug — `envelope:` instead of `body:`', () => {
  const base = freshBase();
  const r = pq.enqueue({
    project: 'wezbridge', corr: 't0221b', type: 'request', from_pane: 0,
    envelope: '[A2A from pane-0 to pane-1 | corr=t0221b | type=request]\ncuerpo que se perderia',
  }, { base });
  assert.strictEqual(r.ok, false, 'envelope-without-body must be refused, not silently emptied');
});

test('T-0221: whitespace-only body is refused too', () => {
  const base = freshBase();
  const r = pq.enqueue({ project: 'wezbridge', corr: 't0221c', type: 'request', from_pane: 0, body: '   \n  ' }, { base });
  assert.strictEqual(r.ok, false);
});

test('T-0221: multiline body survives enqueue verbatim (the delivery rebuild depends on it)', () => {
  const base = freshBase();
  const body = 'linea 1\nlinea 2 con criteria:\n- item: pass — evidencia';
  const r = pq.enqueue({ project: 'wezbridge', corr: 't0221d', type: 'result', from_pane: 0, body }, { base });
  assert.strictEqual(r.ok, true);
  const file = path.join(base, 'queues', 'wezbridge.jsonl');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
  assert.strictEqual(rec.body, body);
});

// ── T-0233: rescue de sends con transporte caido ─────────────────────────────
// Antes solo el camino to_project era durable: un to_pane con ETIMEDOUT no
// dejaba NINGUNA linea en ninguna cola (mm-455f — yolo26 lo verifico mirando
// el directorio tras 2 fallos; el result sobrevivio solo por reintento manual).
test('T-0233: a failed to_pane send is rescued to the DESTINATION project queue and delivered on drain', async () => {
  const base = freshBase();
  const census = [{ pane_id: 7, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null }];
  const rescue = pq.rescueFailedSend(
    { toProject: null, toPane: 7, census, corr: 'T-r1', type: 'result', fromPane: 0, body: 'trabajo terminado' },
    (entry) => pq.enqueue(entry, { base })
  );
  assert.strictEqual(rescue.queued, true);
  assert.strictEqual(rescue.project, 'wezbridge', 'destination project resolved from census, not guessed');
  const raw = fs.readFileSync(path.join(base, 'queues', 'wezbridge.jsonl'), 'utf8');
  assert.match(raw, /trabajo terminado/, 'the envelope SURVIVES the transport failure');
  const calls = [];
  const c = makeConsumer(base, { send: goodSend(calls) });
  const out = await c.drain();
  assert.strictEqual(out.delivered, 1, 'the rescued envelope is delivered on retry');
  assert.match(calls[0].text, /corr=T-r1/);
});

test('T-0233: an unresolvable destination goes to the VISIBLE _dead-letter queue, never nowhere', () => {
  const base = freshBase();
  const rescue = pq.rescueFailedSend(
    { toProject: null, toPane: 99, census: [], corr: 'T-r2', type: 'request', fromPane: 0, body: 'huerfano' },
    (entry) => pq.enqueue(entry, { base })
  );
  assert.strictEqual(rescue.queued, true);
  assert.strictEqual(rescue.project, '_dead-letter');
  const raw = fs.readFileSync(path.join(base, 'queues', '_dead-letter.jsonl'), 'utf8');
  assert.match(raw, /huerfano/, 'visible-but-stuck beats silent-and-gone');
});

test('T-0233: rescuing the same envelope twice dedupes at ingest — one delivery, not two', async () => {
  const base = freshBase();
  const census = [{ pane_id: 7, cwd: 'file:///G:/Py%20Apps/wezbridge/', tab_title: null }];
  const args = { toProject: null, toPane: 7, census, corr: 'T-r3', type: 'request', fromPane: 0, body: 'mismo cuerpo' };
  pq.rescueFailedSend(args, (entry) => pq.enqueue(entry, { base }));
  pq.rescueFailedSend(args, (entry) => pq.enqueue(entry, { base })); // a hand-retry after the rescue
  const calls = [];
  const c = makeConsumer(base, { send: goodSend(calls) });
  const out = await c.drain();
  assert.strictEqual(out.delivered, 1, 'sha1 id (corr+type+from+body) dedupes the duplicate line');
  assert.strictEqual(calls.length, 1);
});

// ── W4 gemelo: el tercer estado de la entrega en la cola ─────────────────────
//
// MEDIDO: `ok = submitted !== 'stuck' && delivered !== 'truncated'` contaba un
// pane ILEGIBLE ('unknown') como entrega verificada. La entrada salia de la
// cola sin que nadie pudiera afirmar que el sobre llego. Es el mismo defecto
// que W4 arregla en el waker, y aca vale mas: esta cola es el ultimo respaldo
// durable de un a2a_send fallido.

function unverifiableSend(calls = []) {
  return {
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'unknown', // pane ilegible / shell no-TUI
  };
}

test('W4 gemelo: una entrega NO verificable no cuenta como entregada y la entrada sigue pendiente', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-unv', type: 'request', from_pane: 0, ok: false, body: 'hacelo' }, { base });
  const calls = [];
  const c = makeConsumer(base, { send: unverifiableSend(calls) });
  const out = await c.drain();

  assert.strictEqual(calls.length, 1, 'precondicion: se intento la entrega');
  assert.strictEqual(out.delivered, 0, "'unknown' NO es una entrega: nadie pudo leer el composer");
  assert.strictEqual(Object.keys(c._state.pending).length, 1, 'la entrada tiene que quedar para el proximo drain');
});

test('W4 gemelo: una entrega verificada sigue entregando (el otro sentido)', async () => {
  const base = freshBase();
  pq.enqueue({ project: 'wezbridge', corr: 'T-ver', type: 'request', from_pane: 0, ok: false, body: 'hacelo' }, { base });
  const c = makeConsumer(base, { send: goodSend() });
  assert.strictEqual((await c.drain()).delivered, 1);
});

// ── W2/W4: un result DRENADO tambien aterriza en a2a-results.jsonl ───────────
//
// La rama `to_project` sin pane vivo retornaba antes de recordResultBody: un
// result que viajaba por la cola NUNCA llegaba al archivo de resultados. Se
// registra al entregar, salvo que el emisor ya lo haya registrado al encolar
// (mcp-server marca `recorded: true`) — nunca dos veces.

const resultsLines = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'a2a-results.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

test('W2: un type=result entregado por la cola queda registrado en a2a-results.jsonl', async () => {
  const base = freshBase();
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = base;
  try {
    pq.enqueue({ project: 'wezbridge', corr: 'T-0301:drain:20260901', type: 'result', from_pane: 3, ok: false, body: 'criteria:\n- a: pass — evidencia' }, { base });
    const c = makeConsumer(base);
    assert.strictEqual((await c.drain()).delivered, 1);
    const lines = resultsLines(base);
    assert.strictEqual(lines.length, 1, 'el result drenado tiene que aterrizar en a2a-results.jsonl');
    assert.strictEqual(lines[0].corr, 'T-0301:drain:20260901');
    assert.match(lines[0].body, /criteria:/);
  } finally { process.env.WEZBRIDGE_INTEL_DIR = prior; }
});

test('W2: si el emisor ya lo registro (recorded:true) la cola NO lo duplica', async () => {
  const base = freshBase();
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = base;
  try {
    pq.enqueue({ project: 'wezbridge', corr: 'T-0302:dup:20260901', type: 'result', from_pane: 3, ok: false, recorded: true, body: 'criteria:\n- a: pass — evidencia' }, { base });
    const c = makeConsumer(base);
    assert.strictEqual((await c.drain()).delivered, 1);
    assert.strictEqual(resultsLines(base).length, 0, 'doble registro = el mismo result contado dos veces por el linker');
  } finally { process.env.WEZBRIDGE_INTEL_DIR = prior; }
});

test('W2: un type=request drenado NO se registra como result', async () => {
  const base = freshBase();
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = base;
  try {
    pq.enqueue({ project: 'wezbridge', corr: 'T-0303', type: 'request', from_pane: 3, ok: false, body: 'hacelo' }, { base });
    const c = makeConsumer(base);
    assert.strictEqual((await c.drain()).delivered, 1);
    assert.strictEqual(resultsLines(base).length, 0);
  } finally { process.env.WEZBRIDGE_INTEL_DIR = prior; }
});
