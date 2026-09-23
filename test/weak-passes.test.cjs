'use strict';
/**
 * "Terminó sin error" no es "hizo la cosa".
 *
 * Es la falla que más se repitió el 2026-08-24/25 — CINCO instancias en tres
 * panes distintos: la tarea Checkpoint devolviendo 0 sin escribir un backup;
 * una suite en verde mientras vaciaba un perfil; el chequeo de PPR-7 dando PASS
 * mientras contaba 6.752 outcomes sin registrar; un archivo de tests que CI no
 * ejecuta por su marcador; y un revisor reportando "faltan tests" para diez
 * funciones cubiertas, porque contaba definiciones y no invocaciones.
 *
 * La regla que sobrevivió a las cinco: un chequeo verde vale solo si podés
 * NOMBRAR el artefacto que produjo. Esto no bloquea nada — nombra los pass que
 * no citan nada. Un guard que dispara sobre trabajo correcto es peor que
 * ninguno, asi que la mitad importante de estos tests es la de falsos
 * positivos: la evidencia real NO puede marcarse.
 */
const test = require('node:test');
const assert = require('node:assert');
const { weakPasses } = require('../src/a2a-intel.cjs');

test('evidencia REAL de los results de hoy no se marca nunca', () => {
  // Lineas textuales de results reales del 2026-08-25. Si el guard muerde
  // alguna de estas, es el guard el que esta mal, no el pane.
  const body = [
    'criteria:',
    '- backup: pass — 11.278 bytes, gzip OK, 21 CREATE TABLE',
    '- SHA: pass — git rev-parse HEAD = 30075c07 EXACTO, arbol limpio',
    '- disco: pass — 26 GB libres',
    '- migracion 006 + seed: pass — migrate exit=0, seed exit=0',
    '- headers: pass — CSP completa, HSTS, nosniff, X-Frame DENY',
    '- dump previo: pass — 262.372 bytes, gzip OK',
    '- salud/version publica: pass — /traza-v2/versionz devuelve 2026.08.25-2',
    '- evidencia: pass — `_intel/briefs/ultracode-5prs-merged-20260825.md`',
  ].join('\n');
  assert.deepStrictEqual(weakPasses(body), []);
});

test('marca los pass que solo dicen que no fallo', () => {
  const body = [
    'criteria:',
    '- deploy: pass — sin errores',
    '- verificado: pass — todo bien',
    '- limpieza: pass',
    '- tests: pass — 917/920',
  ].join('\n');
  assert.deepStrictEqual(weakPasses(body), ['deploy', 'verificado', 'limpieza']);
});

test('un fail nunca se marca — el guard es sobre pass que no prueban, no sobre malas noticias', () => {
  const body = [
    'criteria:',
    '- crear la alerta: fail — GATE:credential:waiting',
    '- conteo == 48: fail -> pare sin escribir',
  ].join('\n');
  assert.deepStrictEqual(weakPasses(body), []);
});

test('un cuerpo sin criterios no produce ruido', () => {
  for (const body of ['', null, 'ack recibido, sigo', 'todo pass y listo']) {
    assert.deepStrictEqual(weakPasses(body), [], `ruido sobre: ${JSON.stringify(body)}`);
  }
});

test('una ruta, un hash o una URL alcanzan como artefacto', () => {
  const body = [
    '- brief: pass — _intel/briefs/x.md',
    '- commit: pass — b788758',
    '- publico: pass — https://axion-demo.puntofutura.com.ar responde',
    '- codigo: pass — `detectSmuggledEnvelope` exportada',
  ].join('\n');
  assert.deepStrictEqual(weakPasses(body), []);
});

// T-0400: era un chequeo de fuente — matcheaba el string 'UNVERIFIABLE
// PASSES', la llamada `weakPasses(body)`, y que un slice de 800 chars
// alrededor no contuviera `isError: true`. Un `if (false)` alrededor del
// bloque que arma esa nota deja las tres literales en su lugar (el `if`
// sigue en el archivo), asi que el regex las sigue encontrando aunque la nota
// nunca se arme. Reescrito para invocar el mcp-server DE VERDAD y leer la
// nota real que vuelve en la respuesta.
test('a2a_send nombra los pass sin artefacto en su nota, y NO bloquea', async (t) => {
  const { callA2aSend, textOf, fixture } = require('./helpers/mcp-call.cjs');
  const dir = fixture(t, 'weak-passes-');
  const body = [
    'criteria:',
    '- deploy: pass — sin errores',
    '- tests: pass — 917/920',
  ].join('\n');
  const res = await callA2aSend({ from_pane: 601, to_pane: 602, corr: 'wp-real-1', type: 'result', body }, { WEZBRIDGE_INTEL_DIR: dir });
  assert.notEqual(res.isError, true, 'the weak-pass note must never block the send');
  const out = JSON.parse(textOf(res));
  assert.match(out.note, /UNVERIFIABLE PASSES \(1\): deploy/, 'the note must name the exact unverifiable pass');
  assert.doesNotMatch(out.note, /tests/, 'a pass that CITES an artifact (917\\/920) must not be named as unverifiable');
});
