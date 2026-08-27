'use strict';
/**
 * Un despacho contra una tarjeta que los rulings dan por CERRADA tiene que
 * refusarse en el instante del despacho, no a las 72 horas.
 *
 * EL COSTO MEDIDO (2026-08-27). El orquestador escribió en rulings.jsonl que
 * T-0228 estaba `resolved` y no movió el `state` de la tarjeta, que quedó en
 * `ready`. Un dispatcher headless leyó el `state` y re-despachó trabajo ya
 * terminado al pane de memorymaster, que quemó un turno verificando y
 * devolviendo "esto ya está resuelto, hay inconsistencia ledger vs rulings".
 *
 * POR QUÉ ACÁ Y NO EN UN LINT DEL STEWARD. Se evaluó `ruling-unclosed` como
 * finding del gate y se descartó POR MEDICIÓN, no por gusto:
 *   - fail-first = 0: cero tarjetas T-NNNN en esa condición hoy; los 3 hits
 *     son ids sin tarjeta, o sea 3 falsos positivos el día uno;
 *   - no habría atrapado el caso que lo motiva: T-0228 tiene un `dispatched`
 *     (rulings.jsonl:235, 12:32Z) POSTERIOR al `resolved` (:229, 12:20Z), así
 *     que "el último ruling gana" sale limpio;
 *   - la ventana del daño fue de 10 min 48 s (ruling 12:20:00Z →
 *     state_changed_at 12:30:48Z), y ningún deadline que evite el falso
 *     positivo dispara en diez minutos.
 *
 * `checkDispatchGate` es el único punto que corre SINCRÓNICO CON EL DAÑO. Sin
 * deadline y sin categoría: no puede disparar sobre trabajo correcto en
 * reposo, sólo cuando alguien intenta despachar algo dado por cerrado.
 *
 * LA REGLA, elegida para no auto-silenciarse: refusar si existe un ruling de
 * CIERRE cuyo `at` es posterior al último movimiento de la tarjeta. Compara
 * contra un HECHO del archivo de la tarjeta (state_changed_at), no contra el
 * último ruling de cualquier tipo — por eso anexar prosa después no lo calla,
 * que es la falla que toda esta cadena existe para impedir.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { checkDispatchGate } = require('../src/a2a-intel.cjs');

const CORR = 'T-9001';
const MOVED = '2026-08-27T12:30:48.621Z';
const BEFORE_MOVE = '2026-08-27T12:20:00Z';
const AFTER_MOVE = '2026-08-27T12:32:00.000Z';

const openCard = (over = {}) => JSON.stringify({
  id: CORR, state: 'ready', blocker: null, state_changed_at: MOVED, updated_at: MOVED, ...over,
});

const line = (o) => JSON.stringify({ task: CORR, category: 'idle', ...o });

/**
 * readFile inyectado: la tarjeta y rulings.jsonl salen de acá, nunca del disco
 * real. `rulings === null` simula el archivo ausente.
 */
function reader(cardJson, rulings) {
  return (p) => {
    const f = String(p).replace(/\\/g, '/');
    if (f.endsWith('rulings.jsonl')) {
      if (rulings === null) throw new Error('ENOENT');
      return rulings;
    }
    if (cardJson === null) throw new Error('ENOENT');
    return cardJson;
  };
}

const gate = (cardJson, rulings) =>
  checkDispatchGate({ corr: CORR, type: 'request', readFile: reader(cardJson, rulings) });

// --- B1: el fail-first ------------------------------------------------------
test('B1: ruling de cierre POSTERIOR al último movimiento => despacho refusado', () => {
  const r = gate(
    openCard({ state_changed_at: '2026-08-27T11:00:00Z', updated_at: '2026-08-27T11:00:00Z' }),
    line({ ruling: 'resolved', at: BEFORE_MOVE, value_landed_in: 'PR #231' }) + '\n',
  );
  assert.strictEqual(r.allowed, false, 'la tarjeta está dada por cerrada en rulings.jsonl');
  assert.match(String(r.reason), /ruling/i, 'el reason tiene que nombrar el ruling, no sólo el estado');
});

// --- Anti-lobo: cada uno contra un edge case MEDIDO -------------------------
test('B2: la tarjeta movió DESPUÉS del ruling => permitido (el caso T-0228 real)', () => {
  // resolved 12:20:00Z, la tarjeta se movió 12:30:48Z. El cierre ya aterrizó.
  const r = gate(openCard(), line({ ruling: 'resolved', at: BEFORE_MOVE }) + '\n');
  assert.strictEqual(r.allowed, true);
});

