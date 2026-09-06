#!/usr/bin/env node
'use strict';
/**
 * sp-bridge.cjs — puente determinista entre el fleet y Super Productivity (T-0337).
 *
 * Habla el MISMO protocolo de archivos que usa super-productivity-mcp con su plugin
 * (repo/Super-Productivity-MCP/src/ipc/*): escribe <dataDir>/plugin_commands/<id>.json
 * y espera <dataDir>/plugin_responses/<id>_response.json. No necesita el servidor MCP
 * ni dependencias npm (wezbridge es zero-deps): solo la app de escritorio con el
 * plugin "SP MCP Bridge" habilitado. dataDir: SP_MCP_DATA_DIR > mcp_config.json >
 * %APPDATA%\super-productivity-mcp (la misma resolucion que el MCP).
 *
 * Reglas del hub (brief _intel/briefs/hub-personal-sp-20260903.md): los agentes
 * CREAN tareas con tag #agente y nunca mueven ni borran las del operador; toda
 * escritura es idempotente por un id externo guardado en _intel/.sp-bridge/map.json
 * y espejado en la nota de la tarea ("[ext:<id>]").
 *
 * CLI:
 *   node scripts/sp-bridge.cjs ping
 *   node scripts/sp-bridge.cjs ensure-projects
 *   node scripts/sp-bridge.cjs task <proyecto> "<titulo>" [--notes "..."] [--ext <id>] [--due <ISO>]
 *   node scripts/sp-bridge.cjs remind "<titulo>" --at <ISO> [--ext <id>] [--notes "..."]
 *   node scripts/sp-bridge.cjs done --ext <id>
 *   node scripts/sp-bridge.cjs sync-decisions      # tarjetas gateadas -> "Decisiones del fleet"
 *   node scripts/sp-bridge.cjs sync-intake         # Intake -> _intel/intake/<taskId>.json + write-back del T-id
 *   node scripts/sp-bridge.cjs sync                # las dos anteriores (para la schtask)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const AGENT_TAG = 'agente';
const PROJECTS = Object.freeze({
  hoy: 'Hoy', intake: 'Intake', recordatorios: 'Recordatorios', decisiones: 'Decisiones del fleet', dieta: 'Dieta',
});
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
const BOARD_URL = process.env.WEZBRIDGE_BOARD_URL || 'http://127.0.0.1:4272/';

// ---------------------------------------------------------------- data dir (misma resolucion que el MCP)
function standardDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'super-productivity-mcp');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'super-productivity-mcp');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'super-productivity-mcp');
}
function resolveDataDir(env = process.env) {
  if (env.SP_MCP_DATA_DIR) return env.SP_MCP_DATA_DIR;
  const std = standardDir();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(std, 'mcp_config.json'), 'utf8'));
    if (cfg && typeof cfg.dataDir === 'string' && cfg.dataDir) return cfg.dataDir;
  } catch { /* sin override */ }
  return std;
}

