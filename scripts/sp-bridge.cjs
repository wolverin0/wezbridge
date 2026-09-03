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
function createHub(client, { intel = INTEL, log = () => {} } = {}) {
  const cache = { projects: null, tags: null };

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
  async function syncDecisions(cards = readCards()) {
    const out = { created: 0, completed: 0 };
    const gated = cards.filter((c) => c.state === 'blocked' && gateOf(c) === 'operator');
    for (const c of gated) {
      const r = await createTaskOnce({
        ext: `fleet:${c.id}`, project: PROJECTS.decisiones,
        title: `${c.id} · ${String(c.title || '').slice(0, 90)}`,
        notes: `${c.blocker || 'esperando tu decision'}\n\nDecidir en el tablero: ${BOARD_URL} (o /decidir ${c.id} en el pane)\ncorr: ${c.corr || '-'} · repo: ${c.repo || '-'}`,
        tags: ['fleet'],
      });
      if (r.created) out.created += 1;
    }
    const map = loadMap(intel);
    for (const [ext, e] of Object.entries(map)) {
      if (!ext.startsWith('fleet:') || e.doneAt) continue;
      const id = ext.slice('fleet:'.length);
      const card = cards.find((c) => c.id === id);
      const stillGated = card && card.state === 'blocked' && gateOf(card) === 'operator';
      if (!stillGated && await completeOnce(ext)) out.completed += 1;
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

  return { ensureProject, ensureProjects, ensureTag, createTaskOnce, completeOnce, appendNoteOnce, syncDecisions, syncIntake, readCards };
}

// ---------------------------------------------------------------- CLI
function parse(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i += 1; } else pos.push(argv[i]);
  }
  return { pos, opts };
}
async function main() {
  const { pos, opts } = parse(process.argv.slice(2));
  const cmd = pos[0];
  const client = createClient();
  const hub = createHub(client, { log: (m) => console.log(m) });
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
    case 'sync': {
      const out = { ts: stamp(), decisions: await hub.syncDecisions(), intake: await hub.syncIntake() };
      console.log(JSON.stringify(out));
      // La schtask corre oculta (run-hidden.vbs) y no captura stdout: el log es propio.
      try {
        const logDir = path.join(__dirname, '..', 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'sp-bridge.log'), `${JSON.stringify(out)}\n`);
      } catch { /* el log nunca frena la sincronizacion */ }
      return 0;
    }
    default: console.error('uso: sp-bridge.cjs ping|ensure-projects|task|remind|done|sync-decisions|sync-intake|sync'); return 2;
  }
}

module.exports = { PROTOCOL_VERSION, PROJECTS, AGENT_TAG, resolveDataDir, createClient, createHub, loadMap, mapFile, extMarker };
if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error(`sp-bridge: ${e.message}`); process.exit(1); });
