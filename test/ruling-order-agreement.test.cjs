'use strict';
/**
 * T-0294 — tres interpretes de "el ruling mas reciente" sobre el MISMO archivo.
 *
 *   steward-gate.cjs:137      [...applicable].reverse().find(...)  -> ORDEN DE ARCHIVO
 *   orchestrator-turn.cjs:210 [...applicable].reverse().find(...)  -> ORDEN DE ARCHIVO
 *   dispatch-lint.cjs:91      at >= prev.at_ms                     -> ORDEN DE TIMESTAMP
 *
 * EL CASO DE ESTE ARCHIVO ES FABRICADO, Y LO DECLARO. Contra los rulings reales
 * los tres coinciden hoy: lo medi antes de escribir una linea —248 lineas, 127
 * tareas, 55 con mas de un ruling— y da CERO tareas donde el ganador difiera,
 * cero inversiones por tarea y una sola inversion global. O sea que un
 * fail-first sobre datos reales no existiria. Construir el caso es legitimo
 * porque el defecto es LATENTE y la tarjeta existe antes de que cueste, pero un
 * rojo fabricado prueba MENOS que uno sobre datos reales y confundirlos seria la
 * trampa. Esto demuestra que los criterios PUEDEN divergir, no que hoy divergen.
 *
 * POR QUE IGUAL VALE ARREGLARLO: el reloj del que depende uno de los tres no es
 * confiable. 103 de 248 valores de `at` (42%) terminan en `:00Z` o `:00.000Z`,
 * o sea tipeados a mano por un agente y no medidos. Y ya hay UNA tarea con dos
 * rulings del MISMO `at`, donde el orden por timestamp esta directamente
 * indefinido y cualquier implementacion cae de vuelta en el orden de archivo.
 *
 * LA ELECCION: ORDEN DE ARCHIVO. `rulings.jsonl` es append-only, asi que el
 * orden del archivo ES el orden real en que se tomaron las decisiones; el
 * timestamp es documentacion que un agente escribe a mano. Ordenar por un reloj
 * que el 42% de las veces esta redondeado a la hora en punto es ordenar por
 * ruido encima del orden verdadero. Ademas 2 de los 3 interpretes ya lo usan,
 * asi que unificar mueve un solo consumidor.
 *
 * OJO CON LA DIFERENCIA QUE NO ES DE ORDEN, y que importa mas: steward-gate y
 * orchestrator-turn buscan "la ultima linea que SATISFACE un predicado"
 * (retroceden hasta encontrar una que aplique), mientras dispatch-lint toma "la
 * ultima linea, y despues la evalua" (si la mas nueva no aplica, las viejas no
 * la rescatan). Son PREGUNTAS distintas, no dos respuestas a la misma, y las dos
 * son legitimas. Lo que no puede haber es dos criterios de ORDEN: eso queda en
 * una sola funcion y las dos preguntas se construyen encima.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluate } = require('../scripts/steward-gate.cjs');
const { lintRulings } = require('../scripts/dispatch-lint.cjs');
const { reviewWakeTargets } = require('../scripts/orchestrator-turn.cjs');

const NOW = Date.parse('2026-08-27T00:00:00Z');

/**
 * Dos rulings por tarea donde el orden de archivo y el de timestamp DISCREPAN:
 * la linea escrita ULTIMA lleva el `at` mas VIEJO. Pasa de verdad — el archivo
 * real ya tiene una inversion global — y es la unica forma de que los dos
 * criterios se puedan distinguir.
 */
