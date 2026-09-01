'use strict';
/**
 * decision-relay.test.cjs — W3: del ruling del operador al pane que trabaja la
 * tarjeta. Cubre ingesta `approved|cancelled` desde EPOCH (las 338 lineas
 * legacy nunca se re-entregan), dedupe entre reinicios, entrega SOLO con send
 * verificado ('unknown' NO es entrega), diferimiento por pane ocupado o
 * composer con texto ajeno (sin consumir intento), ruta Eve (cola
 * finalorchestra con la llamada exacta + `update --next` que la nombra),
 * tarjeta ausente => undeliverable, y el cap de intentos => flags.
 * Consumidor de referencia: scripts/fleet-drill.cjs check 5.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRelay, EPOCH } = require('../src/decision-relay.cjs');

// ── andamio ────────────────────────────────────────────────────────────────
function mkIntel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-relay-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rulings.jsonl'), '');
  return dir;
}

function writeCard(intel, card) {
  fs.writeFileSync(path.join(intel, 'tasks', `${card.id}.json`), JSON.stringify(card, null, 2));
}

function appendRuling(intel, line) {
  fs.appendFileSync(path.join(intel, 'rulings.jsonl'), JSON.stringify(line) + '\n');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const events = (intel) => readJsonl(path.join(intel, 'events.jsonl'));
const queue = (intel, project) => readJsonl(path.join(intel, 'queues', `${project}.jsonl`));
const pendingState = (intel) => {
  try { return JSON.parse(fs.readFileSync(path.join(intel, '.decision-relay', 'pending.json'), 'utf8')); }
  catch { return {}; }
};

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const AT = '2026-09-01T10:00:00.000Z';

/** send scriptable: devuelve lo que se le dicta y registra cada envio. */
function mkSend({ delivered = 'ok', submitted = 'submitted' } = {}) {
  const sent = [];
  return {
    sent,
    sendPromptDeferredEnter: async (paneId, text) => { sent.push({ paneId, text }); return delivered; },
    verifyPromptSubmission: async () => submitted,
  };
}

function mkLedger() {
  const calls = [];
  const fn = (args) => { calls.push(args); return { ok: true }; };
  fn.calls = calls;
  return fn;
}

const idlePane = (cwd) => ({ paneId: 7, project: cwd, title: 'drill', status: 'idle', lastLines: '❯' });

function relayFor(intel, { panes, send, runLedger = mkLedger(), ...rest } = {}) {
  return createRelay({
    intelDir: intel,
    discoverPanes: () => panes,
    send,
    runLedger,
    now: () => NOW,
    log: () => {},
    ...rest,
  });
}

/** Escenario base: repo drillrepo, tarjeta T-0002 lista, ruling approved. */
function seedRepoCard(intel, over = {}) {
  const repoDir = path.join(intel, '..', 'drillrepo');
  writeCard(intel, {
    id: 'T-0002', repo: 'drillrepo', state: 'ready', kind: 'deploy',
    lease: null, contract: { gate: null }, next_action: null, ...over,
  });
  appendRuling(intel, { task: 'T-0002', category: 'awaiting-operator', ruling: 'approved', why: 'dale', at: AT, source: 'board-app' });
  return repoDir;
}

// ── casos ──────────────────────────────────────────────────────────────────

test('EPOCH es la constante que impide re-entregar las decisiones legacy', () => {
  assert.equal(EPOCH, '2026-09-01T00:00:00Z');
});

test('camino feliz: ruling approved + pane idle + send verificado => decision.delivered', async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel);
  const send = mkSend();
  const out = await relayFor(intel, { panes: [idlePane(repoDir)], send }).relayOnce();

  assert.equal(out.ingested, 1);
  assert.deepEqual(out.delivered.map((d) => d.task), ['T-0002']);
  assert.equal(send.sent.length, 1, 'un solo envio');
  assert.match(send.sent[0].text, /\[A2A from .* corr=T-0002 \| type=request\]/, 'sobre A2A con corr de la tarjeta');
  assert.match(send.sent[0].text, /\[decision\] operator approved T-0002: dale/);

  const ev = events(intel).filter((e) => e.event === 'decision.delivered');
  assert.equal(ev.length, 1);
  assert.deepEqual(
    { task: ev[0].task, project: ev[0].project, pane: ev[0].pane, ruling: ev[0].ruling },
    { task: 'T-0002', project: 'drillrepo', pane: 7, ruling: 'approved' },
  );

  const q = queue(intel, 'drillrepo');
  assert.equal(q.length, 1, 'la entrega directa TAMBIEN queda encolada (durable)');
  assert.equal(q[0].ok, true);
  assert.equal(q[0].corr, 'T-0002');
  assert.match(q[0].body, /^\[decision\] operator approved T-0002: dale/);
});

