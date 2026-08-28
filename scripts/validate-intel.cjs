#!/usr/bin/env node
'use strict';
/**
 * validate-intel.cjs — valida la FORMA del plano de control (`_intel/tasks/`).
 *
 * POR QUE EXISTE (T-0295). `_intel` es repo git propio con 273 tarjetas y el
 * `rulings.jsonl`, y ningun proceso validaba su forma. Misma familia que T-0291
 * —un artefacto que nadie ejecuta— pero sobre los DATOS en vez del codigo.
 *
 * EL ALCANCE ESTA ELEGIDO POR MEDICION, y es la parte dificil de esta tarjeta.
 * Contadas las violaciones de cada invariante candidato sobre las 273 tarjetas
 * reales (48 abiertas), salen TRES capas que NO pueden tratarse igual:
 *
 *  CAPA 1 — UNIVERSALES, 0 violaciones hoy. Son hechos estructurales que
 *  siempre valieron: id bien formado, id == nombre de archivo, `state` y `kind`
 *  en su vocabulario, fechas parseables, `lease.expires_at` parseable,
 *  `depends_on` apuntando a tarjetas que existen. Se validan sobre TODA tarjeta
 *  y fallan cerrado: nacen verdes, asi que cualquier rojo futuro es una
 *  regresion real y no deuda heredada.
 *
 *  CAPA 2 — LA ABIERTA, 3 violaciones y las tres vivas: T-0229, T-0241 y
 *  T-0253, `ready` con `blocked_by: null`. Ese campo es —por el comentario del
 *  propio ledger— el UNICO que mide si la orquestacion funciona: cuantas tareas
 *  esperan al operador. Tres filas abiertas estaban fuera de esa cuenta.
 *  `assertBlockedBy` falla cerrado en `writeTask`, asi que entraron por un
 *  camino que lo esquiva: edicion a mano del JSON. Se valida solo sobre tarjetas
 *  ABIERTAS, porque en done/failed/cancelled el campo no significa nada — el
 *  mismo recorte que hace `assertBlockedBy`.
 *
 *  CAPA 3 — DEUDA HEREDADA, y aca esta la trampa. 93 tarjetas sin criterios, 16
 *  sin repo, 60 cerradas sin evidencia. Casi todas anteriores a los guards que
 *  hoy exigen esos campos. Un test fail-closed sobre esto NACE ROJO por cosas
 *  que ya no se pueden cambiar, y un guard que dispara sobre lo inmodificable se
 *  desactiva en una semana. Asi que NO gatea: se cuenta y se reporta.
 *
 *  El corte de la capa 3 no es "confiemos": `repo` se volvio fail-closed en
 *  `create()` el 2026-08-28 (T-0282), asi que para tarjetas creadas DESPUES de
 *  esa fecha si es exigible — una violacion nueva solo puede venir de esquivar
 *  el ledger. Es el mismo patron de epoca que ya usa `dispatch-lint` para no
 *  retro-marcar el backlog. Medido: 6 tarjetas post-epoca, 0 violaciones.
 *  `criteria` NO lleva epoca a proposito: el operador decidio en T-0282 que no
 *  fuera obligatorio, asi que exigirlo aca contradiria esa decision.
 *
 * Uso directo:  node scripts/validate-intel.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OPEN_STATES = ['queued', 'ready', 'running', 'review', 'blocked'];
const STATES = [...OPEN_STATES, 'done', 'failed', 'cancelled'];
const BLOCKED_BY_VOCAB = ['operator', 'third_party', 'agent'];
const TASK_FILE = /^T-\d{4}\.json$/;

/**
 * Desde cuando `repo` es exigible: el commit que lo volvio fail-closed en
 * `create()` (T-0282, _docs-curation 140a493). Antes de esa fecha una tarjeta
 * sin repo era LEGAL, y marcarla ahora seria castigar retroactivamente.
 */
const REPO_REQUIRED_SINCE = Date.parse('2026-08-28T04:06:46Z');

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
}

/**
 * Cuantas tarjetas existen en disco pero NO en git.
 *
 * Encontrado ejecutando esta tarjeta: 113 de 273 (T-0183 en adelante, ~10 dias
 * de trabajo de la flota) estan fuera del control de versiones, mientras
 * `rulings.jsonl` si esta. Es el defecto de T-0291 —archivos que existen y no se
 * versionan— un nivel mas arriba: el diseno entero dice "las sesiones son
 * descartables, los archivos son la memoria", y el 41% de esa memoria se va con
 * un `git clean` o un disco.
 *
 * Se CUENTA y NO gatea, por la misma razon que el resto de la capa 3: son 113
 * filas heredadas y un gate que nace rojo se desactiva. Pero se reporta en cada
 * corrida para que deje de ser invisible.
 *
 * Devuelve null si no se puede preguntar (sin git, o no es un repo): no saber no
 * es lo mismo que saber que estan todas, y un cero inventado seria peor.
 */
function untrackedCount(dir) {
  try {
    const out = execFileSync('git', ['ls-files', 'tasks'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tracked = new Set(out.split(String.fromCharCode(10)).filter(Boolean).map((q) => q.split('/').pop()));
    return fs.readdirSync(path.join(dir, 'tasks')).filter((f) => TASK_FILE.test(f) && !tracked.has(f)).length;
  } catch { return null; }
}

/** El vocabulario real de kinds. Ausente = no se valida, como en el ledger. */
function loadKinds(dir) {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'kinds.json'), 'utf8')).kinds || {}); }
  catch { return null; }
}

