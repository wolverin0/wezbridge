'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0269 — el ledger PIERDE el gate de operador que él mismo decide.
 *
 * EL DEFECTO. `_docs-curation/ledger.cjs :: create()` tiene dos ramas que
 * deciden que una tarjeta nace bloqueada esperando al operador:
 *   · GRAPH CONTRACT: el repo declara el kind con `gate: operator` → persiste
 *     `contract`, y `contract.gate` queda legible.
 *   · FLEET MINIMUM: el repo NO declara el kind, y `_intel/kinds.json` le pone
 *     `fallback_gate: operator` → escribe la decisión en `blocker` (prosa) y en
 *     `blocked_by`, persiste `contract: null`, y NUNCA escribe un campo `gate`.
 *
 * O sea: por la segunda rama, el gate que el propio ledger acaba de decidir
 * sobrevive únicamente como texto en `blocker`. Es un silent-dropper sobre la
 * cosa que menos puede perderse — la autoridad del operador.
 *
 * EFECTO MEDIDO (orquestador, 2026-08-25 al rular T-0230): los tres consumidores
 * del gate leen un campo, no la prosa, así que la tarjeta cae en
 * `blocked-not-gated` (deadline 48h) en vez de `awaiting-operator` (deadline
 * Infinity, severidad 0, la ÚNICA categoría que hace salir el gate con exit 1).
 * Doble daño, el mismo que se documentó el 2026-08-14 para T-0072: molesta cada
 * 48h por un estado que es CORRECTO, y a la vez la deja fuera de la lista que el
 * operador realmente lee. T-0178 (163h), T-0179 (101h) y T-0230 (50h) estaban
 * las tres mal clasificadas.
 *
 * POR QUÉ ESTE TEST VIVE ACÁ Y NO EN `_docs-curation/test/`: ese directorio no
 * tiene package.json ni runner — sus 92 tests no los ejecuta ningún proceso
 * (verificado: no hay script, hook ni CI que los invoque). `wezbridge/package.json`
 * corre `node --test test/*.test.cjs`, y alcanzar el ledger desde acá ya es el
 * patrón establecido: ledger-evidence-wipe.test.cjs:21, ledger-kind-vocabulary.test.cjs:23,
 * clawtrol-bridge.test.cjs:24.
 *
 * LOS PREDICADOS NO SE COPIAN. `src/decision-push.cjs:14-16` dice literalmente
 * "Do not write a third one here" sobre el par `contract.gate` / `gate`. Este
 * test importa `gateOf` de `scripts/fleet-board.cjs` y clasifica con el
 * `classify` real del steward, en vez de reimplementar la regla — un test que
 * copia el predicado que está probando valida su propia copia, no el sistema.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER_SRC = require.resolve('../../_docs-curation/ledger.cjs');
const TURN_SRC = require.resolve('../scripts/orchestrator-turn.cjs');
const REAL_KINDS = path.join(__dirname, '..', '..', '_intel', 'kinds.json');

const { gateOf } = require('../scripts/fleet-board.cjs');
const steward = require('../scripts/fleet-steward.cjs');
const { detectNewDecisions } = require('../src/decision-push.cjs');

/**
 * Ledger descartable con el vocabulario REAL de kinds — nunca las tarjetas
 * reales. El kinds.json se copia de verdad porque la rama bajo prueba es
 * justamente la que consulta `fallback_gate`: con un vocabulario inventado el
 * test probaría otra cosa.
 */