// ---------------------------------------------------------------- transporte por archivos
function createClient({ dataDir = resolveDataDir(), timeoutMs = 30_000, pollMs = 200, now = Date.now, sleep } = {}) {
  const commands = path.join(dataDir, 'plugin_commands');
  const responses = path.join(dataDir, 'plugin_responses');
  fs.mkdirSync(commands, { recursive: true });
  fs.mkdirSync(responses, { recursive: true });
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function send(action, fields = {}) {
    const id = `${action}_${now()}_${Math.random().toString(36).slice(2, 8)}`;
    const command = { id, action, protocolVersion: PROTOCOL_VERSION, timestamp: now(), ...fields };
    const cmdPath = path.join(commands, `${id}.json`);
    const tmp = `${cmdPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(command, null, 2));
    fs.renameSync(tmp, cmdPath); // el plugin lista *.json: nunca debe ver medio archivo
    const resPath = path.join(responses, `${id}_response.json`);
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (fs.existsSync(resPath)) {
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(resPath, 'utf8')); } catch { await wait(pollMs); continue; }
        try { fs.unlinkSync(resPath); } catch { /* ignore */ }
        return parsed;
      }
      await wait(pollMs);
    }
    try { fs.unlinkSync(cmdPath); } catch { /* ignore */ }
    return { success: false, error: 'Super Productivity no responde: la app de escritorio tiene que estar abierta con el plugin SP MCP Bridge habilitado', timestamp: now() };
  }
  const must = async (action, fields) => {
    const r = await send(action, fields);
    if (!r || !r.success) throw new Error(`${action}: ${(r && r.error) || 'sin respuesta'}`);
    return r.result;
  };
  return {
    dataDir, send,
    ping: () => send('ping'),
    getAllProjects: () => must('getAllProjects'),
    addProject: (title) => must('addProject', { data: { title } }),
    getAllTags: () => must('getAllTags'),
    addTag: (title) => must('addTag', { data: { title } }),
    getTasks: (filters) => must('getTasks', filters ? { filters } : {}),
    addTask: (data) => must('addTask', { data }),
    updateTask: (taskId, data) => must('updateTask', { taskId, data }),
    setTaskDone: (taskId) => must('setTaskDone', { taskId }),
    addTagToTask: (taskId, tagId) => must('addTagToTask', { taskId, tagId }),
  };
}

// ---------------------------------------------------------------- idempotencia
function mapFile(intel = INTEL) { return path.join(intel, '.sp-bridge', 'map.json'); }
function loadMap(intel = INTEL) { try { return JSON.parse(fs.readFileSync(mapFile(intel), 'utf8')); } catch { return {}; } }
function saveMap(map, intel = INTEL) {
  const f = mapFile(intel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, f);
}
const extMarker = (ext) => `[ext:${ext}]`;

// ---------------------------------------------------------------- operaciones de alto nivel
function createHub(client, { intel = INTEL, log = () => {}, boardUrl = BOARD_URL, boardToken = null } = {}) {
  const cache = { projects: null, tags: null };

  // T-0405: la decision es del operador si la tarjeta esta bloqueada por el
  // (blocked_by) o su compuerta lo dice (gate). Mirar solo gate dejo 4 de 6
  // tarjetas fuera de SP el 2026-09-06 (gate null/undefined, blocked_by=operator).
  const isOperatorGated = (c) => Boolean(c) && c.state === 'blocked' && (gateOf(c) === 'operator' || c.blocked_by === 'operator');
  // Enlaces firmados de /act (aprobar/cancelar/posponer): valen como firma del
  // operador (T-0349) y abren desde el telefono si boardUrl es la URL publica.
  const ACT_LINKS_KEY = 'act-links-v1';
  function actLinksBlock(taskId) {
    if (!boardToken) return '';
    try {
      const { decisionActions } = require('../board-app/lib/action-links.cjs');
      return decisionActions(boardUrl, boardToken, taskId).map((a) => `${a.label}: ${a.url}`).join('\n');
    } catch { return ''; }
  }
  function decisionNotes(c) {
    const links = actLinksBlock(c.id);
    return `${c.blocker || 'esperando tu decision'}\n\nDecidir en el tablero: ${boardUrl} (o /decidir ${c.id} en el pane)`
      + (links ? `\n${links}` : '')
      + `\ncorr: ${c.corr || '-'} · repo: ${c.repo || '-'}`;
  }

  async function ensureProject(title) {
    cache.projects = cache.projects || await client.getAllProjects();
    let p = cache.projects.find((x) => String(x.title).trim().toLowerCase() === title.toLowerCase());
    if (p) return p.id;
    const id = await client.addProject(title);
    cache.projects.push({ id, title });
    log(`sp-bridge: proyecto creado "${title}"`);
    return id;
  }
  async function ensureProjects() {
    const out = {};
    for (const t of Object.values(PROJECTS)) out[t] = await ensureProject(t);
    return out;
  }
  async function ensureTag(title) {
    cache.tags = cache.tags || await client.getAllTags();
    let t = cache.tags.find((x) => String(x.title).trim().toLowerCase() === title.toLowerCase());
    if (t) return t.id;
    const id = await client.addTag(title);
    cache.tags.push({ id, title });
    return id;
  }

  /**
   * Crea UNA tarea por id externo. Dos corridas con el mismo `ext` = una tarea.
   * La tarea queda con tag #agente y el marcador [ext:<id>] al final de la nota.
   */
  async function createTaskOnce({ ext, project, title, notes = '', dueWithTime = null, dueDay = null, tags = [] }) {
    if (!ext) throw new Error('createTaskOnce: ext (id externo) es obligatorio: sin el no hay idempotencia');
    const map = loadMap(intel);
    if (map[ext]) return { taskId: map[ext].taskId, created: false };
    const projectId = await ensureProject(project);
    const tagIds = [await ensureTag(AGENT_TAG)];
    for (const t of tags) tagIds.push(await ensureTag(t));
    const fullNotes = `${notes ? `${notes}\n\n` : ''}${extMarker(ext)}`;
    const taskId = await client.addTask({ title, notes: fullNotes, projectId, tagIds, plannedAt: null, dueDay: null });
    const patch = {};
    if (dueWithTime) patch.dueWithTime = new Date(dueWithTime).getTime();
    if (dueDay) patch.dueDay = dueDay;
    if (Object.keys(patch).length) await client.updateTask(taskId, patch);
    map[ext] = { taskId, project, createdAt: new Date().toISOString() };
    saveMap(map, intel);
    log(`sp-bridge: tarea creada [${ext}] "${title}" en ${project}`);
    return { taskId, created: true };
  }
  async function completeOnce(ext) {
    const map = loadMap(intel);
    const e = map[ext];
    if (!e || e.doneAt) return false;
    await client.setTaskDone(e.taskId);
    e.doneAt = new Date().toISOString();
    saveMap(map, intel);
    log(`sp-bridge: tarea completada [${ext}]`);
    return true;
  }
  async function appendNoteOnce(ext, line, key) {
    const map = loadMap(intel);
    const e = map[ext];
    if (!e) return false;
    e.notesAppended = e.notesAppended || [];
    if (e.notesAppended.includes(key)) return false;
    const tasks = await client.getTasks();
    const t = tasks.find((x) => x.id === e.taskId);
    if (!t) return false;
    await client.updateTask(e.taskId, { notes: `${t.notes || ''}\n${line}`.trim() });
    e.notesAppended.push(key);
    saveMap(map, intel);
    return true;
  }

  // -- decisiones del fleet: tarjetas gateadas por el operador -> una tarea cada una
  const gateOf = (t) => (t && t.contract && t.contract.gate) || (t && t.gate) || null;
  function readCards() {
    const dir = path.join(intel, 'tasks');
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /^T-\d{4}\.json$/.test(f)); } catch { return []; }
    return names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
  }
  // ---------------------------------------------------------------- T-0405 bis
  // Pedido del operador (06/09): "que el mismo proceso marque la tarea como
  // completada despues de aprobar o cancelar, y que guarde el estado de lo que
  // hicimos en el detalle de la tarea". recordDecision lo llama el tablero desde
  // /act y /api/rulings (board-app/server.cjs onRuling); syncOutcomes corre en
  // cada sync y vuelca cambios de estado y el result a la nota de la tarea.
  const fmtAt = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`; };
  const RULING_ES = { approved: 'APROBADA', cancelled: 'CANCELADA', deferred: 'DIFERIDA' };
  async function recordDecision({ task, ruling, at, by = 'operator', why = '', until = null }) {
    const ext = `fleet:${task}`;
    if (!loadMap(intel)[ext]) return { noted: false, completed: false };
    const key = `ruling:${ruling}:${at}`;
    const line = `Decision: ${RULING_ES[ruling] || String(ruling).toUpperCase()} ${fmtAt(at)} (${by})`
      + (until ? ` hasta ${until}` : '') + (why ? ` - ${why}` : '');
    const noted = await appendNoteOnce(ext, line, key);
    if (!noted) return { noted: false, completed: false };
    let completed = false;
    if (ruling === 'approved' || ruling === 'cancelled') completed = await completeOnce(ext);
    return { noted, completed };
  }
  function findResultFile(id) {
    const dir = path.join(intel, 'results');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const hit = names.filter((n) => n.startsWith(`${id}-`) && n.endsWith('-result.md')).sort().pop();
    return hit ? { rel: `_intel/results/${hit}`, abs: path.join(dir, hit) } : null;
  }
  function resultExcerpt(abs) {
    try {
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const i = lines.findIndex((l) => /^criteria:/i.test(l.trim()));
      return (i === -1 ? lines.slice(0, 4) : lines.slice(i + 1, i + 4)).map((l) => l.trim()).filter(Boolean).join('\n');
    } catch { return ''; }
  }
  async function syncOutcomes(cards = readCards()) {
    const out = { noted: 0 };
    for (const [ext, e] of Object.entries(loadMap(intel))) {
      if (!ext.startsWith('fleet:')) continue;
      const id = ext.slice('fleet:'.length);
      const card = cards.find((c) => c && c.id === id);
      if (!card) continue;
      const prev = e.lastState || 'blocked';
      if (card.state && card.state !== prev) {
        const owner = card.lease && card.lease.owner ? ` (${card.lease.owner})` : '';
        if (await appendNoteOnce(ext, `Estado: ${prev} -> ${card.state}${owner} · ${fmtAt(new Date().toISOString())}`, `state:${prev}:${card.state}`)) out.noted += 1;
        const m2 = loadMap(intel);
        if (m2[ext]) { m2[ext].lastState = card.state; saveMap(m2, intel); }
      }
      const rf = findResultFile(id);
      if (rf) {
        const key = `result:${rf.rel}`;
        const cur = loadMap(intel)[ext] || {};
        if (!(cur.notesAppended || []).includes(key)) {
          const ex = resultExcerpt(rf.abs);
          if (await appendNoteOnce(ext, `Result: ${rf.rel}${ex ? `\n${ex}` : ''}`, key)) out.noted += 1;
        }
      }
    }
    return out;
  }

  async function syncDecisions(cards = readCards()) {
    const out = { created: 0, completed: 0 };
    if (boardToken) out.linked = 0;
    const gated = cards.filter(isOperatorGated);
    for (const c of gated) {
      const r = await createTaskOnce({
        ext: `fleet:${c.id}`, project: PROJECTS.decisiones,
        title: `${c.id} · ${String(c.title || '').slice(0, 90)}`,
        notes: decisionNotes(c),
        tags: ['fleet'],
      });
      if (r.created) {
        out.created += 1;
        if (boardToken) { const m = loadMap(intel); if (m[`fleet:${c.id}`]) { m[`fleet:${c.id}`].notesAppended = [ACT_LINKS_KEY]; saveMap(m, intel); } }
      } else if (boardToken) {
        // Tarea creada antes de que existieran los enlaces firmados: se le pegan UNA vez.
        const links = actLinksBlock(c.id);
        if (links && await appendNoteOnce(`fleet:${c.id}`, links, ACT_LINKS_KEY)) out.linked += 1;
      }
    }
    const map = loadMap(intel);
    for (const [ext, e] of Object.entries(map)) {
      if (!ext.startsWith('fleet:') || e.doneAt) continue;
      const id = ext.slice('fleet:'.length);
      const card = cards.find((c) => c.id === id);
      if (!isOperatorGated(card) && await completeOnce(ext)) out.completed += 1;
    }
    return out;
  }

  // -- intake: tareas del proyecto Intake -> _intel/intake/<taskId>.json ; write-back del T-id
  async function syncIntake() {
    const out = { exported: 0, writtenBack: 0, completed: 0 };
    const dir = path.join(intel, 'intake');
    fs.mkdirSync(dir, { recursive: true });
    const projectId = await ensureProject(PROJECTS.intake);
    const tasks = (await client.getTasks({ projectId })).filter((t) => t.projectId === projectId && !t.isDone);
    for (const t of tasks) {
      const f = path.join(dir, `${t.id}.json`);
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, JSON.stringify({ taskId: t.id, title: t.title, notes: t.notes || '', created: t.created || null, exportedAt: new Date().toISOString(), t_id: null }, null, 2));
        out.exported += 1;
        continue;
      }
      let rec; try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      if (rec.t_id && !rec.writtenBack) {
        const notes = `${t.notes || ''}\n\nTarjeta: ${rec.t_id} · seguila en ${BOARD_URL}`.trim();
        await client.updateTask(t.id, { notes });
        rec.writtenBack = new Date().toISOString();
        fs.writeFileSync(f, JSON.stringify(rec, null, 2));
        out.writtenBack += 1;
      }
      if (rec.t_id) {
        const card = readCards().find((c) => c.id === rec.t_id);
        if (card && ['done', 'cancelled'].includes(card.state) && !rec.completedAt) {
          await client.setTaskDone(t.id);
          rec.completedAt = new Date().toISOString();
          fs.writeFileSync(f, JSON.stringify(rec, null, 2));
          out.completed += 1;
        }
      }
    }
    return out;
  }

  return { ensureProject, ensureProjects, ensureTag, createTaskOnce, completeOnce, appendNoteOnce, syncDecisions, syncIntake, syncOutcomes, recordDecision, readCards };
}

