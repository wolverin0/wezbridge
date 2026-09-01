'use strict';
/**
 * result-linker.cjs — W2: un `a2a.result` MUEVE la tarjeta del ledger.
 * Entrada: una linea de _intel/a2a-results.jsonl. Salida: `ledger update` con
 * evidencia que apunta a ESA linea, o un evento `result.unlinked` con la razon.
 * running -> review (v2=ok) · FinalOrchestra <job>: FAILED -> failed ·
 * BLOCKED -> blocked+blocker · NUNCA done (cerrar es juicio del operador).
 * Idempotente por linea (la evidencia ya citada) y JAMAS tira: corre dentro del
 * camino de respuesta de a2a_send. Razones: ambiguous|state=<s>|no-card|
 * no-task-corr|ledger-error|v2=<x>. Cursor y CLI: scripts/result-link.cjs.
 *
 * POR QUE EXISTE: hasta hoy `running -> review` era 100% manual. La rama
 * type=result de a2a_send registraba el cuerpo y auto-ackeaba el hilo, y ahi
 * moria: la tarjeta seguia diciendo "running" con un result completo al lado.
 * El tablero mostraba trabajo en curso que ya habia terminado, que es la misma
 * familia de defecto que "Needs Attention: 0".
 *
 * POR QUE NUNCA `done`: el steward se niega por diseno a cerrar nada, y esto
 * tampoco puede. `review` dice "hay algo que mirar"; `done` dice "lo mire y
 * esta bien", y eso no lo puede afirmar el que entrego el trabajo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { taskIdFromCorr, intelDir } = require('./a2a-intel.cjs');

/** Estados destino permitidos. `done` NO esta y no puede estar. */
const TARGETS = new Set(['review', 'failed', 'blocked']);

/** `FinalOrchestra JOB-x: COMPLETED|FAILED|BLOCKED` en cualquier linea del cuerpo. */
const VERDICT = /^\s*FinalOrchestra\s+(\S+)\s*:\s*(COMPLETED|FAILED|BLOCKED)\b/im;

/**
 * Que tarjeta le corresponde a este corr.
 *
 * El corr EXACTO declarado en la tarjeta gana sobre el parecido del id: una
 * tarjeta puede llevar el corr de otra en su campo `corr` (revisiones, hilos
 * heredados), y el campo declarado es un HECHO mientras que el prefijo es una
 * inferencia. Dos tarjetas con el mismo corr exacto es AMBIGUO y falla cerrado:
 * mover la equivocada es peor que no mover ninguna, porque nadie lo revisa.
 *
 * Devuelve { card } | { reason: 'ambiguous', ids } | { reason: 'no-card' } |
 * { reason: 'no-task-corr' }.
 */
function resolveCardForCorr(corr, readTasks) {
  let tasks;
  try { tasks = readTasks() || []; } catch { tasks = []; }
  const exact = tasks.filter((t) => t && t.corr && String(t.corr) === String(corr));
  if (exact.length === 1) return { card: exact[0] };
  if (exact.length > 1) return { reason: 'ambiguous', ids: exact.map((t) => t.id) };
  const id = taskIdFromCorr(corr);
  if (!id) return { reason: 'no-task-corr' };
  const card = tasks.find((t) => t && t.id === id);
  return card ? { card } : { reason: 'no-card' };
}

/** Puntero de evidencia a la linea EXACTA que justifico el movimiento. */
function evidencePointer(line) {
  return `a2a-results.jsonl#time=${line.time} corr=${line.corr} from=pane-${line.from_pane} v2=${line.v2}`;
}

/** Veredicto declarado + (para BLOCKED) la primera linea util despues de el. */
function readVerdict(body) {
  const text = String(body || '');
  const m = VERDICT.exec(text);
  if (!m) return { verdict: 'COMPLETED', job: null, blocker: null };
  const lines = text.slice(m.index + m[0].length).split('\n');
  const blocker = lines.map((l) => l.trim()).find((l) => l) || null;
  return { verdict: m[2].toUpperCase(), job: m[1], blocker };
}