function fixture() {
  return [
    // --- T-0001: el caso del gate y del lint -------------------------------
    {
      task: 'T-0001', ruling: 'operator-gated', category: 'idle',
      at: '2026-08-20T12:00:00Z',            // mas NUEVO por reloj
      why: 'el umbral se set to 5 por decision del operador', // value-change SIN archivo
    },
    {
      task: 'T-0001', ruling: 'operator-gated', category: 'idle',
      at: '2026-08-18T12:00:00Z',            // mas VIEJO por reloj, ULTIMO en el archivo
      why: 'revisado y cerrado', value_landed_in: 'docs/decision.md',
    },
    // --- T-0002: el caso del waker -----------------------------------------
    {
      task: 'T-0002', ruling: 'deferred', category: 'review',
      at: '2026-08-20T12:00:00Z',            // mas NUEVO por reloj
      until: '2026-08-21T00:00:00Z',         // ...pero YA VENCIDO a NOW
      why: 'parado hasta manana',
    },
    {
      task: 'T-0002', ruling: 'deferred', category: 'review',
      at: '2026-08-18T12:00:00Z',            // mas VIEJO por reloj, ULTIMO en el archivo
      until: '2026-09-30T00:00:00Z',         // ...y VIGENTE a NOW
      why: 'parado hasta fin de septiembre',
    },
  ];
}

const finding = {
  id: 'T-0001', category: 'idle', age_hours: 500, repo: 'wezbridge', state: 'queued', title: 'x',
};

// --- quien gana, segun cada interprete --------------------------------------

test('el GATE atribuye el ruling escrito último, no el de `at` más nuevo', () => {
  const { covered, unruled } = evaluate({ findings: [finding], rulings: fixture(), now: NOW });
  assert.equal(unruled.length, 0, 'la tarjeta está cubierta por ambos rulings; no puede salir RED');
  assert.equal(covered[0].ruling.why, 'revisado y cerrado',
    'el gate le atribuyó al operador un ruling que NO es el último que se escribió');
});

test('el WAKER lee el ruling escrito último, no el de `at` más nuevo', () => {
  const tasks = [{ id: 'T-0002', state: 'review' }];
  const woke = reviewWakeTargets({ tasks, rulings: fixture(), now: NOW });
  assert.deepEqual(woke, [],
    'el waker despertó por T-0002: leyó el deferral vencido en vez del vigente, que es el último escrito');
});

test('el LINT lee el ruling escrito último, no el de `at` más nuevo', () => {
  // El último escrito nombra un archivo (`value_landed_in`), así que no hay
  // hallazgo. El de `at` más nuevo cambia un valor y no nombra archivo, así que
  // sí lo habría: los dos criterios dan veredictos opuestos sobre el mismo file.
  const out = lintRulings(fixture(), NOW);
  assert.deepEqual(out.map((f) => f.id), [],
    'el lint marcó T-0001 como valor-sin-archivo: está leyendo un ruling que fue REVISADO '
    + 'por una línea posterior');
});

test('LOS TRES eligen la MISMA línea — que es lo único innegociable', () => {
  // No importa tanto cuál criterio gana como que no haya dos. Este test cae si
  // alguno de los tres vuelve a interpretar el orden por su cuenta.
  const rulings = fixture();
  const { covered } = evaluate({ findings: [finding], rulings, now: NOW });
  const gate = covered.length ? covered[0].ruling.at : null;
  const lint = lintRulings(rulings, NOW).length ? '2026-08-20T12:00:00Z' : '2026-08-18T12:00:00Z';
  const waker = reviewWakeTargets({ tasks: [{ id: 'T-0002', state: 'review' }], rulings, now: NOW }).length
    ? '2026-08-20T12:00:00Z' : '2026-08-18T12:00:00Z';

  assert.deepEqual({ gate, lint, waker },
    { gate: '2026-08-18T12:00:00Z', lint: '2026-08-18T12:00:00Z', waker: '2026-08-18T12:00:00Z' },
    'los tres intérpretes no coinciden sobre cuál ruling es el más reciente sobre el MISMO archivo');
});

// --- lo que el criterio unico NO puede cambiar ------------------------------

test('con `at` en orden creciente los tres siguen coincidiendo (el caso normal)', () => {
  // El 100% de las tareas reales está en esta forma. Si el arreglo la tocara,
  // habría cambiado el comportamiento vivo en vez del latente.
  const rulings = [
    { task: 'T-0003', ruling: 'operator-gated', category: 'idle', at: '2026-08-18T12:00:00Z', why: 'primero' },
    { task: 'T-0003', ruling: 'operator-gated', category: 'idle', at: '2026-08-20T12:00:00Z', why: 'segundo y último' },
  ];
  const f = { ...finding, id: 'T-0003' };
  const { covered, unruled } = evaluate({ findings: [f], rulings, now: NOW });
  assert.equal(unruled.length, 0);
  assert.equal(covered[0].ruling.why, 'segundo y último');
});

