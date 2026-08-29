'use strict';
/**
 * Un cuerpo largo se DERRAMA a disco y viaja como puntero, en vez de que el
 * emisor tenga que acortarlo a mano.
 *
 * Hoy el guard REFUSA y le dice al llamador "escribí un archivo y mandá un
 * puntero". Medido el 2026-08-29 en una sola sesión: esa refusión se disparó
 * SEIS veces y yo la resolví a mano cada vez — y DOS de los reenvíos "cortos"
 * volvieron igual con `delivered: truncated`. O sea que el humano-en-el-medio
 * ni siquiera es confiable: acorta de a poco hasta que entra, y a veces no
 * entra.
 *
 * El guard tenía razón en el diagnóstico y se quedó corto en el remedio: si el
 * sistema YA SABE que el cuerpo no entra, y YA SABE cuál es el remedio, no hay
 * motivo para devolvérselo al llamador. Derramarlo es determinista; acortarlo
 * a ojo no.
 *
 * LA PROPIEDAD QUE MÁS IMPORTA, y por eso es el primer test: EL PUNTERO MISMO
 * NUNCA PUEDE PASARSE DEL LÍMITE. Un puntero que trunca no arregla nada — deja
 * al receptor con una ruta cortada, que es peor que un cuerpo cortado porque
 * parece completa.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { a2aSpill, A2A_BODY_SOFT_LIMIT } = require('../src/a2a-length-guard.cjs');

const LIMIT = 1200;
const long = (n) => 'x'.repeat(n);

/** writeFile falso: registra sin tocar disco. */
function fakeWriter() {
  const writes = [];
  return { writes, write: (p, c) => { writes.push({ path: p, content: c }); } };
}

const spill = (body, over = {}) => a2aSpill({
  body,
  corr: over.corr ?? 'corr-de-prueba',
  limit: over.limit ?? LIMIT,
  dir: over.dir ?? '/fake/_intel/spill',
  writeFile: over.writeFile ?? fakeWriter().write,
  now: over.now ?? (() => new Date('2026-08-29T17:30:00Z')),
});

// ── LA propiedad ────────────────────────────────────────────────────────────

test('A1 (fail-first): el PUNTERO nunca supera el límite, ni con un cuerpo enorme', () => {
  for (const n of [1201, 5000, 50000, 500000]) {
    const r = spill(long(n));
    assert.strictEqual(r.spilled, true, `${n} chars tiene que derramarse`);
    assert.ok(r.body.length <= LIMIT,
      `el puntero mide ${r.body.length} para un cuerpo de ${n}: un puntero que trunca deja una RUTA cortada, que parece completa y no lo está`);
  }
});

test('A2: el puntero tampoco se pasa con un corr absurdamente largo', () => {
  const r = spill(long(9000), { corr: 'c'.repeat(400) });
  assert.strictEqual(r.spilled, true);
  assert.ok(r.body.length <= LIMIT,
    `el corr es dato del llamador: no puede empujar el puntero por encima del límite (midió ${r.body.length})`);
});

// ── el contenido derramado tiene que estar ENTERO ───────────────────────────

test('B1: el archivo derramado contiene el cuerpo COMPLETO, sin recortar', () => {
  const w = fakeWriter();
  const body = `${long(3000)}FIN-DEL-CUERPO`;
  const r = spill(body, { writeFile: w.write });

  assert.strictEqual(w.writes.length, 1, 'un derrame, un archivo');
  assert.ok(w.writes[0].content.includes(body),
    'derramar un cuerpo recortado es exactamente el bug que esto viene a arreglar');
  assert.ok(w.writes[0].content.includes('FIN-DEL-CUERPO'), 'incluida la cola');
});

test('B2: el puntero nombra la ruta exacta del archivo escrito', () => {
  const w = fakeWriter();
  const r = spill(long(2000), { writeFile: w.write });
  assert.ok(r.body.includes(w.writes[0].path),
    'un puntero que no dice dónde está el contenido no es un puntero');
  assert.strictEqual(r.path, w.writes[0].path);
});

test('B3: el puntero dice cuánto se derramó, para que el receptor sepa qué le falta', () => {
  const r = spill(long(7777));
  assert.match(r.body, /7777/, 'sin el tamaño, el receptor no sabe si le conviene ir a buscarlo');
});

// ── el otro sentido: lo que entra, NO se toca ───────────────────────────────

test('C1 (el otro sentido): un cuerpo bajo el límite pasa intacto y NO escribe nada', () => {
  const w = fakeWriter();
  const body = 'un mensaje normal y corto';
  const r = spill(body, { writeFile: w.write });

  assert.strictEqual(r.spilled, false);
  assert.strictEqual(r.body, body, 'no se toca lo que ya entraba');
  assert.strictEqual(w.writes.length, 0, 'derramar lo que entra ensucia el disco y agrega un salto inútil');
});

test('C2: exactamente en el límite NO se derrama', () => {
  const r = spill(long(LIMIT));
  assert.strictEqual(r.spilled, false, 'el límite es inclusivo: 1200 entra');
  const r2 = spill(long(LIMIT + 1));
  assert.strictEqual(r2.spilled, true, 'uno más, no');
});

// ── fail-soft: el derrame nunca puede romper la entrega ─────────────────────

test('D1: si el disco falla, NO se pierde el mensaje — se devuelve el cuerpo original', () => {
  const boom = () => { throw new Error('EACCES'); };
  const r = spill(long(4000), { writeFile: boom });

  assert.strictEqual(r.spilled, false, 'no se puede afirmar un derrame que no ocurrió');
  assert.strictEqual(r.body.length, 4000,
    'si no se pudo derramar, el llamador decide: mejor un cuerpo que puede truncarse que ningún mensaje');
  assert.ok(r.error, 'y tiene que poder saber POR QUE no se derramó');
});

test('E1: el límite por defecto sigue siendo el medido, no uno inventado', () => {
  assert.strictEqual(A2A_BODY_SOFT_LIMIT, 1200);
});