/**
 * Liga UNA linea de a2a-results.jsonl a su tarjeta.
 *
 * `line` es el registro tal cual quedo persistido (time, corr, from_pane, v2,
 * body). Nunca tira: cualquier fallo del ledger sale como `ledger-error`.
 */
function link(line, { runLedger, readTasks, recordEvent, now = () => Date.now() } = {}) {
  const corr = line && line.corr;
  const unlinked = (reason, extra = {}) => {
    try { recordEvent({ event: 'result.unlinked', corr, reason, ...extra }); } catch { /* fail-soft */ }
    return { linked: false, reason };
  };

  // Un result sin bloque criteria no es un resultado verificable, asi que no
  // puede mover una tarjeta. a2a_send ya lo rechaza en el emisor; esto cubre
  // las lineas viejas y las que entraron con el enforcement apagado.
  if (!line || line.v2 !== 'ok') return unlinked(`v2=${line && line.v2 ? line.v2 : 'missing'}`);

  const hit = resolveCardForCorr(corr, readTasks);
  if (!hit.card) return unlinked(hit.reason, hit.ids ? { ids: hit.ids } : {});
  const card = hit.card;

  // IDEMPOTENCIA por linea: si la evidencia de la tarjeta ya cita ESTA linea,
  // el trabajo ya se hizo. Se chequea ANTES del estado a proposito — si no, la
  // segunda pasada del cursor veria `state=review` y emitiria un hallazgo
  // `result.unlinked` sobre su propio exito, que es un instrumento que miente.
  const pointer = `a2a-results.jsonl#time=${line.time}`;
  if (String(card.evaluator_evidence || '').includes(pointer)) {
    return { linked: false, noop: true, reason: 'already-linked', id: card.id };
  }
  if (card.state !== 'running') return unlinked(`state=${card.state}`, { task_id: card.id });

  const { verdict, blocker } = readVerdict(line.body);
  const target = verdict === 'FAILED' ? 'failed' : (verdict === 'BLOCKED' ? 'blocked' : 'review');
  // Guard vivo, no comentario: si alguien alguna vez mapea un veredicto a
  // `done`, esto lo rechaza en vez de cerrar trabajo sin que nadie lo mire.
  if (!TARGETS.has(target)) return unlinked(`state=${target}`, { task_id: card.id });

  const args = [
    'update', card.id,
    '--state', target,
    '--evidence', evidencePointer(line),
    '--corr', String(corr),
    '--note', `auto: a2a result → ${target}`,
  ];
  if (target === 'blocked') {
    args.push('--blocked-by', 'agent');
    args.push('--blocker', blocker || 'el executor reporto BLOCKED sin nombrar el motivo');
  }
  try {
    runLedger(args);
  } catch (err) {
    return unlinked('ledger-error', {
      task_id: card.id, detail: String((err && err.message) || err).slice(0, 200),
    });
  }
  return { linked: true, id: card.id, from: 'running', to: target, at: new Date(now()).toISOString() };
}

/**
 * Las dependencias reales, compartidas por a2a_send y por scripts/result-link.cjs.
 * ledger.cjs sigue siendo el UNICO escritor de tasks/ — esto le habla por CLI,
 * igual que takeDispatchLease, en vez de tocar el JSON.
 */
function defaultReadTasks(dir = intelDir()) {
  const tasksDir = path.join(dir, 'tasks');
  let names;
  try { names = fs.readdirSync(tasksDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^T-\d{4}\.json$/.test(name)) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8'))); } catch { /* linea rota: se saltea */ }
  }
  return out;
}

function defaultRunLedger(args, dir = intelDir()) {
  const ledger = path.join(dir, '..', '_docs-curation', 'ledger.cjs');
  return execFileSync(process.execPath, [ledger, ...args], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
}

module.exports = {
  link, resolveCardForCorr, evidencePointer, readVerdict, TARGETS,
  defaultReadTasks, defaultRunLedger,
};
