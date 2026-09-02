'use strict';
/**
 * pane-registry.cjs — identidad de panes por ROL, registrada desde la sesion (T-0322, opcion A).
 * (Distinto de pane-identity.cjs, que resuelve PROYECTO -> pane por cwd/alias en el censo.)
 *
 * Problema: el roster de bots despacha por schtask -> poke-pane y necesita un
 * selector ESTABLE que no dependa del cwd (infra reporta la raiz) ni del
 * tab_title (vacio tras cada reemplazo de GUI). Ningun id de pane es una
 * direccion (renumeran), asi que la identidad la declara la SESION al arrancar:
 * un hook SessionStart escribe <registro>/<WEZTERM_PANE>.json con
 * { role, project, cwd, pid, agent, started_at }. El id es el del mux (es el
 * que ve el proceso: medido, WEZTERM_PANE=2 == `cli --prefer-mux list` id 2),
 * o sea el espacio canonico de T-0260.
 *
 * Resolver por rol = leer el registro y VALIDAR contra el mux: el pane existe,
 * su cwd coincide y el pid sigue vivo. Si no, falla CERRADO con el motivo, y
 * los registros de panes muertos se borran solos. Unicidad: un rol con un pane
 * vivo y valido en el mismo cwd no se puede volver a registrar desde OTRO pane
 * (ambiguedad imposible por construccion, no por suerte); el mismo pane si se
 * re-registra (resume / clear).
 *
 * Todo lo que toca el mundo (lista de panes, pid, reloj, directorio) se inyecta:
 * el modulo es testeable sin wezterm.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIELDS = Object.freeze(['role', 'project', 'cwd', 'pid', 'agent', 'started_at']);

function registryDir() {
  return process.env.WEZBRIDGE_PANE_REGISTRY || path.join(os.homedir(), '.local', 'share', 'wezterm', 'panes');
}

/** `file:///G:/Py%20Apps/x/` y `G:\Py Apps\x` son el mismo cwd. */
function normalizeCwd(value) {
  let s = String(value || '');
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/[^/]*/i, '');
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  }
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Proyecto = ruta relativa bajo "Py Apps", o el basename. Misma regla que pane-beacon. */
function projectOf(cwd) {
  const parts = String(cwd || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === 'py apps');
  if (i >= 0 && parts[i + 1]) return parts.slice(i + 1).join('/');
  return parts[parts.length - 1] || 'unknown';
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function entryFile(dir, paneId) { return path.join(dir, `${paneId}.json`); }

function readRegistry(dir = registryDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of names) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ ...e, paneId: Number(f.replace(/\.json$/, '')), file: path.join(dir, f) });
    } catch { /* un registro ilegible no es un pane: se ignora */ }
  }
  return out;
}

/**
 * @param entry registro
 * @param list  panes del mux: [{ pane_id, cwd }] (null = no se pudo listar)
 * @returns { ok, reason }  reason: pane-missing | cwd-mismatch | pid-dead | unverifiable
 */
function validateEntry(entry, list, { pidCheck = true, pidAlive = isPidAlive } = {}) {
  if (!Array.isArray(list)) return { ok: false, reason: 'unverifiable' };
  const pane = list.find((p) => Number(p.pane_id) === Number(entry.paneId));
  if (!pane) return { ok: false, reason: 'pane-missing' };
  if (normalizeCwd(pane.cwd) !== normalizeCwd(entry.cwd)) return { ok: false, reason: 'cwd-mismatch', pane };
  if (pidCheck && !pidAlive(entry.pid)) return { ok: false, reason: 'pid-dead', pane };
  return { ok: true, pane };
}

/** Borra un registro; nunca tira. */
function unregister({ paneId, dir = registryDir() }) {
  try { fs.unlinkSync(entryFile(dir, paneId)); return true; } catch { return false; }
}

/**
 * Escribe <dir>/<paneId>.json. Tira si OTRO pane vivo y valido ya tiene ese rol
 * en ese cwd; un competidor invalido (pane muerto, cwd distinto, pid muerto) se
 * borra y se sigue. Con `list` null (wezterm ilegible) no se puede verificar al
 * competidor: se registra igual y se devuelve `unverified: true`.
 */
function register({ role, project, cwd, pid, agent, paneId, startedAt, list = null, dir = registryDir(), now = () => Date.now(), pidAlive = isPidAlive }) {
  if (!String(role || '').trim()) throw new Error('register: role is required');
  if (!Number.isInteger(Number(paneId))) throw new Error(`register: paneId must be an integer (WEZTERM_PANE), got ${JSON.stringify(paneId)}`);
  const me = Number(paneId);
  const entry = {
    role: String(role).trim(),
    project: project || projectOf(cwd),
    cwd: String(cwd || ''),
    pid: Number(pid),
    agent: agent || 'unknown',
    started_at: startedAt || new Date(now()).toISOString(),
  };
  let unverified = false;
  for (const other of readRegistry(dir)) {
    if (other.paneId === me) continue;
    if (other.role !== entry.role || normalizeCwd(other.cwd) !== normalizeCwd(entry.cwd)) continue;
    const v = validateEntry(other, list, { pidAlive });
    if (v.ok) {
      throw new Error(`role "${entry.role}" is already held by a LIVE pane ${other.paneId} (pid ${other.pid}, ${other.cwd}) — refusing to register pane ${me} for the same role+cwd; two panes answering to one role is the ambiguity this registry exists to prevent`);
    }
    if (v.reason === 'unverifiable') { unverified = true; continue; }
    unregister({ paneId: other.paneId, dir }); // competidor muerto: se limpia solo
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = entryFile(dir, me);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, file);
  return { ok: true, file, entry: { ...entry, paneId: me }, unverified };
}

/**
 * Resuelve un rol a un pane VALIDADO contra `list`. Falla cerrado con motivo.
 * Los registros cuyo pane murio (pane-missing / pid-dead) se borran (cleanup).
 * Dos registros validos para el mismo rol = ambiguous (no se elige uno).
 */
function resolveRole(role, { list, dir = registryDir(), cleanup = true, pidAlive = isPidAlive } = {}) {
  const want = String(role || '').trim();
  const mine = readRegistry(dir).filter((e) => e.role === want);
  if (!mine.length) return { ok: false, reason: 'no-registry', detail: `no pane registered role "${want}" in ${dir} (the session's SessionStart hook writes it)` };
  const valid = [];
  const invalid = [];
  for (const e of mine) {
    const v = validateEntry(e, list, { pidAlive });
    if (v.ok) valid.push({ entry: e, pane: v.pane });
    else {
      invalid.push({ entry: e, reason: v.reason });
      if (cleanup && (v.reason === 'pane-missing' || v.reason === 'pid-dead')) unregister({ paneId: e.paneId, dir });
    }
  }
  if (valid.length === 1) return { ok: true, entry: valid[0].entry, pane: valid[0].pane, paneId: valid[0].entry.paneId };
  if (valid.length > 1) return { ok: false, reason: 'ambiguous', detail: `role "${want}" has ${valid.length} live panes: ${valid.map((v) => v.entry.paneId).join(', ')} — refusing to guess` };
  const why = invalid.map((i) => `pane ${i.entry.paneId}: ${i.reason}`).join('; ');
  return { ok: false, reason: invalid[0].reason, detail: `role "${want}" is registered but not valid — ${why}` };
}

module.exports = { FIELDS, registryDir, normalizeCwd, projectOf, isPidAlive, readRegistry, validateEntry, register, unregister, resolveRole };