function sandbox(fn) {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-fmgate-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(tmp, 'kinds.json'));
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  delete require.cache[LEDGER_SRC];
  delete require.cache[TURN_SRC];
  try {
    return fn({ intel: tmp, ledger: require(LEDGER_SRC), turn: require(TURN_SRC) });
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = prev;
    delete require.cache[LEDGER_SRC];
    delete require.cache[TURN_SRC];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Releer del DISCO, no confiar en el objeto devuelto: lo que importa es lo que persiste. */
const onDisk = (intel, id) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8'));

/** Envejecer una tarjeta más allá de los dos umbrales (48h idle / 24h operador). */
function age(intel, id, hoursAgo) {
  const f = path.join(intel, 'tasks', `${id}.json`);
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  const stamp = new Date(Date.now() - hoursAgo * 3600000).toISOString();
  t.created_at = stamp; t.updated_at = stamp; t.state_changed_at = stamp;
  fs.writeFileSync(f, JSON.stringify(t, null, 2));
  return t;
}

// `infra-migration` es el caso canónico: kinds.json le pone fallback_gate=operator
// y el graph.json de wezbridge NO lo declara, así que contractFor() devuelve null
// y la creación cae exactamente en la rama de FLEET MINIMUM.
const GATED_KIND = 'infra-migration';

test('la rama de FLEET MINIMUM persiste un gate LEGIBLE, no sólo prosa en blocker', () => {
  sandbox(({ intel, ledger }) => {
    const made = ledger.create({
      title: 'mover el NAS viejo', goal: 'retirar el host', kind: GATED_KIND, repo: 'wezbridge', criteria: 'algo medible',
    });
    const card = onDisk(intel, made.id);

    // Lo que el ledger YA hace bien, y que este test no debe romper:
    assert.equal(card.state, 'blocked', 'la rama de fleet minimum decide bloquear');
    assert.equal(card.blocked_by, 'operator');
    assert.match(card.blocker, /fleet minimum/);

    // Lo que pierde: el gate como CAMPO. `gateOf` es el predicado real que usan
    // el board y decision-push; si devuelve null, la decisión quedó en prosa.
    assert.equal(gateOf(card), 'operator',
      'el ledger decidió "operator gate (fleet minimum)" y lo escribió sólo en blocker: '
      + 'ningún consumidor lee prosa, así que la autoridad del operador se perdió al nacer');
  });
});

test('el steward la clasifica awaiting-operator, NO blocked-not-gated', () => {
  sandbox(({ intel, ledger }) => {
    const made = ledger.create({
      title: 'mover el NAS viejo', goal: 'retirar el host', kind: GATED_KIND, repo: 'wezbridge', criteria: 'algo medible',
    });
    age(intel, made.id, 200);
    const found = steward.classify(onDisk(intel, made.id), Date.now(), intel);

    assert.ok(found, 'una tarjeta bloqueada hace 200h tiene que producir algún hallazgo');
    assert.equal(found.category, 'awaiting-operator',
      `quedó en "${found.category}": deadline 48h sobre un estado que es CORRECTO, y encima fuera `
      + 'de la única categoría que hace exit 1 = "el operador debe algo"');
  });
});

test('el board y decision-push la ven como decisión del operador', () => {
  sandbox(({ intel, ledger }) => {
    const made = ledger.create({
      title: 'abrir un puerto al exterior', goal: 'exponer el panel', kind: 'infra-exposure', repo: 'wezbridge', criteria: 'algo medible',
    });
    const card = onDisk(intel, made.id);
    const { toNotify } = detectNewDecisions([card], {}, Date.now());
    assert.deepEqual(toNotify.map((t) => t.id), [made.id],
      'decision-push filtra por gateOf(): sin gate legible la pregunta nunca se le empuja al operador');
  });
});

test('la rama de GRAPH CONTRACT sigue intacta — el arreglo no puede pisarla', () => {
  sandbox(({ intel, ledger }) => {
    // `deploy` SÍ está declarado en wezbridge/.agent-workflow/graph.json con gate operator.
    const made = ledger.create({ title: 'desplegar', goal: 'subir a prod', kind: 'deploy', repo: 'wezbridge' });
    const card = onDisk(intel, made.id);
    assert.ok(card.contract, 'la rama de graph contract tiene que seguir persistiendo el contrato entero');
    assert.equal(card.contract.gate, 'operator');
    assert.equal(gateOf(card), 'operator');
    // El contrato del graph es el DECLARADO por el repo (mode/_note/evaluator reales),
    // no un stub. Es el argumento contra poblar `contract` en la rama de fleet
    // minimum: ahi no hay contrato que declarar, y fabricar uno mentiria sobre
    // mode y allowed_paths — que es justo lo que ledger-audit.cjs:124 asume
    // cuando dice "a null contract carries no mode and no allowed_paths".
    assert.equal(card.contract.mode, 'none', 'el modo tiene que venir del graph del repo');
    assert.match(card.contract._note, /daemon binds 127\.0\.0\.1/);
    assert.equal(card.contract.evaluator, 'node --test test/*.test.cjs', 'heredado de graph.defaults');
  });
});

test('un kind SIN gate no gana uno: el guard no puede disparar sobre lo correcto', () => {
  sandbox(({ intel, ledger }) => {
    const made = ledger.create({
      title: 'arreglar un watcher', goal: 'que ande', kind: 'tooling-fix', repo: 'wezbridge', criteria: 'algo medible',
      'blocked-by': 'agent',
    });
    const card = onDisk(intel, made.id);
    assert.equal(gateOf(card), null, 'tooling-fix es ungated por contrato: inventarle un gate rompe la flota entera');
    assert.equal(card.state, 'queued');
    assert.notEqual(card.blocked_by, 'operator');
  });
});

test('gate y blocked_by siguen siendo campos DISTINTOS (criterio 4 de la tarjeta)', () => {
  sandbox(({ intel, ledger }) => {
    // gate = "esta clase de trabajo requiere al operador POR CONTRATO"
    // blocked_by = "qué espera HOY". Mezclarlos rompe la cuenta de espera-al-operador.
    const made = ledger.create({
      title: 'rotar una credencial', goal: 'cambiar la clave', kind: 'credential-change', repo: 'wezbridge', criteria: 'algo medible',
    });
    const card = onDisk(intel, made.id);
    assert.equal(gateOf(card), 'operator');
    assert.equal(card.blocked_by, 'operator');

    // Y un tercero prueba que no son el mismo campo con dos nombres: una tarjeta
    // puede esperar a un AGENTE y aun así ser de una clase gateada.
    const t = onDisk(intel, made.id);
    t.blocked_by = 'agent';
    fs.writeFileSync(path.join(intel, 'tasks', `${made.id}.json`), JSON.stringify(t, null, 2));
    assert.equal(gateOf(onDisk(intel, made.id)), 'operator',
      'el gate es del CONTRATO y no puede moverse porque hoy la tarjeta espere a otro');
  });
});

test('REGRESIÓN 25129f4: la alarma de stall volvió a caer en blocked-not-gated', () => {
  // Encontrado midiendo, no suponiendo. Antes de 25129f4 `raiseStall` escribía
  // `gate: 'operator'` — un campo fuera del esquema del ledger, pero que el
  // steward (fleet-steward.cjs:345) y el board (fleet-board.cjs:53) SÍ leen.
  // Al mandar la alarma por `ledger.create()` (que es lo correcto, y lo que la
  // hizo visible) el campo dejó de escribirse, así que la alarma de último
  // recurso quedó con deadline de 48h y fuera de la lista del operador.
  // El arreglo de T-0269 la cubre: es la MISMA pérdida de gate.
  sandbox(({ intel, turn }) => {
    const card = turn.raiseStall(3, ['gate RED']);
    assert.ok(card, 'la alarma tiene que llegar a escribirse');
    age(intel, card.id, 200);
    const found = steward.classify(onDisk(intel, card.id), Date.now(), intel);
    assert.equal(found && found.category, 'awaiting-operator',
      `la alarma de stall quedó en "${found && found.category}": la tarjeta que denuncia que la `
      + 'orquestación no funciona está ella misma fuera de la lista que el operador lee');
  });
});

test('el gate se deriva del KIND aunque la tarjeta nazca declarada en blocked', () => {
  // El guard `!['blocked','cancelled'].includes(state)` existe para no pisar el
  // estado de algo que ya nace bloqueado, y arrastraba al gate con él: una
  // tarjeta creada explícitamente en `blocked` salía con `gate: null` aunque su
  // kind fuera operator-gated. Medido con la alarma de loop muerto, que nace
  // `blocked` a propósito y por eso quedaba invisible dos veces.
  //
  // Nada cubría esta propiedad, así que la fijo acá: el gate responde al KIND,
  // el estado responde a otra cosa, y volver a acoplarlos tiene que ponerse rojo.
  sandbox(({ intel, ledger }) => {
    const made = ledger.create({
      title: 'nace bloqueada a propósito', goal: 'y', kind: GATED_KIND, repo: 'wezbridge', criteria: 'algo medible',
      state: 'blocked', 'blocked-by': 'operator',
    });
    const card = onDisk(intel, made.id);
    assert.equal(gateOf(card), 'operator',
      'declarar el estado en la llamada apagó el gate: el gate es del KIND y no puede depender '
      + 'de con qué estado nace la tarjeta');
    assert.equal(steward.classify(age(intel, made.id, 200), Date.now(), intel).category, 'awaiting-operator');
  });
});

test('la alarma de stall completa: escrita, visible, y en la lista del operador', () => {
  // Cierre de las dos mitades. T-0290 la hizo VISIBLE (id T-NNNN gobernable);
  // T-0269 la pone en la lista que el operador realmente lee. Una alarma visible
  // pero mal clasificada sigue sin llegar: caía en blocked-not-gated, con
  // deadline de 48h sobre un estado que es correcto.
  sandbox(({ intel, ledger, turn }) => {
    const card = turn.raiseStall(3, ['gate RED']);
    assert.match(card.id, /^T-\d{4}$/, 'T-0290: id gobernable por el ledger');
    assert.ok(ledger.allTasks().some((t) => t.id === card.id), 'T-0290: visible para allTasks()');
    assert.equal(card.kind, 'question', 'una pregunta al operador se declara como tal');
    assert.equal(gateOf(onDisk(intel, card.id)), 'operator', 'T-0269: el gate quedó legible');

    const aged = age(intel, card.id, 200);
    assert.equal(steward.classify(aged, Date.now(), intel).category, 'awaiting-operator');
    assert.equal(detectNewDecisions([aged], {}, Date.now()).toNotify.length, 1,
      'y se le empuja al operador, que es el único punto de toda la alarma');
  });
});
