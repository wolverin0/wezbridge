'use strict';
/**
 * rulings.cjs — UN solo criterio de "cual ruling es el mas reciente".
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

module.exports = { rulingsFor, latestRuling, latestRulingWhere, taskIds };
