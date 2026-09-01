'use strict';
/**
 * rulings.cjs — UN criterio de "cual ruling es el mas reciente" + UN escritor.
 * Lectura: `rulingsFor` / `latestRuling` / `latestRulingWhere` / `taskIds`
 * (orden de archivo, tolerante con las lineas legacy sin `source`).
 * Escritura: `RULING_VOCAB` (+approved), `RULING_SOURCES` (procedencia
 * OBLIGATORIA), `validateRulingLine(line, now)` pura y `appendRuling(intelDir,
 * line)` — el unico camino a `_intel/rulings.jsonl`. Leer cuando se toque el
 * schema del ruling, quien lo escribe, o el gate que lo consulta.
 *
 * POR QUE EXISTE (T-0294). Tres piezas decidian eso con criterios distintos
 * sobre el MISMO `_intel/rulings.jsonl`:
 *
 *   steward-gate.cjs:137      [...applicable].reverse().find(...)  -> orden de archivo
 *   orchestrator-turn.cjs:210 [...applicable].reverse().find(...)  -> orden de archivo
 *   dispatch-lint.cjs:91      at >= prev.at_ms                     -> orden de timestamp
 *
 * Hoy no divergen —medido: 248 lineas, 127 tareas, 55 con mas de un ruling, CERO
 * tareas donde el ganador difiera— asi que esto es latente y no vivo. Se arregla
 * ahora porque es la misma familia que costo caro cuatro veces esta semana: dos
 * autoridades sobre un artefacto con criterios que nadie cruzo.
 *
 * EL CRITERIO ELEGIDO ES EL ORDEN DE ARCHIVO, y se elige por consecuencia:
 *
 *  · `rulings.jsonl` es append-only, asi que el orden del archivo ES el orden en
 *    que se tomaron las decisiones. Appendear ES decidir.
 *  · El `at` no es un reloj confiable: 103 de 248 valores (42%) terminan en
 *    `:00Z` o `:00.000Z`, o sea tipeados a mano por un agente y no medidos.
 *    Ordenar por eso es ordenar por ruido encima del orden verdadero.
 *  · Ya hay UNA tarea con dos rulings del MISMO `at`, donde el orden por
 *    timestamp esta INDEFINIDO y cualquier implementacion cae de vuelta en el
 *    orden de archivo. O sea que el orden de archivo es el primitivo del que el
 *    otro criterio depende igual.
 *  · Es el que ya usaban 2 de los 3, asi que unificar mueve un solo consumidor.
 *
 * LO QUE ESTE MODULO NO UNIFICA, A PROPOSITO. Hay DOS preguntas distintas, y las
 * dos son legitimas:
 *   `latestRuling`      — "la ultima linea, y despues la evaluo". Si la mas
 *                         nueva no aplica, las viejas NO la rescatan. Es lo que
 *                         necesita el lint: un ruling revisado por otro
 *                         posterior deja de contar.
 *   `latestRulingWhere` — "la ultima linea que SATISFACE el predicado". Es lo
 *                         que necesitan el gate y el waker: una cobertura vieja
 *                         sigue valiendo si nada posterior la contradijo.
 * Son preguntas distintas, no dos respuestas a la misma. Lo unico que no puede
 * haber es dos criterios de ORDEN, y eso vive aca y en un solo lugar.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Las lineas que hablan de `taskId`, en ORDEN CANONICO (mas vieja primero).
 * El orden canonico es el del archivo, que es el de escritura.
 */
function rulingsFor(rulings, taskId) {
  return (Array.isArray(rulings) ? rulings : []).filter((r) => r && r.task === taskId);
}

/**
 * La ultima linea escrita sobre `taskId` que satisface `pred`, o null.
 * Retrocede desde la mas nueva; la primera que aplica gana.
 */
function latestRulingWhere(rulings, taskId, pred) {
  const applicable = rulingsFor(rulings, taskId);
  for (let i = applicable.length - 1; i >= 0; i -= 1) {
    if (pred(applicable[i])) return applicable[i];
  }
  return null;
}

/** La ultima linea escrita sobre `taskId`, sin filtrar, o null. */
function latestRuling(rulings, taskId) {
  return latestRulingWhere(rulings, taskId, () => true);
}

/** Los ids de tarea presentes, en orden de primera aparicion. */
function taskIds(rulings) {
  return [...new Set((Array.isArray(rulings) ? rulings : [])
    .filter((r) => r && r.task).map((r) => r.task))];
}

// ---------------------------------------------------------------------------
// ESCRITURA — procedencia obligatoria, un solo camino al archivo
// ---------------------------------------------------------------------------
//
// POR QUE (W1, 2026-09-01). Hasta hoy hay TRES escritores de rulings.jsonl —el
// tablero, el pane orquestador a mano, y el que venga— y ninguna linea dice
// cual fue. Con tres escritores y cero procedencia, "quien decidio esto" no se
// puede responder leyendo el archivo, que es justo lo que el archivo existe
// para responder. Las 338 lineas ya escritas NO se reescriben: `source` se
// exige al ESCRIBIR, nunca al LEER (los lectores de arriba no lo miran).
//
// Falla CERRADO como el resto de la familia (assertKnownKind, assertBlockedBy,
// parseArgs): el llamador esta ahi y puede corregir. Un campo que se acepta y
// no se lee es el dropper silencioso que T-0282 existe para terminar, asi que
// un campo DESCONOCIDO tambien se rechaza en vez de tragarse.

