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
