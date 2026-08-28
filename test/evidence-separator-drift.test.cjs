'use strict';
/**
 * `weakPasses` y `detectEvidence` leen EL MISMO TEXTO con reglas distintas.
 *
 * MEDIDO EN VIVO el 2026-08-27: mandé un `type=result` cuyo bloque criteria
 * llevaba evidencia en cada línea, y `a2a_send` me devolvió `evidence: 0`
 * mientras `weakPasses` leía esa misma evidencia sin marcar nada. Dos
 * contadores sobre un artefacto, discrepando.
 *
 *   detectEvidence  /^\s*-\s+.+?:\s*(?:pass|fail)\b\s*[—–-]{1,2}\s*(\S.*)$/
 *                   bullet `-` OBLIGATORIO, separador SIN `:`
 *   weakPasses      /^\s*[-*]?\s*(.+?):\s*pass\b\s*(?:[—:-]\s*(.*))?$/
 *                   bullet opcional, separador CON `:`
 *
 * Es la misma familia que ya costó caro dos veces esta semana: el waker de
 * `review` que no leía rulings, y un ruling `resolved` con la tarjeta abierta.
 * Dos autoridades sobre un mismo texto, con criterios que nadie cruzó.
 *
 * CUÁL SE MUEVE Y POR QUÉ: `detectEvidence` se ensancha hasta la tolerancia de
 * `weakPasses`, no al revés. El propósito declarado del contador es "criteria=5,
 * evidence=0 es un result que pide que le crean en vez de que lo chequeen" — si
 * sub-cuenta por un separador, produce esa acusación sobre trabajo que SÍ trajo
 * evidencia. Un contador que difama al que cumple es peor que no tenerlo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { detectEvidence, weakPasses } = require('../src/a2a-intel.cjs');

/** Formas reales, tomadas de results enviados esta semana. */
const FORMAS = [
  { nombre: 'guion largo con bullet (la forma canónica)', linea: '- tests: pass — 940/937 pass' },
  { nombre: 'dos puntos como separador', linea: '- tests: pass: 940/937 pass' },
  { nombre: 'sin bullet, guion largo', linea: 'tests: pass — 940/937 pass' },
  { nombre: 'sin bullet, dos puntos', linea: 'tests: pass: 940/937 pass' },
  { nombre: 'bullet asterisco', linea: '* tests: pass — 940/937 pass' },
];

test('los dos lectores coinciden en si una línea trae evidencia', () => {
  const desacuerdos = [];
  for (const f of FORMAS) {
    const cuenta = detectEvidence(f.linea).count > 0;   // ¿ve evidencia?
    const marcada = weakPasses(f.linea).length > 0;     // ¿la marca como SIN evidencia?
    // Coherencia: si uno ve evidencia, el otro no puede estar acusando ausencia.
    if (cuenta === marcada) desacuerdos.push(`${f.nombre}: detectEvidence=${cuenta} weakPasses_marca=${marcada}`);
  }
  assert.deepStrictEqual(desacuerdos, [],
    'un lector ve la evidencia y el otro la niega sobre el mismo texto');
});

test('la evidencia se cuenta en todas las formas reales, no sólo en la canónica', () => {
  for (const f of FORMAS) {
    const r = detectEvidence(f.linea);
    assert.strictEqual(r.count, 1, `no contó evidencia en: ${f.nombre}`);
    assert.match(r.items[0], /940/, `la evidencia extraída perdió el dato en: ${f.nombre}`);
  }
});

// --- Anti-lobo: ensanchar no puede volverlo crédulo -------------------------
test('un veredicto SIN cola de evidencia sigue contando cero', () => {
  for (const l of ['- deploy: pass', '- deploy: pass —', 'deploy: pass', '- deploy: pass -  ']) {
    assert.strictEqual(detectEvidence(l).count, 0, `contó evidencia inexistente en: ${JSON.stringify(l)}`);
  }
});

test('prosa libre sigue dando cero', () => {
  assert.deepStrictEqual(detectEvidence('All done, works fine.'), { count: 0, items: [] });
  assert.deepStrictEqual(detectEvidence('el deploy salió bien y no hubo errores'), { count: 0, items: [] });
});

test('los fail con evidencia se siguen contando', () => {
  const r = detectEvidence('- gate Trivy: fail — api 26 HIGH + 4 CRITICAL');
  assert.strictEqual(r.count, 1);
  assert.match(r.items[0], /26 HIGH/);
});

test('un bloque real completo cuenta una vez por criterio', () => {
  const body = [
    'criteria:',
    '- fail-first: pass — 5 fail / 7 pass contra la semántica anterior',
    '- mutación: pass — con assertPaneCap a no-op el test da rojo (13/14)',
    '- suite: pass — 955 tests, 952 pass, 2 fail preexistentes',
    '- cobertura del flaky: fail — no reproducible determinísticamente',
    'files_changed: src/a2a-intel.cjs',
  ].join('\n');
  assert.strictEqual(detectEvidence(body).count, 4);
});
