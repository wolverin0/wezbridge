'use strict';
/**
 * T-0290 — la alarma de último recurso tiene que llegar al tablero.
 *
 * QUÉ PASÓ. `raiseStall()` escribía `_intel/tasks/T-LOOP-STALL.json` con un
 * `fs.writeFileSync` directo. `allTasks()` en `_docs-curation/ledger.cjs` filtra
 * `/^T-\d{4}\.json$/`, así que ese archivo NUNCA entraba: ni en `list`, ni en
 * `dashboard`, ni en nada que se derive de ellos. El archivo existe en disco
 * desde el 2026-08-25, o sea que la alarma YA se disparó en producción y no la
 * vio nadie. El detector de "nada está sano" era el que se veía sano.
 *
 * QUÉ PRUEBA ESTE ARCHIVO. Tres cosas, en este orden:
 *  1. la tarjeta que escribe `raiseStall` es legible por los TRES caminos del
 *     ledger (allTasks / list --state open / dashboard);
 *  2. re-levantar el stall ACTUALIZA la misma tarjeta en vez de crear otra
 *     (idempotencia por `origin_key`, no por un id inventado);
 *  3. por qué el id tiene que ser `T-NNNN` y no un slug: `nextId()` hace
 *     `parseInt(id.slice(2))` sobre todo lo que devuelve `allTasks()`, así que
 *     ensanchar el regex para dejar entrar `T-LOOP-STALL` envenena el
 *     asignador de ids con NaN. La elección se justifica por consecuencia
 *     medida, no por gusto.
 *
 * AISLAMIENTO: todo corre contra un `_intel` en tmp vía `WEZBRIDGE_INTEL_DIR`
 * (mismo patrón que `intel-dir-isolation.test.cjs`). Un test que escriba en el
 * plano de control vivo es peor que no tener test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TURN_SRC = require.resolve('../scripts/orchestrator-turn.cjs');
const LEDGER_SRC = require.resolve('../../_docs-curation/ledger.cjs');

/**
 * Ambos módulos resuelven su `_intel` UNA vez, al requerirse. Para apuntarlos a
 * un directorio de prueba hay que setear el env y recargarlos limpios.
 */
