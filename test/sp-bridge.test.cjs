'use strict';
/**
 * T-0337 — sp-bridge: cliente del protocolo de archivos del plugin "SP MCP Bridge"
 * (plugin_commands/*.json -> plugin_responses/*_response.json) sin app ni MCP: un
 * plugin FALSO responde en un dir temporal con un modelo en memoria.
 *  AC1 createTaskOnce idempotente por id externo (2 corridas = 1 tarea), completeOnce, listado.
 *  AC2 decisiones del fleet: una tarjeta gateada => UNA tarea; al des-gatearse se completa.
 *  AC3 intake: tarea nueva en Intake => _intel/intake/<taskId>.json una sola vez.
 *  AC4 write-back: t_id en el json => nota de la tarea; tarjeta done => tarea hecha.
 *  Control: sin plugin (nadie responde) el cliente devuelve success:false con el motivo.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sp = require('../scripts/sp-bridge.cjs');

/** Plugin falso: procesa comandos en cada poll del cliente (via sleep inyectado). */
function fakePlugin(dataDir) {
  const model = { projects: [], tags: [], tasks: [], nextId: 1 };
  const id = (p) => `${p}${model.nextId++}`;
  function handle(cmd) {
    const d = cmd.data || {};
    switch (cmd.action) {
      case 'ping': return true;
      case 'getAllProjects': return model.projects;
      case 'addProject': { const p = { id: id('P'), title: d.title }; model.projects.push(p); return p.id; }
      case 'getAllTags': return model.tags;
      case 'addTag': { const t = { id: id('G'), title: d.title }; model.tags.push(t); return t.id; }
      case 'getTasks': return model.tasks;
      case 'addTask': { const t = { id: id('T'), title: d.title, notes: d.notes || '', projectId: d.projectId || null, tagIds: d.tagIds || [], isDone: false, created: Date.now() }; model.tasks.push(t); return t.id; }
      case 'updateTask': { const t = model.tasks.find((x) => x.id === cmd.taskId); if (!t) throw new Error('no task'); Object.assign(t, d); return true; }
      case 'setTaskDone': { const t = model.tasks.find((x) => x.id === cmd.taskId); if (!t) throw new Error('no task'); t.isDone = true; return true; }
      default: throw new Error(`Unknown command action: ${cmd.action}`);
    }
  }
  const commands = path.join(dataDir, 'plugin_commands');
  const responses = path.join(dataDir, 'plugin_responses');
  function tick() {
    if (!fs.existsSync(commands)) return;
    for (const f of fs.readdirSync(commands).filter((x) => x.endsWith('.json'))) {
      const p = path.join(commands, f);
      let cmd; try { cmd = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      let res;
      try { res = { success: true, result: handle(cmd), timestamp: Date.now() }; } catch (e) { res = { success: false, error: e.message, timestamp: Date.now() }; }
      fs.writeFileSync(path.join(responses, `${cmd.id}_response.json`), JSON.stringify(res));
      fs.unlinkSync(p);
    }
  }
  return { model, tick };
}
function env() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-'));
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-intel-'));
  fs.mkdirSync(path.join(intel, 'tasks'));
  const plugin = fakePlugin(dataDir);
  const client = sp.createClient({ dataDir, timeoutMs: 2000, pollMs: 1, sleep: async () => plugin.tick() });
  const hub = sp.createHub(client, { intel });
  return { dataDir, intel, plugin, client, hub };
}
const card = (over = {}) => ({ id: 'T-0900', title: 'Aprobar deploy de prueba', state: 'blocked', gate: 'operator', blocked_by: 'operator', blocker: 'operator gate: un tap', corr: 'T-0900:x', repo: 'wezbridge', ...over });

test('AC1 createTaskOnce es idempotente por id externo, pone #agente y el marcador; completeOnce marca hecha una sola vez', async () => {
  const e = env();
  const a = await e.hub.createTaskOnce({ ext: 'demo:1', project: 'Recordatorios', title: 'Pagar Litoral Gas', notes: 'vence', dueWithTime: '2026-09-12T12:00:00Z' });
  const b = await e.hub.createTaskOnce({ ext: 'demo:1', project: 'Recordatorios', title: 'Pagar Litoral Gas (otra vez)' });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.taskId, b.taskId);
  assert.equal(e.plugin.model.tasks.length, 1, 'dos corridas = una tarea');
  const t = e.plugin.model.tasks[0];
  assert.match(t.notes, /\[ext:demo:1\]/);
  assert.equal(t.dueWithTime, Date.parse('2026-09-12T12:00:00Z'));
  assert.ok(e.plugin.model.tags.some((g) => g.title === 'agente') && t.tagIds.length >= 1, 'tag #agente');
  assert.equal(e.plugin.model.projects.length, 1, 'ensureProject no duplica');
  assert.equal(await e.hub.completeOnce('demo:1'), true);
  assert.equal(await e.hub.completeOnce('demo:1'), false, 'la segunda vez no hace nada');
  assert.equal(t.isDone, true);
  assert.equal((await e.client.getTasks()).length, 1);
});