test('el lint sigue marcando un cambio de valor que NO nombra archivo', () => {
  // El guard no puede volverse un "nunca marca nada": esa es su razón de ser.
  const out = lintRulings([{
    task: 'T-0004', ruling: 'dispatched', at: '2026-08-20T12:00:00Z',
    why: 'el timeout set to 30s',
  }], NOW);
  assert.deepEqual(out.map((f) => f.id), ['RL-unlanded-T-0004']);
});

test('el lint sigue ignorando lo anterior a su época', () => {
  const out = lintRulings([{
    task: 'T-0005', ruling: 'dispatched', at: '2026-01-01T00:00:00Z', why: 'el umbral set to 9',
  }], NOW);
  assert.deepEqual(out, [], 'la época existe para no retro-marcar el backlog previo');
});

// --- el guard que impide que vuelvan a ser tres -----------------------------

test('ningún intérprete re-implementa el criterio de orden por su cuenta', () => {
  // Que los tres COINCIDAN hoy no alcanza: alguien puede volver a escribir su
  // propia versión y que dé igual, hasta el día que no. El criterio se importa
  // o el test cae. Mismo patrón que intel-dir-isolation.test.cjs, que fija una
  // regla sobre el FUENTE y no sobre el resultado.
  const fs = require('node:fs');
  const path = require('node:path');
  const INTERPRETES = [
    'scripts/steward-gate.cjs',
    'scripts/dispatch-lint.cjs',
    'scripts/orchestrator-turn.cjs',
  ];
  // Formas de "elegir el ruling más reciente" escritas a mano. Deliberadamente
  // angostas: un guard que dispara sobre código correcto enseña a esquivarlo.
  const IDIOMAS = [
    /\breverse\(\)\s*\.\s*find\b/,             // [...applicable].reverse().find(...)
    /at\s*>=\s*\w+\.at_ms/,                     // at >= prev.at_ms
    /sort\([^)]*Date\.parse\(\s*\w+\.at\b/,     // sort por timestamp del ruling
  ];
  const culpables = [];
  for (const rel of INTERPRETES) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    if (!/require\(['"][^'"]*rulings\.cjs['"]\)/.test(src)) {
      culpables.push(`${rel}: no importa src/rulings.cjs`);
    }
    for (const re of IDIOMAS) {
      if (re.test(src)) culpables.push(`${rel}: ordena rulings a mano (${re})`);
    }
  }
  assert.deepEqual(culpables, [],
    'volvió a haber más de un criterio de "cuál ruling es el más reciente":\n  ' + culpables.join('\n  '));
});

test('el módulo compartido distingue las DOS preguntas, que no son la misma', () => {
  // `latestRuling` = "la última línea, y después la evalúo" (lo que necesita el
  // lint: un ruling revisado por otro posterior deja de contar).
  // `latestRulingWhere` = "la última que SATISFACE el predicado" (lo que
  // necesitan el gate y el waker: una cobertura vieja sigue valiendo si nada
  // posterior la contradijo). Confundirlas cambiaría el comportamiento de dos
  // consumidores en silencio.
  const { latestRuling, latestRulingWhere } = require('../src/rulings.cjs');
  const rs = [
    { task: 'T-1', ruling: 'operator-gated', at: 'a' },
    { task: 'T-1', ruling: 'dispatched', at: 'b' },
  ];
  const esGated = (r) => r.ruling === 'operator-gated';
  assert.equal(latestRuling(rs, 'T-1').at, 'b', 'la última escrita, sin filtrar');
  assert.equal(latestRulingWhere(rs, 'T-1', esGated).at, 'a',
    'la última que satisface el predicado, aunque haya una posterior que no');
  assert.equal(latestRuling(rs, 'T-9'), null, 'una tarea sin rulings devuelve null, no undefined');
});
