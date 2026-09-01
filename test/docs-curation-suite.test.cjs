'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0291 — los 9 tests de `_docs-curation` no los ejecutaba ningun runner.
 *
 * EL DEFECTO EN SU FORMA MAS PURA. `_docs-curation/test/` tiene 9 archivos, uno
 * de ellos `ledger-done-evidence.test.cjs`, que pinea el gate de evidencia del
 * ledger — el que impide cerrar una tarjeta afirmando exito sin prueba. El
 * directorio no tiene `package.json` ni script de test, asi que esos 9 archivos
 * no los corria ningun proceso. Un artefacto que se LEE como enforcement y que
 * nadie ejecuta es peor que no tenerlo: da cobertura a lo que esta abajo.
 *
 * CUANTO COSTO NO CORRERLOS, medido: dos de los nueve archivos
 * (`doc-head.test.cjs`, `ledger-fsm-process.test.cjs`) y `doc-head.cjs` — el
 * modulo que el primero prueba — NUNCA ESTUVIERON EN GIT. Un clon limpio se
 * llevaba 7 de 9. Nadie lo noto porque la diferencia entre "esta trackeado" y
 * "no esta" no se manifestaba en ninguna salida. Los trackeo `c025f0b`.
 *
 * POR QUE LOS ADOPTA ESTA SUITE Y NO UN RUNNER PROPIO EN `_docs-curation`.
 * Medido antes de elegir: en toda la flota NADA ejecuta tests automaticamente —
 * ninguno de los 12 `.cmd` de Task Scheduler, ningun hook, ningun CI. Un
 * `package.json` nuevo alla seria un runner que nadie invoca, o sea el MISMO
 * defecto un nivel mas arriba, y encima con aspecto de resuelto. En cambio
 * `node --test test/*.test.cjs` de wezbridge es el `evaluator` declarado en el
 * contrato de TODAS las tarjetas del ledger, asi que lo corre cada agente en
 * cada tarea: es la unica forcing function real que existe hoy.
 *
 * Los archivos NO se mudan: siguen viviendo al lado del codigo que prueban, que
 * es su lugar correcto. Lo que se agrega es que la suite que si se ejecuta los
 * ejecute a ellos tambien. Un runner mas es una cosa mas que puede dejar de
 * correr sin que nadie se entere; este viaja sobre el que ya es load-bearing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { locateSuite, runSuite, judge } = require('../scripts/run-docs-curation-tests.cjs');

test('los tests del ledger se ejecutan DESDE esta suite, y pasan', () => {
  const dir = locateSuite();
  assert.ok(dir, 'no se encontro _docs-curation/test/ desde este checkout');

  const r = runSuite();
  assert.equal(r.fail, 0,
    `el suite del ledger tiene ${r.fail} falla(s). Corren desde aca justamente para que una `
    + `regresion en ledger.cjs rompa ESTA suite y no quede esperando a que alguien tipee el comando:\n${r.output.slice(-2000)}`);
  assert.ok(r.tests > 0, 'el suite del ledger reporto CERO tests: eso es un runner roto, no un suite vacio');
});

test('CADA archivo de test del ledger corre: ninguno queda afuera en silencio', () => {
  // El conteo es el criterio 2 y 4 de la tarjeta: antes de esto corrian 0 de 9.
  // Que corra "el suite" no alcanza — si un archivo se cae del glob o del repo,
  // el total baja y nada falla. Aca se compara contra el disco.
  const dir = locateSuite();
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')).sort();
  const r = runSuite();

  assert.deepEqual(r.files.map((f) => path.basename(f)).sort(), onDisk,
    'hay archivos de test en _docs-curation/test/ que esta suite no esta ejecutando');
  assert.ok(onDisk.length >= 9,
    `bajaron a ${onDisk.length} los archivos de test del ledger (habia 9): si uno desaparece, `
    + 'el total simplemente baja y nada falla — por eso se compara contra un piso');
});