test('AC2 decisiones del fleet: tarjeta gateada => UNA tarea con link al tablero; re-sync no duplica; des-gateada => tarea hecha', async () => {
  const e = env();
  const cards = [card(), { id: 'T-0901', title: 'no gateada', state: 'ready', gate: null, blocked_by: 'agent' }];
  const r1 = await e.hub.syncDecisions(cards);
  assert.deepEqual(r1, { created: 1, completed: 0 });
  const r2 = await e.hub.syncDecisions(cards);
  assert.deepEqual(r2, { created: 0, completed: 0 }, 'idempotente');
  const t = e.plugin.model.tasks[0];
  assert.match(t.title, /^T-0900 · /); assert.match(t.notes, /4272/); assert.match(t.notes, /\[ext:fleet:T-0900\]/);
  const r3 = await e.hub.syncDecisions([card({ state: 'ready', gate: null, blocked_by: 'agent' })]);
  assert.deepEqual(r3, { created: 0, completed: 1 });
  assert.equal(t.isDone, true);
});

test('AC3+AC4 intake: tarea nueva => json una sola vez; t_id => nota; tarjeta done => tarea hecha', async () => {
  const e = env();
  const projectId = await e.hub.ensureProject('Intake');
  const taskId = await e.client.addTask({ title: 'probar Tailscale para el tablero', notes: '', projectId, tagIds: [] });
  const r1 = await e.hub.syncIntake();
  assert.deepEqual(r1, { exported: 1, writtenBack: 0, completed: 0 });
  const f = path.join(e.intel, 'intake', `${taskId}.json`);
  assert.ok(fs.existsSync(f));
  assert.deepEqual(await e.hub.syncIntake(), { exported: 0, writtenBack: 0, completed: 0 }, 'no se re-exporta');
  // el turno del orquestador escribe el T-id
  const rec = JSON.parse(fs.readFileSync(f, 'utf8')); rec.t_id = 'T-0950'; fs.writeFileSync(f, JSON.stringify(rec));
  fs.writeFileSync(path.join(e.intel, 'tasks', 'T-0950.json'), JSON.stringify({ id: 'T-0950', state: 'running' }));
  assert.deepEqual(await e.hub.syncIntake(), { exported: 0, writtenBack: 1, completed: 0 });
  assert.match(e.plugin.model.tasks[0].notes, /Tarjeta: T-0950/);
  assert.deepEqual(await e.hub.syncIntake(), { exported: 0, writtenBack: 0, completed: 0 }, 'la nota no se repite');
  fs.writeFileSync(path.join(e.intel, 'tasks', 'T-0950.json'), JSON.stringify({ id: 'T-0950', state: 'done' }));
  assert.deepEqual(await e.hub.syncIntake(), { exported: 0, writtenBack: 0, completed: 1 });
  assert.equal(e.plugin.model.tasks[0].isDone, true);
});

test('control: sin plugin que responda, el cliente falla con motivo legible y limpia su comando', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-nobody-'));
  const client = sp.createClient({ dataDir, timeoutMs: 30, pollMs: 1 });
  const r = await client.ping();
  assert.equal(r.success, false);
  assert.match(r.error, /plugin SP MCP Bridge/);
  assert.equal(fs.readdirSync(path.join(dataDir, 'plugin_commands')).length, 0, 'comando huerfano limpiado');
});

test('resolveDataDir: SP_MCP_DATA_DIR gana; sin override usa el dir estandar', () => {
  assert.equal(sp.resolveDataDir({ SP_MCP_DATA_DIR: 'X:/sp' }), 'X:/sp');
  assert.match(sp.resolveDataDir({}), /super-productivity-mcp$/);
});

