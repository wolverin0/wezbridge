'use strict';
/**
 * Un `kind` fuera de kinds.json no matchea ninguna regla, y por eso NO PASA POR
 * NINGÚN GATE. Despachar una tarjeta así es despachar por el único camino sin
 * control.
 *
 * MEDIDO 2026-08-29, T-0262: un orchestrator HEADLESS despachó a la pane de
 * infra un DELETE sobre la base de producción de un TERCERO (el appliance
 * UISP). La tarjeta tiene `kind: "data-fix"`, que no está en kinds.json — y el
 * test R.2 de intel-registries lo dice con todas las letras desde el 25-ago:
 *   "ledger kind 'data-fix' missing from kinds.json — it would match no rule
 *    and bypass the gate"
 * Era un fallo VISIBLE en la suite que nadie conectó con el despacho.
 *
 * El despacho además llevaba el alcance vencido (48 filas, cuando la medición
 * del 25-ago dijo 1400 y el operador re-autorizó 12), pedía DELETE donde su
 * propia fuente manda UPDATE, y apuntaba a una pane sin credencial. Nada se
 * escribió: pararon los criterios fail-closed de la tarjeta. Pero el gate de
 * despacho —que corre ANTES y es más barato— no tuvo nada que decir.
 *
 * ESTE GATE NO REEMPLAZA A LOS CRITERIOS. Corta antes: si el kind no está
 * gobernado, la tarjeta no debería viajar.
 *
 * FAIL-OPEN por diseño: kinds.json ausente o ilegible => permitir. Un gate que
 * falla cerrado sobre su propio registro paraliza el fleet, y eso es peor que
 * el agujero que tapa.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { checkDispatchGate } = require('../src/a2a-intel.cjs');

const KINDS = ['bug', 'tooling-fix', 'docs', 'general', 'observability'];

/** readFile falso: sirve la tarjeta y kinds.json, nada más existe. */
function reader({ kind, state = 'ready', kindsJson = { kinds: KINDS } }) {
  return (p) => {
    const f = path.basename(String(p));
    if (f === 'kinds.json') {
      if (kindsJson === null) throw new Error('ENOENT');
      return JSON.stringify(kindsJson);
    }
    if (f === 'T-0262.json') {
      return JSON.stringify({ id: 'T-0262', state, kind, blocker: '', state_changed_at: '2026-08-25T17:27:39.022Z' });
    }
    throw new Error(`ENOENT ${f}`); // rulings.jsonl incluido: fail-open aguas arriba
  };
}

const gate = (over) => checkDispatchGate({ corr: 'T-0262', type: 'request', readFile: reader(over) });

// ── SENTIDO A: kind no gobernado => NO despachar ────────────────────────────

test('A1 (fail-first): un kind fuera de kinds.json no se despacha', () => {
  const r = gate({ kind: 'data-fix' });
  assert.strictEqual(r.allowed, false,
    'data-fix no está en el vocabulario cerrado: no matchea regla y saltea todo gate');
  assert.match(String(r.reason), /kind/i, 'el motivo tiene que nombrar el kind, no ser genérico');
  assert.match(String(r.reason), /data-fix/, 'y tiene que citar CUÁL kind, para que se pueda arreglar');
});

test('A2: el motivo dice qué hacer, no sólo que no', () => {
  const r = gate({ kind: 'data-fix' });
  assert.match(String(r.reason), /kinds\.json/,
    'sin nombrar el archivo, el receptor no sabe dónde está la decisión');
});

// ── SENTIDO B: lo que ya funcionaba tiene que seguir funcionando ────────────

test('B1 (el otro sentido): un kind gobernado SÍ se despacha', () => {
  assert.strictEqual(gate({ kind: 'tooling-fix' }).allowed, true,
    'si esto se rompe, el gate deja de despachar todo el fleet');
});

test('B2: kinds.json ilegible => fail-open, se despacha', () => {
  assert.strictEqual(gate({ kind: 'data-fix', kindsJson: null }).allowed, true,
    'un gate que falla cerrado sobre su propio registro es peor que el agujero');
});

test('B3: kinds.json con forma inesperada => fail-open', () => {
  assert.strictEqual(gate({ kind: 'data-fix', kindsJson: { otra: 'cosa' } }).allowed, true,
    'no se puede refutar un kind contra un registro que no se sabe leer');
});

test('B4: tarjeta sin kind => fail-open (legacy, no se backfilean)', () => {
  assert.strictEqual(gate({ kind: undefined }).allowed, true);
});

test('B5: el gate de estado sigue mandando — una tarjeta done no se despacha aunque el kind sea válido', () => {
  const r = gate({ kind: 'tooling-fix', state: 'done' });
  assert.strictEqual(r.allowed, false, 'no despachar trabajo cerrado');
  assert.doesNotMatch(String(r.reason), /kinds\.json/,
    'el motivo tiene que ser el estado, no el kind: un diagnóstico equivocado manda a arreglar lo que no es');
});

test('B6: kinds.json como lista pelada también se entiende', () => {
  const r = checkDispatchGate({
    corr: 'T-0262', type: 'request',
    readFile: reader({ kind: 'data-fix', kindsJson: KINDS }),
  });
  assert.strictEqual(r.allowed, false, 'el registro real puede ser lista u objeto; ambos son legibles');
});