test('B3: un `dispatched` posterior al `resolved` NO silencia el guard', () => {
  // El hábito real que mató al lint: se escribe el cierre y después la
  // narrativa completa del despacho. Las 3 tareas más recientes tienen esa
  // forma. Si esto silenciara, la narración limpiaría el gate.
  const r = gate(
    openCard({ state_changed_at: '2026-08-27T11:00:00Z', updated_at: '2026-08-27T11:00:00Z' }),
    [line({ ruling: 'resolved', at: BEFORE_MOVE }), line({ ruling: 'dispatched', at: AFTER_MOVE })].join('\n') + '\n',
  );
  assert.strictEqual(r.allowed, false);
});

test('B4: rulings.jsonl ausente, ilegible o con línea corrupta => permitido', () => {
  assert.strictEqual(gate(openCard(), null).allowed, true, 'ausente');
  assert.strictEqual(gate(openCard(), 'no soy json\n').allowed, true, 'ilegible');
  const mixed = ['{ roto', line({ ruling: 'dispatched', at: AFTER_MOVE })].join('\n') + '\n';
  assert.strictEqual(gate(openCard(), mixed).allowed, true, 'una línea corrupta no tumba la lectura');
});

test('B5: un ruling con prosa que contiene "resuelto" no cuenta como cierre', () => {
  // ~20 líneas de rulings.jsonl tienen párrafos doctrinales enteros en el
  // campo `ruling`. Igualdad exacta contra un Set, nada de .includes().
  const r = gate(
    openCard({ state_changed_at: '2026-08-27T11:00:00Z', updated_at: '2026-08-27T11:00:00Z' }),
    line({ ruling: 'esto ya estaba resuelto segun el pane, pero lo verifique igual', at: BEFORE_MOVE }) + '\n',
  );
  assert.strictEqual(r.allowed, true);
});

test('B6: `cancelled` no es palabra de cierre para este guard', () => {
  // Medido sobre rulings.jsonl: incluirla suma 3 falsos positivos y 0 verdaderos.
  const r = gate(
    openCard({ state_changed_at: '2026-08-27T11:00:00Z', updated_at: '2026-08-27T11:00:00Z' }),
    line({ ruling: 'cancelled', at: BEFORE_MOVE }) + '\n',
  );
  assert.strictEqual(r.allowed, true);
});

test('B7: un ruling sobre una tarea SIN tarjeta no tiene efecto', () => {
  // 19 de 125 ids gobernados no tienen archivo. "No encuentro la tarjeta" no
  // puede leerse como "no está cerrada".
  const r = gate(null, line({ ruling: 'resolved', at: BEFORE_MOVE }) + '\n');
  assert.strictEqual(r.allowed, true);
});

test('B8: tarjeta legacy sin state_changed_at => cae a updated_at, y sin ninguno permite', () => {
  const legacy = JSON.stringify({ id: CORR, state: 'ready', blocker: null, updated_at: MOVED });
  assert.strictEqual(gate(legacy, line({ ruling: 'resolved', at: BEFORE_MOVE }) + '\n').allowed, true,
    'updated_at posterior al ruling: el cierre ya aterrizó');

  const noStamps = JSON.stringify({ id: CORR, state: 'ready', blocker: null });
  assert.strictEqual(gate(noStamps, line({ ruling: 'resolved', at: BEFORE_MOVE }) + '\n').allowed, true,
    'sin marca temporal no se puede probar la violación: fail-open');
});

test('B8b: un ruling con `at` impresentable no prueba nada => permitido', () => {
  const r = gate(
    openCard({ state_changed_at: '2026-08-27T11:00:00Z', updated_at: '2026-08-27T11:00:00Z' }),
    line({ ruling: 'resolved', at: 'ayer a la tarde' }) + '\n',
  );
  assert.strictEqual(r.allowed, true);
});

test('B8c: un ruling de OTRA tarea no cubre a ésta', () => {
  const other = JSON.stringify({ task: 'T-9999', ruling: 'resolved', at: BEFORE_MOVE });
  const r = gate(
    openCard({ state_changed_at: '2026-08-27T11:00:00Z', updated_at: '2026-08-27T11:00:00Z' }),
    other + '\n',
  );
  assert.strictEqual(r.allowed, true);
});

// --- Lo que ya hacía sigue igual -------------------------------------------
test('el guard preexistente no cambia: blocker y estado no despachable siguen refusando', () => {
  const blocked = JSON.stringify({ id: CORR, state: 'ready', blocker: 'espera al operador', state_changed_at: MOVED });
  assert.strictEqual(gate(blocked, null).allowed, false);

  const doneCard = JSON.stringify({ id: CORR, state: 'done', blocker: null, state_changed_at: MOVED });
  assert.strictEqual(gate(doneCard, null).allowed, false);

  assert.strictEqual(
    checkDispatchGate({ corr: CORR, type: 'result', readFile: reader(openCard(), null) }).allowed,
    true, 'sólo los type=request pasan por el gate');
  assert.strictEqual(
    checkDispatchGate({ corr: 'no-es-tarea', type: 'request', readFile: reader(openCard(), null) }).allowed,
    true, 'un corr que no es id de tarjeta no se gatea');
});
