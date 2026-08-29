'use strict';
/**
 * El header del envelope debe poder direccionar por PROYECTO, no sólo por
 * pane-id — y el parser tiene que entender las dos formas durante la
 * transición.
 *
 * POR QUÉ. Los pane-id de wezbridge viven en DOS espacios distintos: el que
 * publica el MCP y el del CLI de wezterm. El mismo pane es 11 en uno y 15 en
 * el otro. Medido el 2026-08-29: la pane de infra me avisó DOS VECES que yo
 * había misruteado un envelope, y las dos veces yo había usado `to_project`
 * correctamente — lo que mentía era el header, que estampa el id MCP mientras
 * el receptor se ve a sí mismo con el id del CLI. Nadie estaba equivocado: el
 * formato no puede expresar la dirección real.
 *
 * El mensajeo nativo de Claude no tiene el problema porque su contrato dice
 * "the name IS the address". Esto le copia esa propiedad al header nuestro.
 *
 * COMPATIBILIDAD OBLIGATORIA: los panes con servidor viejo van a seguir
 * emitiendo `pane-N` mientras no reinicien (runtime != repo). Un parser que
 * sólo entienda el formato nuevo pierde esos envelopes EN SILENCIO, que es
 * peor que el bug de direccionamiento. Por eso los dos sentidos se prueban.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { parseA2AEnvelopes } = require('../src/handlers/shared.cjs');

const parse = (text) => parseA2AEnvelopes(text);

// ── SENTIDO A: el formato nuevo, por nombre de proyecto ─────────────────────

test('A1 (fail-first): un header con nombres de proyecto se parsea', () => {
  const hits = parse('[A2A from wezbridge to infra | corr=vm186-io-20260829 | type=request]\ncuerpo');
  assert.strictEqual(hits.length, 1, 'el envelope por nombre tiene que reconocerse');
  assert.strictEqual(hits[0].from, 'wezbridge');
  assert.strictEqual(hits[0].to, 'infra');
  assert.strictEqual(hits[0].corr, 'vm186-io-20260829');
  assert.strictEqual(hits[0].type, 'request');
});

test('A2: un nombre con guiones no se parte', () => {
  const hits = parse('[A2A from wezbridge to whatsappbot-final | corr=c-1 | type=result]');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].to, 'whatsappbot-final',
    'los nombres reales de proyecto llevan guiones; partirlos rutea a un destino inventado');
});

// ── SENTIDO B: el formato viejo sigue funcionando (o perdemos envelopes) ────

test('B1 (el otro sentido): el header legacy pane-N se sigue parseando', () => {
  const hits = parse('[A2A from pane-2 to pane-11 | corr=legacy-1 | type=progress]');
  assert.strictEqual(hits.length, 1, 'los panes con servidor viejo siguen emitiendo asi');
  assert.strictEqual(hits[0].from, 'pane-2');
  assert.strictEqual(hits[0].to, 'pane-11');
  assert.strictEqual(hits[0].corr, 'legacy-1');
});

test('B2: legacy y nuevo mezclados en el mismo texto, ambos se ven', () => {
  const hits = parse([
    '[A2A from pane-2 to pane-11 | corr=viejo | type=request]',
    'algo en el medio',
    '[A2A from wezbridge to memorymaster | corr=nuevo | type=ack]',
  ].join('\n'));
  assert.strictEqual(hits.length, 2, 'la transición convive: no se puede perder ninguno de los dos');
  assert.deepStrictEqual(hits.map((h) => h.corr), ['viejo', 'nuevo']);
});

// ── regresión: no inventar envelopes donde no hay ───────────────────────────

test('C1: texto sin envelope no produce nada', () => {
  assert.strictEqual(parse('hablando de [A2A] en abstracto, sin header').length, 0);
  assert.strictEqual(parse('').length, 0);
  assert.strictEqual(parse(null).length, 0);
});

test('C2: un header a medio escribir no se acepta', () => {
  assert.strictEqual(parse('[A2A from wezbridge to infra | type=request]').length, 0,
    'sin corr no hay hilo que seguir: aceptarlo crea un thread fantasma');
});
