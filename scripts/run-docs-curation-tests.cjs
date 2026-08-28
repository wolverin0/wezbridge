#!/usr/bin/env node
'use strict';
/**
 * run-docs-curation-tests.cjs — corre el suite del ledger (`_docs-curation/test/`)
 * desde adentro del suite de wezbridge.
 *
 * POR QUE EXISTE (T-0291). `_docs-curation` no tiene `package.json` ni script de
 * test: sus 9 archivos no los ejecutaba ningun proceso, incluido el que pinea el
 * gate de evidencia del ledger. Un artefacto que se lee como enforcement y que
 * nadie corre es peor que no tenerlo, porque da cobertura a lo que esta abajo.
 *
 * POR QUE NO UN RUNNER PROPIO ALLA. Medido antes de elegir: en toda la flota
 * NADA ejecuta tests automaticamente — ninguno de los 12 `.cmd` de Task
 * Scheduler, ningun hook, ningun CI. Un `package.json` nuevo en `_docs-curation`
 * seria un runner que nadie invoca: el mismo defecto un nivel mas arriba y con
 * aspecto de resuelto. `node --test test/*.test.cjs` de wezbridge, en cambio, es
 * el `evaluator` declarado en el contrato de TODAS las tarjetas del ledger, o
 * sea que lo corre cada agente en cada tarea. Es la unica forcing function que
 * existe hoy, y esto viaja sobre ella en vez de agregar una segunda que rote.
 *
 * Los archivos no se mudan: siguen al lado del codigo que prueban.
 *
 * CONTEO MEDIDO 2026-08-28: 9 archivos, 92 tests, 91 pass, 0 fail, 1 skip.
 * Re-medilo antes de citarlo; un conteo sin fecha envejece a mentira.
 *
 * Uso directo:  node scripts/run-docs-curation-tests.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Encuentra `_docs-curation/test/` sin asumir la profundidad del checkout: el
 * repo vive en <Py Apps>/wezbridge, en <Py Apps>/_worktrees/<name>, o en
 * <Py Apps>/wezbridge/.claude/worktrees/<name>. Mismo criterio que
 * clawtrol-bridge.test.cjs:22.
 *
 * Devuelve null si no esta. NO tira y NO hace skip: quien llama decide, y la
 * decision correcta es fallar ruidoso — un wrapper que se saltea cuando no
 * encuentra su objetivo es exactamente el defecto que esto viene a cerrar.
 */
function locateSuite(from = __dirname) {
  const candidates = [
    path.join(from, '..', '..', '_docs-curation', 'test'),
    path.join(from, '..', '..', '..', '_docs-curation', 'test'),
    path.join(from, '..', '..', '..', '..', '..', '_docs-curation', 'test'),
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) || null;
}

/**
 * VEREDICTO PURO, separado del I/O para poder probarlo sin filesystem ni hijo
 * — mismo criterio que orchestrator-turn.cjs con sus decisiones.
 *
 * La regla que importa: un hijo que sale 0 SIN haber reportado conteos no es un
 * suite aprobado, es un runner roto. Pasa de verdad — heredando
 * `NODE_TEST_CONTEXT` el hijo responde "skipping running files", sale 0 y no
 * imprime un solo `# tests`. Verde sin haber corrido nada es la forma exacta del
 * defecto que esta tarjeta cierra, asi que se juzga explicito y no por status.
 */
function judge({ error, status, output }) {
  const parsed = /^# tests \d+$/m.test(output || '');
  return {
    ok: !error && status === 0 && parsed && count(output, 'fail') === 0 && count(output, 'tests') > 0,
    parsed,
  };
}

/** `# tests 92` -> 92. Ausente es 0, que despues se juzga como suite roto. */
function count(output, key) {
  const m = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

/**
 * Corre el suite del ledger en un proceso aparte y devuelve sus conteos.
 *
 * El hijo arranca con un entorno LIMPIO a proposito:
 *  · `NODE_OPTIONS` se borra porque `wezbridge/test/setup.cjs` se inyecta ahi y
 *    montaria el mock de wezterm dentro de un suite que no lo pidio. Un test que
 *    corre bajo un stub que no declaro es un test que prueba otra cosa.
 *  · `WEZBRIDGE_INTEL_DIR` se borra para reproducir EXACTAMENTE la condicion en
 *    la que ese suite pasa hoy (corrido a mano, sin la variable): cada uno de
 *    esos tests arma su propio intel temporal y lo pasa por llamada.
 */
function runSuite(dir = locateSuite()) {
  if (!dir) return { dir: null, files: [], tests: 0, pass: 0, fail: 0, skip: 0, ok: false, output: '' };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.cjs')).sort()
    .map((f) => path.join(dir, f));
  if (!files.length) return { dir, files: [], tests: 0, pass: 0, fail: 0, skip: 0, ok: false, output: '' };

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.WEZBRIDGE_INTEL_DIR;
  // `NODE_TEST_CONTEXT` es como el runner de node marca a sus hijos. Heredarla
  // hace que el hijo diga "run() is being called recursively within a test file.
  // skipping running files" y salga con 0 tests y status 0 — o sea VERDE sin
  // haber corrido nada. Medido: exactamente el modo de falla que esta tarjeta
  // existe para terminar, y encima disfrazado de exito.
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];

  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: path.dirname(dir), encoding: 'utf8', timeout: 180000, env,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const fail = count(output, 'fail');
  const { ok } = judge({ error: r.error, status: r.status, output });
  return {
    dir, files, output, ok, fail,
    tests: count(output, 'tests'),
    pass: count(output, 'pass'),
    skip: count(output, 'skipped'),
  };
}

module.exports = { locateSuite, runSuite, judge };

if (require.main === module) {
  const r = runSuite();
  if (!r.dir) {
    console.error('run-docs-curation-tests: no encontre _docs-curation/test/ desde este checkout');
    process.exit(1);
  }
  process.stdout.write(r.output);
  console.log(`\nledger suite: ${r.files.length} archivos · ${r.tests} tests · ${r.pass} pass · ${r.fail} fail · ${r.skip} skip`);
  process.exit(r.ok ? 0 : 1);
}