// ── T-0376 (OMNIGOD wave 1): un plugin mudo deja evidencia DURABLE y el reintento es seguro ──
test('T-0376 fail-first: plugin mudo => sync falla con evidencia durable (log, last-failure, evento) y NO toca el map; al volver el plugin, un solo task y sin duplicados', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mute-'));
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mute-intel-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mute-log-'));
  fs.mkdirSync(path.join(intel, 'tasks'));
  fs.writeFileSync(path.join(intel, 'tasks', 'T-0900.json'), JSON.stringify(card()));

  // 1) nadie contesta: cliente con timeout minimo y sin plugin que tickee
  const mute = sp.createClient({ dataDir, timeoutMs: 30, pollMs: 1 });
  const hubMute = sp.createHub(mute, { intel });
  const r1 = await sp.syncOnce({ hub: hubMute, logDir, intelDir: intel });
  assert.equal(r1.ok, false, 'con el plugin mudo el sync tiene que FALLAR, no fingir exito');
  assert.match(r1.record.error, /no responde/i, 'el motivo es legible');
  assert.equal(r1.record.stage, 'decisions');
  const logLines = fs.readFileSync(path.join(logDir, 'sp-bridge.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logLines.length, 1);
  assert.ok(logLines[0].error, 'el fallo queda en el MISMO log que los exitos (antes solo se logueaba el exito)');
  const lastFailure = JSON.parse(fs.readFileSync(path.join(intel, '.sp-bridge', 'last-failure.json'), 'utf8'));
  assert.equal(lastFailure.stage, 'decisions');
  const events = fs.readFileSync(path.join(intel, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.event === 'sp-bridge.sync_failed'), 'evento durable para el tablero/steward');
  assert.ok(!fs.existsSync(path.join(intel, '.sp-bridge', 'map.json')) || Object.keys(JSON.parse(fs.readFileSync(path.join(intel, '.sp-bridge', 'map.json'), 'utf8'))).length === 0,
    'un fallo no escribe el map: nada quedo "creado" sin estarlo');

  // 2) vuelve el plugin: el reintento crea UNA tarea, y el siguiente sync ninguna
  const plugin = fakePlugin(dataDir);
  const live = sp.createClient({ dataDir, timeoutMs: 2000, pollMs: 1, sleep: async () => plugin.tick() });
  const hubLive = sp.createHub(live, { intel });
  const r2 = await sp.syncOnce({ hub: hubLive, logDir, intelDir: intel });
  assert.equal(r2.ok, true, JSON.stringify(r2.record));
  assert.equal(r2.record.decisions.created, 1, 'la decision gateada se crea una vez al volver el plugin');
  const r3 = await sp.syncOnce({ hub: hubLive, logDir, intelDir: intel });
  assert.equal(r3.record.decisions.created, 0, 'reintento seguro: cero duplicados');
  const lastSuccess = JSON.parse(fs.readFileSync(path.join(intel, '.sp-bridge', 'last-success.json'), 'utf8'));
  assert.ok(lastSuccess.ts >= lastFailure.ts, 'last-success es posterior al fallo: un checker puede leer la edad');
});

// ---------------------------------------------------------------- T-0405 (S1 de la madre T-0404)
// Medido 2026-09-06 02:5xZ: de 6 tarjetas blocked_by=operator solo 3 estaban en SP (las
// otras tienen gate null/undefined, y syncDecisions solo miraba gate); y la nota traia
// http://127.0.0.1:4272, que desde el telefono no abre nada.
test('T-0405 A: una tarjeta blocked_by=operator SIN campo gate tambien es una decision del operador', async () => {
  const e = env();
  const r = await e.hub.syncDecisions([card({ id: 'T-0262', gate: undefined }), card({ id: 'T-0346', gate: null })]);
  assert.equal(r.created, 2, `las dos son decisiones del operador aunque no traigan gate: ${JSON.stringify(r)}`);
});

test('T-0405 B: con boardUrl publica + boardToken la nota lleva la URL publica y los tres enlaces firmados /act; el re-sync no duplica', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-'));
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-intel-'));
  fs.mkdirSync(path.join(intel, 'tasks'));
  const plugin = fakePlugin(dataDir);
  const client = sp.createClient({ dataDir, timeoutMs: 2000, pollMs: 1, sleep: async () => plugin.tick() });
  const hub = sp.createHub(client, { intel, boardUrl: 'http://192.0.2.10:4272/', boardToken: 'tok-de-prueba' });
  const r1 = await hub.syncDecisions([card()]);
  assert.equal(r1.created, 1);
  const t = plugin.model.tasks[0];
  assert.match(t.notes, /http:\/\/192\.0\.2\.10:4272\//, 'la URL del tablero tiene que ser la publica');
  assert.doesNotMatch(t.notes, /127\.0\.0\.1/, 'localhost no sirve desde el telefono');
  for (const verb of ['approved', 'cancelled', 'deferred']) {
    assert.match(t.notes, new RegExp('/act[?]task=T-0900&verb=' + verb + '&exp=[0-9]+&sig=[0-9a-f]+'), `falta el enlace firmado ${verb}`);
  }
  const notesBefore = t.notes;
  await hub.syncDecisions([card()]);
  assert.equal(plugin.model.tasks[0].notes, notesBefore, 'el re-sync no vuelve a pegar los enlaces');
});

test('T-0405 C: una tarea creada ANTES (sin enlaces) recibe los enlaces firmados una sola vez', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-'));
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-intel-'));
  fs.mkdirSync(path.join(intel, 'tasks'));
  const plugin = fakePlugin(dataDir);
  const client = sp.createClient({ dataDir, timeoutMs: 2000, pollMs: 1, sleep: async () => plugin.tick() });
  const viejo = sp.createHub(client, { intel });
  await viejo.syncDecisions([card()]);
  assert.doesNotMatch(plugin.model.tasks[0].notes, /\/act\?/);
  const nuevo = sp.createHub(client, { intel, boardUrl: 'http://192.0.2.10:4272/', boardToken: 'tok-de-prueba' });
  const r = await nuevo.syncDecisions([card()]);
  assert.equal(r.linked, 1, `tenia que enlazar la tarea vieja: ${JSON.stringify(r)}`);
  assert.match(plugin.model.tasks[0].notes, /\/act\?task=T-0900&verb=approved/);
  const r2 = await nuevo.syncDecisions([card()]);
  assert.equal(r2.linked, 0, 'la segunda vez no agrega nada');
});