// ---------------------------------------------------------------- CLI
function parse(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i += 1; } else pos.push(argv[i]);
  }
  return { pos, opts };
}
// T-0405: la schtask corre `node sp-bridge.cjs sync` a secas, sin el .env.local que
// carga start-telegram-streamer.cmd. Se lee SOLO la URL publica del tablero (no
// secretos) de wezbridge/.env.local; el BOARD_TOKEN sale de board-app/.env.local por
// el mismo lector que usa la central de avisos (events-gateway.loadBoardToken).
function boardConfigFromEnv(env = process.env) {
  let publicUrl = env.WEZBRIDGE_BOARD_PUBLIC_URL || null;
  if (!publicUrl) {
    try {
      const text = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
      const m = text.match(/^\s*WEZBRIDGE_BOARD_PUBLIC_URL\s*=\s*(\S+)/m);
      if (m) publicUrl = m[1].replace(/^["']|["']$/g, '');
    } catch { /* sin .env.local: se usa BOARD_URL */ }
  }
  let boardToken = null;
  try { boardToken = require('../src/events-gateway.cjs').loadBoardToken(); } catch { boardToken = null; }
  return { boardUrl: publicUrl || BOARD_URL, boardToken };
}
async function main() {
  const { pos, opts } = parse(process.argv.slice(2));
  const cmd = pos[0];
  const client = createClient();
  const hub = createHub(client, { log: (m) => console.log(m), ...boardConfigFromEnv() });
  const stamp = () => new Date().toISOString();
  switch (cmd) {
    case 'ping': { const r = await client.ping(); console.log(JSON.stringify({ dataDir: client.dataDir, ...r })); return r.success ? 0 : 1; }
    case 'ensure-projects': console.log(JSON.stringify(await hub.ensureProjects(), null, 2)); return 0;
    case 'task': {
      const [, project, title] = pos;
      if (!project || !title) { console.error('uso: task <proyecto> "<titulo>" [--notes ..] [--ext id] [--due ISO]'); return 2; }
      const r = await hub.createTaskOnce({ ext: opts.ext || `manual:${stamp()}`, project, title, notes: opts.notes || '', dueWithTime: opts.due || null });
      console.log(JSON.stringify(r)); return 0;
    }
    case 'remind': {
      const [, title] = pos;
      if (!title || !opts.at) { console.error('uso: remind "<titulo>" --at <ISO> [--ext id] [--notes ..]'); return 2; }
      const r = await hub.createTaskOnce({ ext: opts.ext || `remind:${stamp()}`, project: PROJECTS.recordatorios, title, notes: opts.notes || '', dueWithTime: opts.at });
      console.log(JSON.stringify(r)); return 0;
    }
    case 'done': { if (!opts.ext) { console.error('uso: done --ext <id>'); return 2; } console.log(JSON.stringify({ completed: await hub.completeOnce(opts.ext) })); return 0; }
    case 'sync-decisions': console.log(JSON.stringify(await hub.syncDecisions())); return 0;
    case 'sync-intake': console.log(JSON.stringify(await hub.syncIntake())); return 0;
    case 'sync-outcomes': console.log(JSON.stringify(await hub.syncOutcomes())); return 0;
    case 'decided': {
      if (!opts.task || !opts.verb) { console.error('uso: decided --task T-0000 --verb approved|cancelled|deferred [--at ISO] [--by canal] [--why texto] [--until YYYY-MM-DD]'); return 2; }
      const r = await hub.recordDecision({ task: opts.task, ruling: opts.verb, at: opts.at || stamp(), by: opts.by || 'operator', why: opts.why || '', until: opts.until || null });
      console.log(JSON.stringify(r)); return 0;
    }
    case 'sync': {
      const r = await syncOnce({ hub });
      console.log(JSON.stringify(r.record));
      return r.ok ? 0 : 1;
    }
    default: console.error('uso: sp-bridge.cjs ping|ensure-projects|task|remind|done|decided|sync-decisions|sync-intake|sync-outcomes|sync'); return 2;
  }
}

/**
 * Una pasada de sync con evidencia DURABLE del resultado, exito o fallo (T-0376).
 *
 * Antes solo se logueaba el exito: cuando el plugin no contestaba, main() tiraba,
 * la schtask salia 1 y NADIE lo veia — el log de exitos quedo congelado en
 * 2026-09-04T13:17Z y la revision OMNIGOD lo encontro 12 h despues. Ahora:
 *   - exito  -> linea en logs/sp-bridge.log + _intel/.sp-bridge/last-success.json
 *   - fallo  -> linea {ts, error, stage} en el MISMO log + last-failure.json
 *               + evento sp-bridge.sync_failed en _intel/events.jsonl
 * El fallo no crea ni completa nada: reintentar es seguro porque cada creacion
 * es idempotente por id externo (createTaskOnce) y el map solo se escribe al
 * confirmar. Nunca lanza: devuelve {ok, record}.
 */
async function syncOnce({ hub, logDir = path.join(__dirname, '..', 'logs'), intelDir = INTEL, now = () => new Date() } = {}) {
  const ts = now().toISOString();
  const stateDir = path.join(intelDir, '.sp-bridge');
  const append = (file, obj) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(obj)}\n`); } catch { /* la evidencia nunca frena el sync */ } };
  const writeJson = (file, obj) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch { /* idem */ } };
  let stage = 'decisions';
  try {
    const decisions = await hub.syncDecisions();
    stage = 'intake';
    const intake = await hub.syncIntake();
    stage = 'outcomes';
    const outcomes = typeof hub.syncOutcomes === 'function' ? await hub.syncOutcomes() : { noted: 0 };
    const record = { ts, decisions, intake, outcomes };
    append(path.join(logDir, 'sp-bridge.log'), record);
    writeJson(path.join(stateDir, 'last-success.json'), record);
    return { ok: true, record };
  } catch (err) {
    const record = { ts, error: String(err && err.message || err).slice(0, 300), stage };
    append(path.join(logDir, 'sp-bridge.log'), record);
    writeJson(path.join(stateDir, 'last-failure.json'), record);
    append(path.join(intelDir, 'events.jsonl'), { time: ts, event: 'sp-bridge.sync_failed', stage, error: record.error });
    return { ok: false, record };
  }
}

module.exports = { PROTOCOL_VERSION, PROJECTS, AGENT_TAG, resolveDataDir, createClient, createHub, loadMap, mapFile, extMarker, syncOnce };
if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error(`sp-bridge: ${e.message}`); process.exit(1); });
