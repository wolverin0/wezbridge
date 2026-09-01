'use strict';
/**
 * T-0272 — un pane puede tomar una lease y morir sin dejar rastro.
 *
 * MEDIDO, no hipotetico: T-0199 se despacho el 2026-08-25, pane-39 tomo una
 * lease de 1440 minutos y murio. Durante 22 horas el tablero dijo "running" y
 * el steward la dejo en paz JUSTO por eso. El unico detector era el vencimiento
 * de la lease, asi que el piso de deteccion es la duracion de la lease.
 *
 * La sutileza que estos tests fijan: comprobar que el pane "existe" NO alcanza,
 * porque los ids se reciclan — el mismo pane-39 sostuvo T-0067 el 2026-08-01 y
 * reaparecio el 08-25 siendo OTRA sesion en OTRO repo. La comprobacion honesta
 * es owner vivo Y cwd del pane coincidente con el repo de la tarjeta.
 *
 * Y la semantica que NO hay que fusionar (mismo error que T-0269): un pane
 * VIVO con una lease larga sin vencer es SANO. Ese caso tiene su test verde
 * explicito aca; el vencimiento es de abandoned-lease, no de este modulo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileLeases } = require('../scripts/lease-reconcile.cjs');

const NOW = Date.parse('2026-09-01T04:00:00Z');
const H = 3600 * 1000;

function card(id, repo, state, owner, expiresMs) {
  return {
    id, repo, state, title: `card ${id}`,
    lease: { owner, expires_at: new Date(expiresMs).toISOString() },
  };
}

const CENSUS_OK = [
  { pane_id: 4, cwd: 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps/wezbridge/' },
  { pane_id: 9, cwd: 'G:\\_OneDrive\\OneDrive\\Desktop\\Py Apps\\whatsappbot-prod - Copy - Copy\\whatsappbot-final' },
];

test('AC2-rojo: una lease sobre un pane INEXISTENTE produce hallazgo que nombra tarjeta y owner', () => {
  const tasks = [card('T-0999', 'wezbridge', 'running', 'pane-33 (wezbridge)', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.match(out[0].why, /pane-33/);
  assert.strictEqual(out[0].id, 'T-0999');
  assert.match(out[0].why, /no existe|censo/i);
});

test('AC2-verde: owners vivos y cwd coincidente => cero hallazgos', () => {
  const tasks = [
    card('T-0272', 'wezbridge', 'running', 'pane-4 (wezbridge)', NOW + 24 * H),
    card('T-0254', 'whatsappbot-prod - Copy - Copy/whatsappbot-final', 'running', 'pane-9 (whatsappbot-final)', NOW + 2 * H),
  ];
  assert.deepStrictEqual(reconcileLeases(tasks, CENSUS_OK, NOW), []);
});

test('AC4 (semantica separada): pane VIVO con lease LARGA sin vencer NO es hallazgo', () => {
  // 30 dias de lease: es asunto de nadie mientras el owner este vivo y en su repo.
  const tasks = [card('T-0100', 'wezbridge', 'running', 'pane-4 (wezbridge)', NOW + 720 * H)];
  assert.deepStrictEqual(reconcileLeases(tasks, CENSUS_OK, NOW), []);
});

test('AC5 (regresion T-0199/pane-39): el id reciclado — pane vivo pero en OTRO repo — es hallazgo', () => {
  // pane-39 existe, pero su cwd es otra sesion en otro proyecto. "Existe" no alcanza.
  const census = [...CENSUS_OK, { pane_id: 39, cwd: 'G:/_OneDrive/OneDrive/Desktop/Py Apps/brlite' }];
  const tasks = [card('T-0199', 'memorymaster', 'running', 'pane-39 (memorymaster)', NOW + 10 * H)];
  const out = reconcileLeases(tasks, census, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.match(out[0].why, /pane-39/);
  assert.match(out[0].why, /cwd|repo/i);
  assert.match(out[0].why, /brlite/);
});

test('punto (4) del despacho: estados NO-running con lease escrita tambien se reconcilian', () => {
  // T-0229 y compania: tarjetas blocked/review con lease vencida y owner muerto.
  // Un reconciliador que solo barra "running" no limpia ninguna.
  const tasks = [
    card('T-0229', 'wezbridge', 'blocked', 'pane-77 (wezbridge)', NOW - 50 * H),
    card('T-0253', 'memorymaster', 'review', 'pane-78 (memorymaster)', NOW - 2 * H),
  ];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 2);
  for (const f of out) assert.strictEqual(f.category, 'dead-owner-lease');
});

test('estados terminales quedan afuera: una lease vieja en done/cancelled no es hallazgo', () => {
  const tasks = [
    card('T-0001', 'wezbridge', 'done', 'pane-99 (wezbridge)', NOW - 100 * H),
    card('T-0002', 'wezbridge', 'cancelled', 'pane-98 (wezbridge)', NOW - 100 * H),
  ];
  assert.deepStrictEqual(reconcileLeases(tasks, CENSUS_OK, NOW), []);
});

test('censo caido => UN hallazgo ruidoso, nunca silencio', () => {
  // La trampa clasica: si el censo falla y el modulo devuelve [], el fallo de
  // medicion se disfraza de "todo sano". Silencio es la unica direccion en la
  // que este detector no puede fallar.
  const tasks = [card('T-0999', 'wezbridge', 'running', 'pane-4 (wezbridge)', NOW + 1 * H)];
  const out = reconcileLeases(tasks, null, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'lease-census-unavailable');
});

test('cwd VACIO en el censo => unverifiable, NUNCA "id reciclado" (medido en la primera corrida real)', () => {
  // Un pane con cwd vacio puede ser un muerto residual o una lectura
  // transitoria (leccion Monitor v3). Afirmar "reciclado" seria decir mas que
  // la evidencia; callarse seria el silencio de siempre. Se dice lo medible.
  const census = [...CENSUS_OK, { pane_id: 55, cwd: '' }];
  const tasks = [card('T-0555', 'wezbridge', 'running', 'pane-55 (wezbridge)', NOW + 5 * H)];
  const out = reconcileLeases(tasks, census, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'lease-owner-unverifiable');
  assert.match(out[0].why, /vacío|vacio/);
  assert.match(out[0].why, /pane-55/);
});

test('owner sin forma pane-N se reporta como ilegible, no se salta en silencio', () => {
  const tasks = [card('T-0500', 'wezbridge', 'running', 'el orquestador', NOW + 1 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.match(out[0].why, /ilegible|sin pane/i);
});
