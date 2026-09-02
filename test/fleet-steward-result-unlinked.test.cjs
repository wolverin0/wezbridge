'use strict';
// fleet-steward-result-unlinked.test.cjs — W2: un result que NO pudo ligarse a
// su tarjeta es un hallazgo del steward, no una linea perdida en events.jsonl.
// El linker emite `result.unlinked` con la razon (ambiguous|no-card|state=<s>|
// no-task-corr|ledger-error|v2=<x>); esto lo convierte en item del backlog con
// id `result:<corr>`, ventana de 72h y el repo de la tarjeta cuando se conoce.
// Mismo circuito que proposal-unledgered: sin superficie nueva ni archivo nuevo.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

function intelWith(events, cards = [], results = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-unlinked-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'a2a-results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const c of cards) fs.writeFileSync(path.join(d, 'tasks', `${c.id}.json`), JSON.stringify(c, null, 2));
  return d;
}

const unlinked = (over = {}) => ({
  time: hoursAgo(3), event: 'result.unlinked', corr: 'T-0501:x:20260901', reason: 'no-card', ...over,
});

test('W2: un result.unlinked reciente es un hallazgo con id result:<corr> y la razon adentro', () => {
  const dir = intelWith([unlinked()]);
  const f = steward.audit([], NOW, dir).findings;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].category, 'result-unlinked');
  assert.strictEqual(f[0].id, 'result:T-0501:x:20260901');
  assert.strictEqual(f[0].age_hours, 3);
  assert.match(f[0].why, /no-card/, 'la razon TIENE que viajar: "no se ligo" sin el motivo no es accionable');
});

test('W2: el hallazgo hereda el repo de la tarjeta cuando el corr resuelve a una', () => {
  const dir = intelWith(
    [unlinked({ corr: 'T-0502:x:20260901', reason: 'state=queued' })],
    [{ id: 'T-0502', repo: 'finalorchestra', state: 'queued', title: 'algo' }],
  );
  const f = steward.audit([], NOW, dir).findings;
  assert.strictEqual(f[0].repo, 'finalorchestra', 'sin repo el tablero lo agrupa en "null" y no lo levanta nadie');
});

test('W2: sin tarjeta el repo es "unknown" — nunca se inventa un dueno', () => {
  const dir = intelWith([unlinked({ corr: 'charla-suelta', reason: 'no-task-corr' })]);
  assert.strictEqual(steward.audit([], NOW, dir).findings[0].repo, 'unknown');
});

test('W2: fuera de siete dias es historia, y el mismo corr no se cuenta dos veces', () => {
  const viejo = intelWith([unlinked({ time: hoursAgo(170) })]);
  assert.deepStrictEqual(steward.audit([], NOW, viejo).findings, [],
    're-marcar para siempre entrena a ignorar la categoria');
  const repetido = intelWith([unlinked({ time: hoursAgo(5) }), unlinked({ time: hoursAgo(2) })]);
  const f = steward.audit([], NOW, repetido).findings;
  assert.strictEqual(f.length, 1, 'un corr, un item');
  assert.strictEqual(f[0].age_hours, 5, 'la edad se cuenta desde el PRIMER intento fallido, no desde el ultimo');
});

test('T-0319 AC1 RED: un corr sin T-id absorbido por una tarjeta cerrada no es deuda', () => {
  const corr = 'piloto-eve-sin-task-id';
  const dir = intelWith(
    [unlinked({ corr, reason: 'no-task-corr' })],
    [{ id: 'T-0701', corr, repo: 'finalorchestra', state: 'done', title: 'piloto cerrado' }],
  );
  assert.deepStrictEqual(steward.audit([], NOW, dir).findings, [],
    'la tarjeta cerrada ya absorbio el hilo por su corr exacto');
});

test('T-0319 AC2 RED: resultados sin tarjeta de 72h a 7 dias forman una sola fila agregada', () => {
  const dir = intelWith([
    unlinked({ corr: 'piloto-a', time: hoursAgo(80), reason: 'no-task-corr' }),
    unlinked({ corr: 'piloto-b', time: hoursAgo(120), reason: 'no-task-corr' }),
    unlinked({ corr: 'piloto-b', time: hoursAgo(100), reason: 'no-task-corr' }),
  ]);
  const f = steward.audit([], NOW, dir).findings;
  assert.strictEqual(f.length, 1, 'el archivo historico ocupa una sola fila');
  assert.strictEqual(f[0].category, 'result-unlinked');
  assert.strictEqual(f[0].id, 'result:unlinked-archive');
  assert.match(f[0].why, /2 results sin tarjeta, ultimos 7 dias/i);
  assert.match(f[0].why, /a2a-results\.jsonl/);
  assert.deepStrictEqual(f[0].collapsed.map((x) => x.corr), ['piloto-a', 'piloto-b']);
});

test('T-0319 AC3: dentro de 72h el result sin tarjeta sigue siendo individual', () => {
  const dir = intelWith([unlinked({ corr: 'resultado-reciente', time: hoursAgo(71) })]);
  const f = steward.audit([], NOW, dir).findings;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].id, 'result:resultado-reciente');
  assert.strictEqual(f[0].age_hours, 71);
});

test('T-0319 AC3 RED: un retry reciente conserva la edad de llegada del result', () => {
  const corr = 'piloto-viejo-reintentado-hoy';
  const dir = intelWith(
    [unlinked({ corr, time: hoursAgo(1), reason: 'no-task-corr' })],
    [],
    [{ corr, time: hoursAgo(90), type: 'result', body: 'persistido' }],
  );
  const f = steward.audit([], NOW, dir).findings;
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].id, 'result:unlinked-archive',
    'reprocesar no puede rejuvenecer un resultado historico');
  assert.strictEqual(f[0].age_hours, 90);
});

test('T-0319 AC2 RED: como maximo tres resultados recientes quedan individuales', () => {
  const dir = intelWith([1, 2, 3, 4, 5].map((age) => unlinked({
    corr: `resultado-reciente-${age}`,
    time: hoursAgo(age),
  })));
  const f = steward.audit([], NOW, dir).findings;
  const individuals = f.filter((item) => item.id !== 'result:unlinked-archive');
  const aggregate = f.find((item) => item.id === 'result:unlinked-archive');
  assert.strictEqual(individuals.length, 3, 'el tablero tiene un tope de tres filas accionables');
  assert.deepStrictEqual(individuals.map((item) => item.id).sort(), [
    'result:resultado-reciente-1',
    'result:resultado-reciente-2',
    'result:resultado-reciente-3',
  ], 'conserva los tres mas nuevos');
  assert.ok(aggregate, 'el exceso no desaparece: queda agregado');
  assert.deepStrictEqual(aggregate.collapsed.map((item) => item.corr), [
    'resultado-reciente-4',
    'resultado-reciente-5',
  ]);
});

test('W2: result-unlinked rankea junto a lo que el operador debe, no en el fondo del backlog', () => {
  const dir = intelWith([unlinked()]);
  const idle = {
    id: 'T-0600', repo: 'wezbridge', state: 'queued', title: 'algo viejo',
    blocked_by: 'agent', updated_at: hoursAgo(200),
  };
  const f = steward.audit([idle], NOW, dir).findings;
  assert.strictEqual(f[0].category, 'result-unlinked',
    'trabajo TERMINADO que el tablero no registro vale mas que trabajo que nadie empezo');
});