test('todo archivo de test del ledger esta TRACKEADO EN GIT', () => {
  // El defecto original, y el que no se veia: `doc-head.test.cjs`,
  // `ledger-fsm-process.test.cjs` y `doc-head.cjs` existian en disco y no en el
  // repo, asi que un clon limpio corria 7 de 9 sin que nada lo dijera. Correr
  // los tests desde aca no lo habria detectado —en ESTA maquina los archivos
  // estan— por eso el guard mira git y no el filesystem.
  const dir = locateSuite();
  const repo = path.dirname(dir);
  const tracked = new Set(
    execFileSync('git', ['ls-files', 'test'], { cwd: repo, encoding: 'utf8' })
      .split('\n').filter(Boolean).map((p) => path.basename(p)),
  );
  const untracked = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.cjs') && !tracked.has(f));

  assert.deepEqual(untracked, [],
    `estos tests existen en disco pero NO en git, asi que un clon limpio no los tendria: ${untracked.join(', ')}`);
});

test('si el repo del ledger no esta, esto FALLA — nunca se saltea en silencio', () => {
  // Un wrapper que hace skip cuando no encuentra el objetivo reproduce el
  // defecto exacto de la tarjeta: se lee como cobertura y no ejecuta nada.
  // `locateSuite` con una raiz inventada tiene que devolver null, y el test de
  // arriba convierte ese null en una falla ruidosa.
  // Una raiz de verdad lejos del arbol: `locateSuite` sube hasta 5 niveles, asi
  // que un subdirectorio inventado DE ESTE repo igual encontraria el objetivo.
  assert.equal(locateSuite(require('node:os').tmpdir()), null);
});

test('una falla del ledger LLEGA hasta esta suite: la adopción es real, no decorativa', () => {
  // El punto entero de adoptarlos. Se prueba contra un directorio temporal en vez
  // de romper el repo del ledger a propósito: `runSuite` recibe el dir, así que
  // la propagación se puede verificar sin tocar nada de nadie.
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-suite-prop-'));
  try {
    fs.writeFileSync(path.join(tmp, 'roto.test.cjs'),
      "require('node:test')('una regresión del ledger', () => { require('node:assert').equal(1, 2); });\n");
    const r = runSuite(tmp);
    assert.equal(r.ok, false, 'un test del ledger en rojo tiene que dejar en rojo a esta suite');
    assert.ok(r.fail > 0, `reportó ${r.fail} fallas: si no las propaga, adoptarlos no sirvió de nada`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('un runner que no ejecuta nada NO cuenta como verde', () => {
  // El modo de falla que casi se me cuela, y que ya ocurrio de verdad: heredando
  // `NODE_TEST_CONTEXT` el hijo responde "run() is being called recursively ...
  // skipping running files", sale con status 0 y NO imprime un solo `# tests`.
  // Verde sin haber corrido nada: el defecto de esta tarjeta disfrazado de exito.
  //
  // Se prueba sobre `judge`, el veredicto puro, y no armando un directorio: un
  // dir vacio sale por el early-return y un archivo sin tests igual cuenta como
  // 1 (node cuenta el ARCHIVO). Las dos formas parecian cubrir esta regla y
  // ninguna la tocaba — mutar el veredicto no las ponia en rojo.
  const salteado = '(node:1) Warning: node:test run() is being called recursively within a test file. skipping running files.';
  assert.equal(judge({ error: null, status: 0, output: salteado }).ok, false,
    'un hijo que saltea y sale 0 no puede leerse como suite aprobado');
  assert.equal(judge({ error: null, status: 0, output: salteado }).parsed, false);

  // Y el contrapositivo, para que el guard no sea un "siempre false":
  const real = ['# tests 92', '# pass 91', '# fail 0', '# skipped 1'].join(String.fromCharCode(10));
  assert.equal(judge({ error: null, status: 0, output: real }).ok, true);
  assert.equal(judge({ error: null, status: 1, output: real.replace('# fail 0', '# fail 3') }).ok, false);
  assert.equal(judge({ error: new Error('spawn falló'), status: null, output: real }).ok, false,
    'un runner que ni arrancó tampoco es verde');
});