// ---------------------------------------------------------------- T-0405 bis (pedido del operador 06/09 00:1x ART)
// "que el mismo proceso marque la tarea como completada despues de aprobar o cancelar,
//  y que guarde el estado de lo que hicimos en el detalle de la tarea".
function envWithBoard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-data-'));
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-intel-'));
  fs.mkdirSync(path.join(intel, 'tasks'));
  fs.mkdirSync(path.join(intel, 'results'));
  const plugin = fakePlugin(dataDir);
  const client = sp.createClient({ dataDir, timeoutMs: 2000, pollMs: 1, sleep: async () => plugin.tick() });
  const hub = sp.createHub(client, { intel, boardUrl: 'http://192.0.2.10:4272/', boardToken: 'tok' });
  return { dataDir, intel, plugin, client, hub };
}

test('T-0405 D: recordDecision anota la decision en la tarea y la completa al instante (approved/cancelled); deferred solo anota; idempotente', async () => {
  const e = envWithBoard();
  await e.hub.syncDecisions([card({ id: 'T-0910' }), card({ id: 'T-0911' }), card({ id: 'T-0912' })]);
  const t = (id) => e.plugin.model.tasks.find((x) => x.title.startsWith(id));
  const r1 = await e.hub.recordDecision({ task: 'T-0910', ruling: 'approved', at: '2026-09-06T03:18:58.232Z', by: 'operator-link', why: 'Aprobar desde la bandeja' });
  assert.deepEqual(r1, { noted: true, completed: true });
  assert.equal(t('T-0910').isDone, true, 'aprobada => tarea completada sin esperar al sync');
  assert.match(t('T-0910').notes, /Decision: APROBADA 2026-09-06 03:18Z \(operator-link\) - Aprobar desde la bandeja/);
  const r2 = await e.hub.recordDecision({ task: 'T-0911', ruling: 'cancelled', at: '2026-09-06T03:20:00.000Z', by: 'operator-link' });
  assert.deepEqual(r2, { noted: true, completed: true });
  assert.equal(t('T-0911').isDone, true);
  const r3 = await e.hub.recordDecision({ task: 'T-0912', ruling: 'deferred', at: '2026-09-06T03:21:00.000Z', by: 'operator-link', until: '2026-09-10' });
  assert.deepEqual(r3, { noted: true, completed: false }, 'diferida: sigue abierta, la vas a volver a ver');
  assert.match(t('T-0912').notes, /Decision: DIFERIDA .* hasta 2026-09-10/);
  const again = await e.hub.recordDecision({ task: 'T-0910', ruling: 'approved', at: '2026-09-06T03:18:58.232Z', by: 'operator-link' });
  assert.deepEqual(again, { noted: false, completed: false }, 'la misma decision no se anota dos veces');
  const nadie = await e.hub.recordDecision({ task: 'T-0999', ruling: 'approved', at: '2026-09-06T03:22:00.000Z', by: 'operator-link' });
  assert.deepEqual(nadie, { noted: false, completed: false }, 'tarjeta sin tarea en SP: no explota');
});

