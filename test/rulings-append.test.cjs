'use strict';
/**
 * rulings-append.test.cjs — PROCEDENCIA del ruling: quien lo escribio.
 *
 * Cubre `validateRulingLine` (pura) y `appendRuling` (unico escritor) de
 * src/rulings.cjs: vocabulario cerrado (+`approved`), `source` OBLIGATORIO,
 * `deferred` con `until` futuro, `approved` solo sobre awaiting-operator/null,
 * y que los 338 renglones LEGACY sin `source` se sigan leyendo igual.
 * Leer cuando: se toque el schema de _intel/rulings.jsonl o quien lo escribe.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../src/rulings.cjs');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** Una linea minima valida. Cada test rompe UN campo sobre esta base. */
const good = (over = {}) => ({
  task: 'T-0301', category: 'awaiting-operator', ruling: 'approved',
  why: 'el operador aprobo desde el telefono', source: 'board-app', ...over,
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulings-append-'));
  return dir;
}

// --- vocabularios -----------------------------------------------------------

test('RULING_VOCAB y RULING_SOURCES son enums cerrados y exportados', () => {
  assert.deepStrictEqual([...R.RULING_VOCAB].sort(),
    ['approved', 'cancelled', 'deferred', 'dispatched', 'operator-gated', 'resolved']);
  assert.deepStrictEqual([...R.RULING_SOURCES].sort(),
    ['board-app', 'drill', 'ledger-cli', 'orchestrator-pane', 'telegram']);
});

// --- validateRulingLine -----------------------------------------------------

test('una linea valida pasa y sale normalizada, con `at` estampado del reloj', () => {
  const r = R.validateRulingLine(good(), NOW);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.line.at, iso(NOW), '`at` ausente se estampa desde `now`, nunca se inventa');
  assert.strictEqual(r.line.source, 'board-app');
  assert.deepStrictEqual(Object.keys(r.line).sort(), ['at', 'category', 'ruling', 'source', 'task', 'why']);
});

test('un `at` propio se respeta: el escritor puede fechar su propia decision', () => {
  const at = '2026-08-30T01:02:03.000Z';
  const r = R.validateRulingLine(good({ at }), NOW);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.line.at, at);
});

test('appendRuling refuses a line without source', () => {
  // ASESINO de la mutacion "quitar el chequeo de source". La procedencia es la
  // razon de ser de este modulo: un ruling sin `source` es exactamente la linea
  // anonima que hoy no se puede auditar.
  const line = good();
  delete line.source;
  const r = R.validateRulingLine(line, NOW);
  assert.strictEqual(r.ok, false, 'una linea sin source NO puede validar');
  assert.match(r.error, /source/, `el error tiene que nombrar el campo: ${r.error}`);

  const dir = sandbox();
  assert.throws(() => R.appendRuling(dir, line, { now: NOW }), /source/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'rulings.jsonl')), false,
    'y no deja NADA escrito — ni un archivo vacio');
});

test('un `source` fuera del enum se rechaza nombrando el enum', () => {
  const r = R.validateRulingLine(good({ source: 'curl' }), NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /board-app/);
});

test('el vocabulario de `ruling` sigue cerrado, ahora con approved adentro', () => {
  for (const ruling of R.RULING_VOCAB) {
    const extra = ruling === 'deferred' ? { until: iso(NOW + 3600000) } : {};
    const cat = ruling === 'approved' ? 'awaiting-operator' : 'idle';
    const r = R.validateRulingLine(good({ ruling, category: cat, ...extra }), NOW);
    assert.strictEqual(r.ok, true, `${ruling} deberia validar: ${r.error}`);
  }
  for (const word of ['done', 'closed', 'harvested', '', null, 42]) {
    const r = R.validateRulingLine(good({ ruling: word }), NOW);
    assert.strictEqual(r.ok, false, `"${word}" fue aceptado como ruling`);
  }
});

test('task id: charset acotado, y un path traversal no es un task id', () => {
  assert.strictEqual(R.validateRulingLine(good({ task: 'result:T-0301:r2' }), NOW).ok, true);
  assert.strictEqual(R.validateRulingLine(good({ task: 'proposal.board-push' }), NOW).ok, true);
  for (const bad of ['../../escape', 'T 0301', '', 'x'.repeat(81), null]) {
    assert.strictEqual(R.validateRulingLine(good({ task: bad }), NOW).ok, false, `"${bad}" paso como task`);
  }
});

test('`why` vacio no es un ruling: una decision sin razon es un encogimiento de hombros', () => {
  for (const why of ['', '   ', null, undefined, 7]) {
    assert.strictEqual(R.validateRulingLine(good({ why }), NOW).ok, false, `"${why}" paso como why`);
  }
});

