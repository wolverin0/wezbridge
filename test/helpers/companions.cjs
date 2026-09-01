'use strict';
/**
 * companions.cjs — T30: la suite tiene que correr en un checkout AISLADO.
 *
 * MEDIDO por el primer CHANGE real de Eve (JOB-90a5db8f, 2026-08-31): en un
 * clone limpio `npm test` daba 970/53 porque ~13 archivos de test requieren
 * `../_docs-curation/*` y validan `../_intel/*` — companions que viven FUERA
 * del repo, en el arbol de Py Apps. Eve se nego (bien) a publicar el draft PR.
 *
 * La decision de diseno (opcion c de TRACKS T30): esos tests validan el PLANO
 * DE CONTROL VIVO de esta maquina. En un checkout sin companions no hay que
 * fingirlos verdes ni dejarlos explotar en require(): se DECLARAN, con un
 * skip que nombra que falta y por que. Un skip ruidoso es un contrato; un
 * require roto es ruido; un verde fingido es el instrumento mentiroso de
 * siempre.
 *
 * Uso, PRIMERA linea de cada archivo que dependa de companions:
 *
 *   const { guardCompanions } = require('./helpers/companions.cjs');
 *   if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;
 *
 * (el `return` de nivel superior es valido en CommonJS y corta el archivo
 * antes de cualquier require que explotaria)
 */
const fs = require('node:fs');
const path = require('node:path');

/** Raiz donde viven los companions: <...>/Py Apps. Sobreescribible por env. */
function companionsRoot() {
  return process.env.WEZBRIDGE_COMPANIONS_DIR
    || path.join(__dirname, '..', '..', '..');
}

function missingCompanions(names) {
  const root = companionsRoot();
  return names.filter((n) => !fs.existsSync(path.join(root, n)));
}

/**
 * true  => todos los companions existen, el archivo sigue normal.
 * false => falta alguno; se registra UN test SKIPPED con la razon completa
 *          (visible en el reporte y en los conteos) y el llamador debe cortar.
 */
function guardCompanions(mod, names) {
  const miss = missingCompanions(names);
  if (miss.length === 0) return true;
  const file = path.basename((mod && mod.filename) || 'test-file');
  const { test } = require('node:test');
  test(`REQUIRES_COMPANIONS [${file}]: falta ${miss.join(', ')}`, {
    skip: `checkout aislado sin ${miss.join(', ')} (raiz: ${companionsRoot()}) — `
      + 'este archivo valida el plano de control vivo de la maquina del operador; '
      + 'en aislamiento se declara la dependencia en vez de fingir verde o explotar en require()',
  }, () => {});
  return false;
}

module.exports = { guardCompanions, missingCompanions, companionsRoot };