/** Palabras que un ruling puede ser. Enum cerrado: el gate lo interpreta. */
const RULING_VOCAB = ['cancelled', 'operator-gated', 'resolved', 'deferred', 'dispatched', 'approved'];

/** Quien pudo haber escrito la linea. Enum cerrado por la misma razon. */
const RULING_SOURCES = ['board-app', 'ledger-cli', 'telegram', 'orchestrator-pane', 'drill'];

/** Campos que una linea puede tener. Cualquier otro se rechaza, no se ignora. */
const RULING_FIELDS = ['task', 'category', 'ruling', 'why', 'at', 'until', 'source', 'by', 'corr'];

/**
 * `approved` responde UNA pregunta: la que el operador tenia pendiente. Por eso
 * solo se acepta sobre `awaiting-operator` (o sin categoria, que es el caso del
 * escritor que no vio ningun hallazgo). Aprobar no es "esta tarea ya no
 * importa": si nadie la toma, vuelve a sonar como `idle`, y eso es correcto.
 */
const APPROVED_CATEGORIES = [null, 'awaiting-operator'];

const TASK_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function toMs(now) {
  if (now === undefined || now === null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Valida y NORMALIZA una linea de ruling. Pura: sin reloj propio ni fs.
 * Devuelve `{ok:true, line}` con la linea exacta que se escribiria, o
 * `{ok:false, error}` con el motivo en una sola frase.
 */
function validateRulingLine(line, now) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    return { ok: false, error: 'a ruling must be a JSON object' };
  }
  const unknown = Object.keys(line).filter((k) => !RULING_FIELDS.includes(k));
  if (unknown.length) {
    return {
      ok: false,
      error: `unknown field(s) ${unknown.join(', ')} — a ruling carries only ${RULING_FIELDS.join(', ')}`,
    };
  }
  if (typeof line.task !== 'string' || !TASK_ID_RE.test(line.task)) {
    return { ok: false, error: `invalid task id ${JSON.stringify(line.task)} — must match ${TASK_ID_RE}` };
  }
  if (!RULING_VOCAB.includes(line.ruling)) {
    return { ok: false, error: `ruling must be one of ${RULING_VOCAB.join('|')}, got ${JSON.stringify(line.ruling)}` };
  }
  if (!nonEmptyString(line.why)) {
    return { ok: false, error: 'why is required — a ruling with no reason is a shrug, not a decision' };
  }
  if (!RULING_SOURCES.includes(line.source)) {
    return {
      ok: false,
      error: `source is required and must be one of ${RULING_SOURCES.join('|')}, got ${JSON.stringify(line.source)}`
        + ' — a ruling nobody signed cannot be audited',
    };
  }
  const category = line.category === undefined ? null : line.category;
  if (category !== null && !nonEmptyString(category)) {
    return { ok: false, error: 'category must be a non-empty string or null' };
  }
  if (line.ruling === 'approved' && !APPROVED_CATEGORIES.includes(category)) {
    return {
      ok: false,
      error: `approved is only accepted on category awaiting-operator or null, got ${JSON.stringify(category)}`
        + ' — approving answers the operator question, it does not silence a different finding',
    };
  }
  const nowMs = toMs(now);
  let until;
  if (line.ruling === 'deferred') {
    const t = Date.parse(line.until);
    if (!Number.isFinite(t)) return { ok: false, error: 'deferred requires a valid ISO `until`' };
    if (t <= nowMs) return { ok: false, error: '`until` must be in the future — a deferral into the past is a shrug' };
    until = new Date(t).toISOString();
  } else if (line.until !== undefined) {
    return { ok: false, error: '`until` only belongs on a deferred ruling' };
  }
  let at;
  if (line.at === undefined) {
    at = new Date(nowMs).toISOString();
  } else {
    const parsed = Date.parse(line.at);
    if (!Number.isFinite(parsed)) return { ok: false, error: `invalid \`at\` ${JSON.stringify(line.at)}` };
    at = line.at;
  }
  for (const opt of ['by', 'corr']) {
    if (line[opt] !== undefined && !nonEmptyString(line[opt])) {
      return { ok: false, error: `${opt}, when present, must be a non-empty string` };
    }
  }
  const out = { task: line.task, category, ruling: line.ruling, why: line.why.trim(), at };
  if (until) out.until = until;
  out.source = line.source;
  if (line.by !== undefined) out.by = line.by;
  if (line.corr !== undefined) out.corr = line.corr;
  return { ok: true, line: out };
}

/**
 * Appendea UNA linea a `<intelDir>/rulings.jsonl`, o tira. Serializa ANTES de
 * abrir el archivo: si la linea es invalida el archivo ni se toca, y la
 * escritura es un solo `appendFileSync` — nunca media linea.
 */
function appendRuling(intelDir, line, { now } = {}) {
  const verdict = validateRulingLine(line, now);
  if (!verdict.ok) throw new Error(`appendRuling refused this line: ${verdict.error}`);
  const text = `${JSON.stringify(verdict.line)}\n`;
  fs.appendFileSync(path.join(intelDir, 'rulings.jsonl'), text);
  return verdict.line;
}

module.exports = {
  rulingsFor, latestRuling, latestRulingWhere, taskIds,
  RULING_VOCAB, RULING_SOURCES, RULING_FIELDS, APPROVED_CATEGORIES,
  validateRulingLine, appendRuling,
};