function withTempIntel(fn) {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-stall-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  // El sandbox lleva el kinds.json REAL. Sin él, `fleetMinimumGate()` devuelve
  // null para todo, ninguna rama de gate de create() corre, y la alarma nace
  // `queued` en vez de `blocked` — o sea que el test mediría comportamiento
  // derivado del gate en un entorno donde el vocabulario de gates no existe, y
  // el verde no probaría nada sobre el sistema real. Mismo patrón que
  // ledger-kind-vocabulary.test.cjs:30, que copia el vocabulario de verdad.
  fs.copyFileSync(path.join(__dirname, '..', '..', '_intel', 'kinds.json'),
    path.join(tmp, 'kinds.json'));
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  delete require.cache[TURN_SRC];
  delete require.cache[LEDGER_SRC];
  try {
    return fn({
      intel: tmp,
      turn: require(TURN_SRC),
      ledger: require(LEDGER_SRC),
    });
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = prev;
    delete require.cache[TURN_SRC];
    delete require.cache[LEDGER_SRC];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** La tarjeta de stall, mirada desde el ledger y no desde el disco crudo. */
const STALL_ORIGIN = 'orchestrator:loop-stall';
const isStall = (t) => typeof t.origin_key === 'string' && t.origin_key.startsWith(`${STALL_ORIGIN}:`);
const stallCard = (tasks) => tasks.find(isStall);

test('la alarma de stall es visible por allTasks() — el camino del que cuelgan todos los demás', () => {
  withTempIntel(({ turn, ledger }) => {
    turn.raiseStall(3, ['gate RED (steward-gate exit 1)']);
    const found = stallCard(ledger.allTasks());
    assert.ok(found,
      'raiseStall escribió una tarjeta que allTasks() no ve: la alarma de último recurso '
      + 'no llega al tablero, que es exactamente el defecto T-0290');
    assert.match(found.id, /^T-\d{4}$/, 'la tarjeta tiene que llevar un id gobernable por el ledger');
  });
});

test('la alarma de stall sale en `list --state open` y en el dashboard', () => {
  withTempIntel(({ intel, turn, ledger }) => {
    turn.raiseStall(4, ['gate RED', '2 tareas en review sin juzgar']);

    const open = ledger.list({ state: 'open' });
    assert.ok(stallCard(open), 'la alarma no aparece entre las tareas abiertas');

    ledger.dashboard();
    const md = fs.readFileSync(path.join(intel, 'dashboard.md'), 'utf8');
    const id = stallCard(ledger.allTasks()).id;
    assert.match(md, new RegExp(`\\*\\*${id}\\*\\*`),
      'la alarma no figura en dashboard.md, que es lo que lee un orquestador fresco al arrancar');
    assert.match(md, /## Blocked \(/);
  });
});

test('la alarma nace bloqueada por el operador, que es quien tiene que decidir', () => {
  withTempIntel(({ turn, ledger }) => {
    turn.raiseStall(3, ['gate RED']);
    const card = stallCard(ledger.allTasks());
    assert.equal(card.state, 'blocked');
    assert.equal(card.blocked_by, 'operator',
      'sin blocked_by la tarjeta queda fuera de la única cuenta que mide si la orquestación funciona');
    assert.match(card.blocker, /3 consecutive turns|3 turnos/);
  });
});

test('levantar el stall dos veces actualiza la MISMA tarjeta, no crea una segunda', () => {
  withTempIntel(({ turn, ledger }) => {
    turn.raiseStall(3, ['gate RED']);
    const first = stallCard(ledger.allTasks());
    turn.raiseStall(5, ['gate RED', 'otra razón']);
    const cards = ledger.allTasks().filter(isStall);
    assert.equal(cards.length, 1, 'cada stall creó una tarjeta nueva: el tablero se llena de duplicados');
    assert.equal(cards[0].id, first.id);
    assert.match(cards[0].blocker, /5 /, 'la re-alarma tiene que traer el conteo nuevo');
  });
});

test('una tarjeta cerrada NO se reabre en silencio: un stall nuevo levanta una tarjeta nueva', () => {
  withTempIntel(({ turn, ledger }) => {
    turn.raiseStall(3, ['gate RED']);
    const first = stallCard(ledger.allTasks());
    ledger.update(first.id, { state: 'cancelled', evidence: 'el operador decidió que la premisa venció' });

    turn.raiseStall(3, ['gate RED de nuevo']);
    const open = ledger.list({ state: 'open' }).filter(isStall);
    assert.equal(open.length, 1,
      'después de cerrar la alarma, un stall nuevo tiene que volver a ser visible — si no, la alarma se '
      + 'gasta una sola vez y el resto del tiempo el loop se estanca en silencio');
    assert.notEqual(open[0].id, first.id);
  });
});

test('POR QUÉ el id es T-NNNN: ensanchar el regex de allTasks() envenena nextId()', () => {
  // Esta es la consecuencia medida de la opción descartada. Si `allTasks()`
  // dejara entrar `T-LOOP-STALL.json`, `nextId()` haría
  // `parseInt('LOOP-STALL', 10)` -> NaN, `Math.max(..., NaN)` -> NaN, y la
  // próxima tarjeta de TODA la flota se llamaría `T-NaN`. El costo de un
  // segundo formato de id no es cosmético: rompe el asignador.
  withTempIntel(({ intel, ledger }) => {
    ledger.create({ title: 'a', goal: 'b', 'blocked-by': 'agent', repo: 'wezbridge' });
    const rogue = { id: 'T-LOOP-STALL', title: 'x', goal: 'y', kind: 'general', state: 'blocked', blocked_by: 'operator' };
    fs.writeFileSync(path.join(intel, 'tasks', 'T-LOOP-STALL.json'), JSON.stringify(rogue));

    const ids = ledger.allTasks().map((t) => t.id);
    assert.ok(!ids.includes('T-LOOP-STALL'),
      'allTasks() dejó entrar un id no numérico; nextId() hace parseInt sobre esto y devolvería T-NaN');
    const nums = ids.map((t) => parseInt(t.slice(2), 10));
    assert.ok(nums.every(Number.isFinite), `nextId() se rompería con estos ids: ${ids.join(', ')}`);
  });
});

// --- los dos cargadores sobre el mismo directorio --------------------------
//
// `ledger.allTasks()` (estricto, `/^T-\d{4}\.json$/`) y
// `fleet-steward.loadTasks()` (laxo, `endsWith('.json')`) leen los dos
// `_intel/tasks/`. DIFIEREN A PROPOSITO y en la direccion segura:
//   - el ledger no puede ensancharse: `nextId()` hace `parseInt(id.slice(2))`
//     sobre lo que devuelve `allTasks()`, asi que un id no numerico le mintea
//     `T-NaN` a toda la flota;
//   - el steward no puede angostarse: es la alarma, y una alarma que recorta su
//     propia entrada falla en VERDE justo sobre los archivos que nadie mas ve.
// El defecto T-0290 nunca fue "dos criterios": fue que la diferencia era MUDA.
// Estos dos tests fijan el contrato real — el steward ve un superconjunto, y
// todo lo que sobra se NOMBRA.

test('la vista del steward es un superconjunto de la del ledger, nunca un conjunto distinto', () => {
  withTempIntel(({ intel, ledger }) => {
    ledger.create({ title: 'a', goal: 'b', 'blocked-by': 'agent', repo: 'wezbridge' });
    ledger.create({ title: 'c', goal: 'd', 'blocked-by': 'agent', repo: 'wezbridge' });
    fs.writeFileSync(path.join(intel, 'tasks', 'T-LOOP-STALL.json'),
      JSON.stringify({ id: 'T-LOOP-STALL', title: 'x', goal: 'y', state: 'blocked', blocked_by: 'operator' }));

    const steward = require('../scripts/fleet-steward.cjs');
    const fromLedger = ledger.allTasks().map((t) => t.id);
    const fromSteward = steward.loadTasks().map((t) => t.id);
    for (const id of fromLedger) {
      assert.ok(fromSteward.includes(id),
        `el steward no ve ${id}, que el ledger si: la alarma quedo mas ciega que el tablero`);
    }
    assert.ok(fromSteward.includes('T-LOOP-STALL'),
      'el steward tiene que seguir viendo lo que el ledger no gobierna — si no, un archivo huerfano '
      + 'deja el gate en VERDE, que es la unica direccion en la que no puede fallar');
  });
});

test('la diferencia entre los dos cargadores se NOMBRA: nada se descarta en silencio', () => {
  withTempIntel(({ intel, ledger }) => {
    ledger.create({ title: 'a', goal: 'b', 'blocked-by': 'agent', repo: 'wezbridge' });
    fs.writeFileSync(path.join(intel, 'tasks', 'T-LOOP-STALL.json'), JSON.stringify({ id: 'T-LOOP-STALL' }));

    const steward = require('../scripts/fleet-steward.cjs');
    const fromLedger = new Set(ledger.allTasks().map((t) => t.id));
    const gap = steward.loadTasks().map((t) => t.id).filter((id) => !fromLedger.has(id));
    const named = steward.auditTaskFiles(intel).map((f) => f.id);
    assert.deepEqual(named.sort(), gap.sort(),
      'todo archivo que el ledger no gobierna tiene que salir como hallazgo; la brecha muda ES el defecto T-0290');
    assert.equal(steward.auditTaskFiles(intel)[0].category, 'ungoverned-task-file');
    assert.match(steward.auditTaskFiles(intel)[0].why, /ledger cannot list, update, lease or rule on it/);

    // y el hallazgo tiene que llegar al REPORTE, no quedarse en la funcion
    const report = steward.audit(steward.loadTasks(), Date.now(), intel);
    assert.ok(report.findings.some((f) => f.category === 'ungoverned-task-file'),
      'auditTaskFiles esta desconectado de audit(): el hallazgo existe y no lo lee nadie');
    assert.equal(report.byCategory['ungoverned-task-file'], 1);

    // y sin archivos huerfanos no inventa ruido
    fs.unlinkSync(path.join(intel, 'tasks', 'T-LOOP-STALL.json'));
    assert.deepEqual(steward.auditTaskFiles(intel), [],
      'un guard que dispara sobre comportamiento correcto es peor que no tenerlo');
  });
});
