'use strict';
// fleet-steward-decision-unheard.test.cjs — W3/W2-k: el operador decidio y NADIE
// se entero. Un ruling `approved|cancelled` CON procedencia (`source`) que no
// tiene un `decision.delivered` POSTERIOR es un hallazgo `decision-unheard`:
// la autoridad del operador se ejercio y murio en el archivo. La comparacion
// `delivered.time >= ruling.at` es el corazon — un delivered VIEJO no cubre una
// decision nueva, que es como una tarjeta re-aprobada quedaria muda para siempre.
// Epoca 2026-09-01: las 338 lineas legacy (sin source) nunca retro-disparan.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

function intelWith({ rulings = [], events = [], cards = [] }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-unheard-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'rulings.jsonl'), rulings.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(d, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  for (const c of cards) fs.writeFileSync(path.join(d, 'tasks', `${c.id}.json`), JSON.stringify(c, null, 2));
  return d;
}

const ruling = (over = {}) => ({
  task: 'T-0701', ruling: 'approved', source: 'board-app', why: 'dale', at: hoursAgo(8), ...over,
});

const delivered = (over = {}) => ({
  time: hoursAgo(7), event: 'decision.delivered', task: 'T-0701', ...over,
});

const only = (dir, cat) => steward.audit([], NOW, dir).findings.filter((f) => f.category === cat);

test('W2-k: un approved con source y sin decision.delivered es decision-unheard', () => {
  const dir = intelWith({ rulings: [ruling()], cards: [{ id: 'T-0701', repo: 'wezbridge', state: 'ready', title: 'la tarjeta' }] });
  const f = only(dir, 'decision-unheard');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].id, 'T-0701');
  assert.strictEqual(f[0].repo, 'wezbridge');
  assert.strictEqual(f[0].age_hours, 8);
  assert.match(f[0].why, /approved/, 'el hallazgo tiene que decir QUE se decidio');
  assert.match(f[0].why, /board-app/, 'y POR DONDE entro: sin procedencia no se sabe a quien preguntarle');
});

test('W2-k: un decision.delivered POSTERIOR al ruling lo cubre', () => {
  const dir = intelWith({ rulings: [ruling()], events: [delivered()] });
  assert.deepStrictEqual(only(dir, 'decision-unheard'), [],
    'la entrega verificada es la respuesta: un hallazgo sobre comportamiento correcto ensena a ignorar la categoria');
});

test('W2-k: un delivered ANTERIOR al ruling NO lo cubre — la decision nueva sigue muda', () => {
  const dir = intelWith({
    rulings: [ruling({ at: hoursAgo(4) })],
    events: [delivered({ time: hoursAgo(30) })],
  });
  const f = only(dir, 'decision-unheard');
  assert.strictEqual(f.length, 1,
    'un aviso de ayer no entrega la decision de hoy; sin esta comparacion una tarjeta re-aprobada queda muda para siempre');
  assert.strictEqual(f[0].age_hours, 4);
});

test('W2-k: las lineas legacy (sin source) y las anteriores a la epoca no disparan nada', () => {
  const legacy = intelWith({ rulings: [{ task: 'T-0702', ruling: 'approved', why: 'vieja', at: hoursAgo(6) }] });
  assert.deepStrictEqual(only(legacy, 'decision-unheard'), [],
    'las 338 lineas historicas no tienen procedencia y no pueden retro-dispararse');
  const preEpoch = intelWith({ rulings: [ruling({ at: '2026-08-30T10:00:00.000Z' })] });
  assert.deepStrictEqual(only(preEpoch, 'decision-unheard'), []);
});

test('W2-k: solo approved|cancelled sobre un task T-NNNN; el resto del vocabulario no es una orden', () => {
  const otros = intelWith({
    rulings: [
      ruling({ task: 'T-0703', ruling: 'deferred' }),
      ruling({ task: 'T-0704', ruling: 'resolved' }),
      ruling({ task: 'T-0705', ruling: 'operator-gated' }),
      ruling({ task: 'proposal:board-push', ruling: 'approved' }),
    ],
  });
  assert.deepStrictEqual(only(otros, 'decision-unheard'), [],
    'deferred/resolved/operator-gated no piden que alguien vaya a hacer algo ahora');
  const cancelado = intelWith({ rulings: [ruling({ task: 'T-0706', ruling: 'cancelled' })] });
  assert.strictEqual(only(cancelado, 'decision-unheard').length, 1, 'una cancelacion tambien hay que avisarla');
});

test('W2-k: sin tarjeta el repo es "unknown", y un mismo task cuenta una sola vez (el ruling mas viejo sin cubrir)', () => {
  const dir = intelWith({ rulings: [ruling({ at: hoursAgo(9) }), ruling({ at: hoursAgo(2) })] });
  const f = only(dir, 'decision-unheard');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].repo, 'unknown');
  assert.strictEqual(f[0].age_hours, 9);
});