test("verificacion 'unknown' se encola, no se cuenta como entregada", async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel);
  const send = mkSend({ submitted: 'unknown' });
  const out = await relayFor(intel, { panes: [idlePane(repoDir)], send }).relayOnce();

  assert.deepEqual(out.delivered, []);
  assert.deepEqual(out.queued.map((q) => q.task), ['T-0002']);
  assert.equal(events(intel).filter((e) => e.event === 'decision.delivered').length, 0,
    "un send 'unknown' se conto como delivered");
  assert.equal(events(intel).filter((e) => e.event === 'decision.queued').length, 1);
  assert.equal(queue(intel, 'drillrepo')[0].ok, false, 'linea de cola con ok:false = trabajo para queue-drain');
  assert.equal(Object.values(pendingState(intel))[0].attempts, 1, 'un intento real consumido');
});

test('pane ocupado => encolado sin consumir intento ni tocar el composer', async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel);
  const send = mkSend();
  const out = await relayFor(intel, { panes: [{ ...idlePane(repoDir), status: 'working' }], send }).relayOnce();

  assert.equal(send.sent.length, 0, 'nada se escribio en un pane ocupado');
  assert.deepEqual(out.queued.map((q) => [q.task, q.reason]), [['T-0002', 'pane-busy']]);
  assert.equal(Object.values(pendingState(intel))[0].attempts, 0, 'el pane ocupado no consume intento');
  assert.equal(queue(intel, 'drillrepo').length, 1);
});

test('composer con texto ajeno => diferido, sin enviar encima', async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel);
  const send = mkSend();
  const pane = { ...idlePane(repoDir), lastLines: '❯ escribi esto y no lo mande' };
  const out = await relayFor(intel, { panes: [pane], send }).relayOnce();

  assert.equal(send.sent.length, 0, 'no se envia encima del texto del operador');
  assert.deepEqual(out.queued.map((q) => [q.task, q.reason]), [['T-0002', 'composer-holds-foreign-text']]);
  assert.equal(Object.values(pendingState(intel))[0].attempts, 0);
});

test('tarjeta con lease de Eve => cola finalorchestra con la llamada exacta + next_action que la nombra', async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel, { state: 'running', lease: { owner: 'eve:JOB-42', until: '2026-09-02T00:00:00Z' } });
  const runLedger = mkLedger();
  const send = mkSend();
  const out = await relayFor(intel, { panes: [idlePane(repoDir)], send, runLedger }).relayOnce();

  const fq = queue(intel, 'finalorchestra');
  assert.equal(fq.length, 1, 'la decision va a la cola de finalorchestra, no a la del repo');
  assert.equal(fq[0].corr, 'T-0002');
  assert.match(fq[0].body, /task_answer JOB-42 "approved: dale"/);
  assert.equal(queue(intel, 'drillrepo').length, 0, 'no se encola al repo cuando el dueno es Eve');

  const next = runLedger.calls.find((c) => c[0] === 'update' && c.includes('--next'));
  assert.ok(next, 'no se llamo a ledger update --next');
  assert.equal(next[1], 'T-0002');
  assert.match(next[next.indexOf('--next') + 1], /task_answer JOB-42 "approved: dale"/);
  assert.deepEqual(out.queued.map((q) => q.project), ['finalorchestra']);
});

test('lease de Eve + ruling cancelled => task_cancel, no task_answer', async () => {
  const intel = mkIntel();
  const repoDir = path.join(intel, '..', 'drillrepo');
  writeCard(intel, { id: 'T-0003', repo: 'drillrepo', state: 'running', lease: { owner: 'eve:JOB-9' }, contract: { gate: null } });
  appendRuling(intel, { task: 'T-0003', category: 'awaiting-operator', ruling: 'cancelled', why: 'ya no hace falta', at: AT, source: 'board-app' });
  const runLedger = mkLedger();
  await relayFor(intel, { panes: [idlePane(repoDir)], send: mkSend(), runLedger }).relayOnce();

  const fq = queue(intel, 'finalorchestra');
  assert.match(fq[0].body, /task_cancel JOB-9 "ya no hace falta"/);
  assert.ok(!/task_answer/.test(fq[0].body));
});

