'use strict';
/**
 * T-0485 — la decision del operador escrita por `scripts/decidir.cjs` tiene que
 * LLEGAR al guard de deploy.
 *
 * El agujero: `decidir.cjs` armaba `--source orchestrator-pane`, y `isOperatorRuling`
 * (src/rulings.cjs) solo acepta `board-app | telegram | ledger-cli`. Resultado medido
 * el 19/09: las 20 lineas `approved` del ledger eran 20/20 invisibles para
 * `require-operator-ruling.cjs`, incluida la del propio T-0452. El comentario de
 * rulings.cjs:145-149 ya decia que `ledger-cli` esta en la lista PRECISAMENTE porque
 * es "como scripts/decidir.cjs registra una orden que el operador dio TEXTUALMENTE
 * en un pane" — la lista estaba bien, el emisor escribia otra cosa.
 *
 * Este test fija el CONTRATO ENTRE LAS DOS PIEZAS, no la palabra de ninguna: arma la
 * linea con el emisor real (`buildDecideArgs`) y se la da al aceptador real
 * (`isOperatorRuling`). Si manana cambia el nombre del canal, el test sigue valiendo
 * mientras las dos puntas coincidan.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDecideArgs } = require('../scripts/decidir.cjs');
const { isOperatorRuling, OPERATOR_SOURCES } = require('../src/rulings.cjs');

/**
 * Traduce los args de `ledger decide` a la linea de ruling que el ledger escribe.
 * Se lee de los args REALES: si decidir deja de mandar --source, `source` queda
 * undefined y el test falla, que es lo correcto.
 */
function rulingLineFromArgs(args) {
  const line = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--source') line.source = args[i + 1];
    if (args[i] === '--by') line.by = args[i + 1];
    if (args[i] === '--ruling') line.ruling = args[i + 1];
  }
  line.task = args[1];
  return line;
}

test('AC1 — la linea que produce decidir.cjs la acepta isOperatorRuling (el cable llega al guard)', () => {
  const { args } = buildDecideArgs({
    task: 'T-0801',
    verdict: 'aprobar',
    why: 'si, reinicialo ahora',
    card: { id: 'T-0801', corr: 'wabot-restart-20260902' },
  });
  const line = rulingLineFromArgs(args);

  assert.ok(
    OPERATOR_SOURCES.includes(line.source),
    `decidir.cjs emitio source=${JSON.stringify(line.source)}, que no esta en OPERATOR_SOURCES `
    + `(${OPERATOR_SOURCES.join(', ')}). El guard de deploy descarta esa linea y la decision `
    + 'del operador se pierde en silencio.',
  );
  assert.equal(
    isOperatorRuling(line), true,
    'una orden que el operador dio textualmente y decidir.cjs registro TIENE que valer como decision del operador',
  );
});

test('AC1 bis — los tres veredictos viajan por el mismo canal', () => {
  const casos = [
    ['aprobar', 'dale, hacelo'],
    ['cancelar', 'olvidate de eso'],
  ];
  for (const [verdict, why] of casos) {
    const { args } = buildDecideArgs({ task: 'T-0303', verdict, why });
    assert.equal(isOperatorRuling(rulingLineFromArgs(args)), true, `el veredicto ${verdict} no llega al guard`);
  }
  const d = buildDecideArgs({ task: 'T-0312', verdict: 'diferir', why: 'despues del deploy', until: '2026-09-03T14:00:00Z' });
  assert.equal(isOperatorRuling(rulingLineFromArgs(d.args)), true, 'el veredicto diferir no llega al guard');
});

test('AC2 — no-regresion T-0403: una linea a mano con source=orchestrator-pane y by=operator NO es del operador', () => {
  // El agujero que T-0403 cerro el 06/09: `by` era la palabra, y cualquier pane que
  // escribiera by:'operator' se auto-otorgaba la autoridad. De 30 lineas con by=operator,
  // 20 eran panes. La procedencia la da el CANAL, no la palabra.
  //
  // Este criterio existe para que el atajo falle a proposito: si alguien "arregla" T-0485
  // agregando orchestrator-pane a OPERATOR_SOURCES en vez de cambiar el emisor, esto se pone rojo.
  assert.equal(
    isOperatorRuling({ task: 'T-0801', ruling: 'approved', source: 'orchestrator-pane', by: 'operator' }),
    false,
    'orchestrator-pane NO puede valer como operador: reabre el agujero de T-0403',
  );
  assert.equal(
    OPERATOR_SOURCES.includes('orchestrator-pane'), false,
    'orchestrator-pane no debe estar en OPERATOR_SOURCES',
  );
  // `drill` tampoco: mismo motivo, es un pane.
  assert.equal(isOperatorRuling({ source: 'drill', by: 'operator' }), false, 'drill tampoco es el operador');
  // Control positivo: el detector SI puede dar true, asi que los false de arriba son reales.
  assert.equal(isOperatorRuling({ source: 'board-app' }), true, 'control positivo: board-app si es del operador');
});
