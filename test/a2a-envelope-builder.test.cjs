'use strict';
/**
 * El header del envelope debe llevar NOMBRES DE PROYECTO cuando se los conoce.
 *
 * El pane-id no es una dirección: vive en dos espacios (el que publica el MCP
 * y el del CLI de wezterm) y el mismo pane es 11 en uno y 15 en el otro. Medido
 * el 2026-08-29: la pane de infra avisó DOS VECES de un misruteo inexistente
 * porque leía el id MCP del header contra el suyo del CLI. El envío estaba
 * bien; el header no podía expresar la dirección real.
 *
 * El contrato del mensajeo nativo de Claude lo dice en una línea — "the name IS
 * the address" — y esto le copia esa propiedad.
 *
 * FALLBACK OBLIGATORIO a pane-N: no siempre se conoce el proyecto (envelopes
 * headless, panes sin cwd resoluble). Un header sin dirección es peor que uno
 * con una dirección ambigua.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { buildEnvelope } = require('../src/a2a-intel.cjs');

const base = { fromPane: 2, toPane: 11, corr: 'c-1', type: 'request', body: 'hola' };

test('A1 (fail-first): con ambos proyectos conocidos, el header lleva NOMBRES', () => {
  const e = buildEnvelope({ ...base, fromProject: 'wezbridge', toProject: 'infra' });
  assert.match(e, /^\[A2A from wezbridge to infra \| corr=c-1 \| type=request\]/,
    `el header tiene que direccionar por nombre. Salió: ${JSON.stringify(e.split('\n')[0])}`);
  assert.ok(e.endsWith('\nhola'), 'el cuerpo va después del header, sin tocar');
});

test('A2: los nombres reales con guiones sobreviven', () => {
  const e = buildEnvelope({ ...base, fromProject: 'wezbridge', toProject: 'whatsappbot-final' });
  assert.match(e, /to whatsappbot-final \|/);
});

test('B1 (fallback): sin proyecto conocido, sigue siendo pane-N', () => {
  const e = buildEnvelope(base);
  assert.match(e, /^\[A2A from pane-2 to pane-11 \| corr=c-1 \| type=request\]/,
    'un header sin dirección es peor que uno ambiguo');
});

test('B2 (mixto): se conoce uno solo, el otro cae a pane-N', () => {
  assert.match(buildEnvelope({ ...base, toProject: 'infra' }), /^\[A2A from pane-2 to infra \|/);
  assert.match(buildEnvelope({ ...base, fromProject: 'wezbridge' }), /^\[A2A from wezbridge to pane-11 \|/);
});

test('B3: un proyecto vacío o en blanco NO cuenta como conocido', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.match(buildEnvelope({ ...base, toProject: v }), /to pane-11 \|/,
      `toProject=${JSON.stringify(v)} no es una dirección`);
  }
});

test('C1 (round-trip): lo que este builder emite, el parser lo entiende', () => {
  const { parseA2AEnvelopes } = require('../src/handlers/shared.cjs');
  const e = buildEnvelope({ ...base, fromProject: 'wezbridge', toProject: 'whatsappbot-final' });
  const hits = parseA2AEnvelopes(e);
  assert.strictEqual(hits.length, 1, 'emitir algo que nuestro propio parser no lee es el peor final posible');
  assert.strictEqual(hits[0].from, 'wezbridge');
  assert.strictEqual(hits[0].to, 'whatsappbot-final');
  assert.strictEqual(hits[0].corr, 'c-1');
  assert.strictEqual(hits[0].type, 'request');
});

test('C2 (round-trip legacy): el fallback también se parsea', () => {
  const { parseA2AEnvelopes } = require('../src/handlers/shared.cjs');
  const hits = parseA2AEnvelopes(buildEnvelope(base));
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].from, 'pane-2');
  assert.strictEqual(hits[0].to, 'pane-11');
});