test('`deferred` exige un `until` ISO en el FUTURO', () => {
  assert.strictEqual(R.validateRulingLine(good({ ruling: 'deferred', category: 'idle' }), NOW).ok, false,
    'sin until');
  assert.strictEqual(
    R.validateRulingLine(good({ ruling: 'deferred', category: 'idle', until: iso(NOW - 1000) }), NOW).ok, false,
    'until en el pasado');
  assert.strictEqual(
    R.validateRulingLine(good({ ruling: 'deferred', category: 'idle', until: 'manana' }), NOW).ok, false,
    'until no parseable');
  const okLine = R.validateRulingLine(good({ ruling: 'deferred', category: 'idle', until: iso(NOW + 86400000) }), NOW);
  assert.strictEqual(okLine.ok, true, okLine.error);
  assert.strictEqual(okLine.line.until, iso(NOW + 86400000));
});

test('`approved` solo se acepta sobre awaiting-operator o sin categoria', () => {
  assert.strictEqual(R.validateRulingLine(good({ category: 'awaiting-operator' }), NOW).ok, true);
  assert.strictEqual(R.validateRulingLine(good({ category: null }), NOW).ok, true);
  for (const cat of ['idle', 'stale-review', 'dead-owner-lease']) {
    const r = R.validateRulingLine(good({ category: cat }), NOW);
    assert.strictEqual(r.ok, false, `approved sobre ${cat} deberia rechazarse`);
    assert.match(r.error, /awaiting-operator/);
  }
});

test('`by` y `corr` son opcionales y sobreviven; un campo inventado se RECHAZA', () => {
  const r = R.validateRulingLine(good({ by: 'operator', corr: 'T-0301:drill:20260901' }), NOW);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.line.by, 'operator');
  assert.strictEqual(r.line.corr, 'T-0301:drill:20260901');
  const bad = R.validateRulingLine(good({ aprobado: true }), NOW);
  assert.strictEqual(bad.ok, false, 'un campo desconocido se traga en silencio si no se rechaza');
  assert.match(bad.error, /aprobado/);
});

// --- appendRuling -----------------------------------------------------------

test('appendRuling escribe UNA linea JSON y devuelve la linea normalizada', () => {
  const dir = sandbox();
  const written = R.appendRuling(dir, good(), { now: NOW });
  const raw = fs.readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'la linea termina en newline — nunca parcial');
  const lines = raw.split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]), written);
  R.appendRuling(dir, good({ task: 'T-0302' }), { now: NOW });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2,
    'append-only: la segunda no pisa la primera');
});

test('una linea invalida NO toca el archivo existente (jamas escritura parcial)', () => {
  const dir = sandbox();
  R.appendRuling(dir, good(), { now: NOW });
  const before = fs.readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8');
  assert.throws(() => R.appendRuling(dir, good({ ruling: 'inventado' }), { now: NOW }));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8'), before,
    'el archivo quedo byte por byte igual');
});

// --- compatibilidad con lo YA escrito ---------------------------------------

test('los renglones LEGACY sin `source` se siguen leyendo por los tres lectores', () => {
  // Las 338 lineas vivas no tienen `source` y no se van a reescribir: exigirlo
  // al ESCRIBIR y exigirlo al LEER son cosas distintas, y confundirlas seria
  // volver ilegible el historial que el gate consulta.
  const legacy = [
    { task: 'T-0100', category: 'idle', ruling: 'dispatched', why: 'viejo', at: '2026-08-01T00:00:00Z' },
    { task: 'T-0100', category: 'idle', ruling: 'cancelled', why: 'mas nuevo', at: '2026-08-02T00:00:00Z' },
    { task: 'T-0101', category: null, ruling: 'resolved', why: 'otro', at: '2026-08-03T00:00:00Z' },
  ];
  assert.strictEqual(R.rulingsFor(legacy, 'T-0100').length, 2);
  assert.strictEqual(R.latestRuling(legacy, 'T-0100').why, 'mas nuevo');
  assert.strictEqual(R.latestRulingWhere(legacy, 'T-0100', (r) => r.ruling === 'dispatched').why, 'viejo');
  assert.deepStrictEqual(R.taskIds(legacy), ['T-0100', 'T-0101']);
});

test('lo legacy y lo nuevo conviven en el MISMO archivo y el mas nuevo gana', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'rulings.jsonl'),
    `${JSON.stringify({ task: 'T-0301', category: 'awaiting-operator', ruling: 'dispatched', why: 'legacy', at: '2026-08-01T00:00:00Z' })}\n`);
  R.appendRuling(dir, good({ why: 'con procedencia' }), { now: NOW });
  const all = fs.readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].source, undefined, 'la legacy no se toco');
  assert.strictEqual(R.latestRuling(all, 'T-0301').why, 'con procedencia');
});