function loadTasks(dir) {
  const tasksDir = path.join(dir, 'tasks');
  let files;
  try { files = fs.readdirSync(tasksDir).filter((f) => TASK_FILE.test(f)); } catch { return null; }
  return files.map((f) => {
    try { return { file: f, task: JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')) }; }
    catch (e) { return { file: f, task: null, parseError: String(e.message).split('\n')[0] }; }
  });
}

/**
 * PURO — sin filesystem, para poder probar cada regla sin fabricar un _intel.
 * Devuelve { violations, debt }: lo primero GATEA, lo segundo solo se cuenta.
 */
function validate(rows, { kinds = null, now = Date.now() } = {}) {
  const violations = [];
  const ids = new Set(rows.filter((r) => r.task).map((r) => r.task.id));
  const add = (id, rule, detail) => violations.push({ id, rule, detail });

  for (const row of rows) {
    if (!row.task) { add(row.file, 'json-parse', row.parseError || 'no parsea'); continue; }
    const t = row.task;

    // --- CAPA 1: universales -------------------------------------------------
    if (!/^T-\d{4}$/.test(String(t.id || ''))) add(row.file, 'id-malformado', `id=${JSON.stringify(t.id)}`);
    else if (`${t.id}.json` !== row.file) add(t.id, 'id-no-coincide-con-archivo', `archivo ${row.file}`);
    if (!STATES.includes(t.state)) add(t.id, 'state-invalido', `state=${JSON.stringify(t.state)}`);
    if (kinds && !kinds.includes(t.kind)) add(t.id, 'kind-fuera-de-vocabulario', `kind=${JSON.stringify(t.kind)}`);
    for (const f of ['created_at', 'updated_at']) {
      if (t[f] !== undefined && !Number.isFinite(Date.parse(t[f]))) add(t.id, 'fecha-no-parseable', `${f}=${JSON.stringify(t[f])}`);
    }
    if (t.lease && !Number.isFinite(Date.parse(t.lease.expires_at || ''))) {
      add(t.id, 'lease-sin-vencimiento', `lease=${JSON.stringify(t.lease)}`);
    }
    for (const dep of t.depends_on || []) {
      if (!ids.has(dep)) add(t.id, 'depends_on-inexistente', `depende de ${dep}, que no existe`);
    }

    // --- CAPA 2: la abierta --------------------------------------------------
    // Solo tarjetas ABIERTAS: en done/failed/cancelled el campo no significa
    // nada, que es el mismo recorte que hace assertBlockedBy en el ledger.
    if (OPEN_STATES.includes(t.state) && !BLOCKED_BY_VOCAB.includes(t.blocked_by)) {
      add(t.id, 'abierta-sin-blocked_by', `state=${t.state} blocked_by=${JSON.stringify(t.blocked_by)}`);
    }

    // --- CAPA 3: exigible SOLO despues de que el guard existio ---------------
    const born = Date.parse(t.created_at || '');
    if (Number.isFinite(born) && born >= REPO_REQUIRED_SINCE && !String(t.repo || '').trim()) {
      add(t.id, 'sin-repo-post-guard', `creada ${t.created_at}, despues de que create() lo exige`);
    }
  }

  // --- deuda heredada: se CUENTA, nunca gatea -------------------------------
  const tasks = rows.map((r) => r.task).filter(Boolean);
  const debt = {
    sin_criterios: tasks.filter((t) => !Array.isArray(t.acceptance_criteria) || !t.acceptance_criteria.length).length,
    sin_repo: tasks.filter((t) => !String(t.repo || '').trim()).length,
    done_sin_evidencia: tasks.filter((t) => t.state === 'done' && !String(t.evaluator_evidence || '').trim()).length,
  };

  return { violations, debt, total: tasks.length, open: tasks.filter((t) => OPEN_STATES.includes(t.state)).length };
}

/** Shell de IO. `tasks === null` es "no hay ledger", que el caller juzga. */
function validateDir(dir = intelDir(), now = Date.now()) {
  const rows = loadTasks(dir);
  if (rows === null) return { dir, rows: null, violations: [], debt: null, total: 0, open: 0 };
  const r = validate(rows, { kinds: loadKinds(dir), now });
  r.debt.sin_trackear = untrackedCount(dir);
  return { dir, rows: rows.length, ...r };
}

module.exports = { validate, validateDir, loadTasks, OPEN_STATES, STATES, BLOCKED_BY_VOCAB, REPO_REQUIRED_SINCE };

if (require.main === module) {
  const r = validateDir();
  if (r.rows === null) { console.error(`validate-intel: no encontre ${path.join(intelDir(), 'tasks')}`); process.exit(1); }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.violations.length ? 1 : 0); }
  console.log(`validate-intel: ${r.total} tarjetas (${r.open} abiertas), ${r.violations.length} violacion(es).`);
  for (const v of r.violations) console.log(`  ${v.id} · ${v.rule} · ${v.detail}`);
  const untracked = r.debt.sin_trackear;
  console.log(`deuda heredada (NO gatea): ${r.debt.sin_criterios} sin criterios · ${r.debt.sin_repo} sin repo · `
    + `${r.debt.done_sin_evidencia} cerradas sin evidencia · `
    + `${untracked === null ? 'no se pudo preguntar a git' : `${untracked} SIN TRACKEAR EN GIT`}`);
  process.exit(r.violations.length ? 1 : 0);
}