test('sin tarjeta => decision.undeliverable con reason no-card, y no se reintenta', async () => {
  const intel = mkIntel();
  appendRuling(intel, { task: 'T-0777', category: 'awaiting-operator', ruling: 'approved', why: 'x', at: AT, source: 'board-app' });
  const send = mkSend();
  const relay = relayFor(intel, { panes: [], send });
  const out = await relay.relayOnce();

  assert.deepEqual(out.undeliverable.map((u) => [u.task, u.reason]), [['T-0777', 'no-card']]);
  const ev = events(intel).filter((e) => e.event === 'decision.undeliverable');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reason, 'no-card');
  assert.deepEqual(pendingState(intel), {}, 'no queda pendiente: sin tarjeta no hay a quien entregar');

  const again = await relay.relayOnce();
  assert.deepEqual(again.undeliverable, [], 'segunda pasada no re-emite');
});

test('linea legacy anterior a EPOCH nunca se ingesta', async () => {
  const intel = mkIntel();
  const repoDir = path.join(intel, '..', 'drillrepo');
  writeCard(intel, { id: 'T-0001', repo: 'drillrepo', state: 'ready', lease: null, contract: { gate: null } });
  appendRuling(intel, { task: 'T-0001', category: 'awaiting-operator', ruling: 'approved', why: 'vieja', at: '2026-08-30T10:00:00.000Z', source: 'board-app' });
  const send = mkSend();
  const out = await relayFor(intel, { panes: [idlePane(repoDir)], send }).relayOnce();

  assert.equal(out.ingested, 0, 'las 338 decisiones legacy no se re-entregan');
  assert.equal(send.sent.length, 0);
  assert.equal(events(intel).length, 0);
});

test('rulings que no son approved|cancelled, o con task que no es una tarjeta, se ignoran', async () => {
  const intel = mkIntel();
  const repoDir = path.join(intel, '..', 'drillrepo');
  writeCard(intel, { id: 'T-0004', repo: 'drillrepo', state: 'ready', lease: null, contract: { gate: null } });
  appendRuling(intel, { task: 'T-0004', category: 'idle', ruling: 'dispatched', why: 'no es decision del operador', at: AT, source: 'orchestrator-pane' });
  appendRuling(intel, { task: 'T-0004:sub', category: 'awaiting-operator', ruling: 'approved', why: 'corr, no tarjeta', at: AT, source: 'board-app' });
  const out = await relayFor(intel, { panes: [idlePane(repoDir)], send: mkSend() }).relayOnce();
  assert.equal(out.ingested, 0);
});

test('reinicio: un relay nuevo sobre el mismo dir no re-entrega lo ya entregado', async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel);
  const first = mkSend();
  await relayFor(intel, { panes: [idlePane(repoDir)], send: first }).relayOnce();
  assert.equal(first.sent.length, 1);

  const second = mkSend();
  const out = await relayFor(intel, { panes: [idlePane(repoDir)], send: second }).relayOnce();
  assert.equal(out.ingested, 0, 'el cursor quedo persistido');
  assert.equal(second.sent.length, 0, 'la decision ya entregada no se repite tras reiniciar');
  assert.equal(events(intel).filter((e) => e.event === 'decision.delivered').length, 1);
});

test('cap de intentos => flags.json con motivo y la entrada se deja de reintentar', async () => {
  const intel = mkIntel();
  const repoDir = seedRepoCard(intel);
  const send = mkSend({ submitted: 'stuck' });
  const relay = relayFor(intel, { panes: [idlePane(repoDir)], send, cooldownMs: 0 });
  await relay.relayOnce();
  await relay.relayOnce();
  const third = await relay.relayOnce();

  assert.deepEqual(third.flagged.map((f) => f.task), ['T-0002']);
  const flags = JSON.parse(fs.readFileSync(path.join(intel, '.decision-relay', 'flags.json'), 'utf8'));
  assert.equal(Object.keys(flags).length, 1);
  assert.match(Object.values(flags)[0].reason, /attempt cap/i);
  assert.deepEqual(pendingState(intel), {});

  const fourth = await relay.relayOnce();
  assert.equal(send.sent.length, 3, 'tres intentos y ni uno mas');
  assert.deepEqual(fourth.flagged, []);
});

test('relayOnce nunca lanza: un discoverPanes que tira se reporta, no rompe el relay', async () => {
  const intel = mkIntel();
  seedRepoCard(intel);
  const relay = createRelay({
    intelDir: intel,
    discoverPanes: () => { throw new Error('wezterm caido'); },
    send: mkSend(),
    runLedger: mkLedger(),
    now: () => NOW,
    log: () => {},
  });
  const out = await relay.relayOnce();
  assert.deepEqual(out.queued.map((q) => q.task), ['T-0002'], 'sin censo la decision se encola igual');
  assert.equal(queue(intel, 'drillrepo').length, 1);
});
