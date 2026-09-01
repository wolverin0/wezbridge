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

function intelWith(events, cards = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-unlinked-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
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

test('W2: fuera de la ventana de 72h es historia, y el mismo corr no se cuenta dos veces', () => {
  const viejo = intelWith([unlinked({ time: hoursAgo(80) })]);
  assert.deepStrictEqual(steward.audit([], NOW, viejo).findings, [],
    're-marcar para siempre entrena a ignorar la categoria');
  const repetido = intelWith([unlinked({ time: hoursAgo(5) }), unlinked({ time: hoursAgo(2) })]);
  const f = steward.audit([], NOW, repetido).findings;
  assert.strictEqual(f.length, 1, 'un corr, un item');
  assert.strictEqual(f[0].age_hours, 5, 'la edad se cuenta desde el PRIMER intento fallido, no desde el ultimo');
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