test('T-0405 E: syncOutcomes escribe en la nota cada cambio de estado de la tarjeta y el result cuando aparece, una sola vez', async () => {
  const e = envWithBoard();
  const c = card({ id: 'T-0920' });
  await e.hub.syncDecisions([c]);
  const t = () => e.plugin.model.tasks.find((x) => x.title.startsWith('T-0920'));
  const notesAfterCreate = t().notes;
  assert.deepEqual(await e.hub.syncOutcomes([c]), { noted: 0 }, 'sin cambio de estado no escribe');
  assert.equal(t().notes, notesAfterCreate);
  const running = { ...c, state: 'running', blocked_by: 'agent', gate: null, lease: { owner: 'pane-1' } };
  assert.deepEqual(await e.hub.syncOutcomes([running]), { noted: 1 });
  assert.match(t().notes, /Estado: blocked -> running/);
  assert.deepEqual(await e.hub.syncOutcomes([running]), { noted: 0 }, 'el mismo estado no se repite');
  fs.writeFileSync(path.join(e.intel, 'results', 'T-0920-result.md'), '# T-0920 - hecho\ncriteria:\n- AC1: pass - evidencia X\n- AC2: pass - evidencia Y\n');
  const review = { ...running, state: 'review' };
  assert.deepEqual(await e.hub.syncOutcomes([review]), { noted: 2 }, 'estado nuevo + result nuevo');
  assert.match(t().notes, /Estado: running -> review/);
  assert.match(t().notes, /Result: _intel\/results\/T-0920-result\.md/);
  assert.match(t().notes, /AC1: pass - evidencia X/, 'las primeras lineas del criteria van en la nota');
  assert.deepEqual(await e.hub.syncOutcomes([review]), { noted: 0 });
});

test('T-0405 J: una tarjeta que vuelve a bloquearse en el operador DESPUES de aprobada reaparece como tarea nueva (la vieja quedo hecha); sin duplicar', async () => {
  const e = envWithBoard();
  const c = card({ id: 'T-0262', blocker: 'autorizar limpieza' });
  await e.hub.syncDecisions([c]);
  await e.hub.recordDecision({ task: 'T-0262', ruling: 'approved', at: '2026-09-06T03:28:52.154Z', by: 'operator-link' });
  const abiertas = () => e.plugin.model.tasks.filter((t) => t.title.startsWith('T-0262') && !t.isDone);
  assert.equal(abiertas().length, 0, 'aprobada => la tarea quedo hecha');
  // infra la devuelve a blocked con un pedido NUEVO para el operador (medido 06/09 04:4xZ)
  const again = { ...c, state: 'blocked', blocked_by: 'operator', gate: null, blocker: 'documentar acceso de shell al appliance UISP' };
  const r = await e.hub.syncDecisions([again]);
  assert.equal(r.created, 1, `tiene que crear una tarea nueva: ${JSON.stringify(r)}`);
  assert.equal(abiertas().length, 1);
  assert.match(abiertas()[0].notes, /documentar acceso de shell/);
  assert.match(abiertas()[0].notes, /\/act\?task=T-0262&verb=approved/, 'la tarea nueva trae sus enlaces');
  const r2 = await e.hub.syncDecisions([again]);
  assert.equal(r2.created, 0, 'idempotente');
  // la decision sobre la vuelta va a la tarea NUEVA
  const d = await e.hub.recordDecision({ task: 'T-0262', ruling: 'deferred', at: '2026-09-06T05:00:00.000Z', by: 'operator-link', until: '2026-09-08' });
  assert.deepEqual(d, { noted: true, completed: false });
  assert.match(abiertas()[0].notes, /DIFERIDA .* hasta 2026-09-08/);
  // y el estado tambien
  const out = await e.hub.syncOutcomes([{ ...again, state: 'running', blocked_by: 'agent' }]);
  assert.ok(out.noted >= 1);
  assert.match(e.plugin.model.tasks.filter((t) => t.title.startsWith('T-0262')).pop().notes, /Estado: blocked -> running/);
});
