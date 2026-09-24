'use strict';
/**
 * T-0495 — option-question.cjs: puro, sin IO. hasOptionQuestion detecta
 * preguntas de opciones ((a)/(b)/(c), (1)/(2)/(3)) para que sp-bridge NO les
 * pegue los tres botones /act (approved/cancelled/deferred), que solo sirven
 * para preguntas binarias.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasOptionQuestion, extractOptionMarkers } = require('../scripts/option-question.cjs');

test('detecta 2+ opciones con parentesis en ambos lados: (a) ... (b) ...', () => {
  const t = 'Aplicar el parche: (a) aplicar con la ventana que digas, o (b) dejarlo pausado.';
  assert.equal(hasOptionQuestion(t), true);
  assert.deepEqual(extractOptionMarkers(t), ['a', 'b']);
});

test('detecta 3 opciones numeradas (1) (2) (3)', () => {
  const t = 'Elegi el alcance: (1) cerrar como 2/3, (2) convertir en replay, o (3) dejarla abierta.';
  assert.equal(hasOptionQuestion(t), true);
  assert.deepEqual(extractOptionMarkers(t), ['1', '2', '3']);
});

test('detecta forma sin parentesis de apertura: a) opcion uno b) opcion dos', () => {
  const t = 'Como seguimos:\na) opcion uno\nb) opcion dos';
  assert.equal(hasOptionQuestion(t), true);
});

test('NO detecta una pregunta binaria sin opciones (menos de 2 marcadores)', () => {
  const t = 'autorizas un segundo recreado del dashboard en produccion? si o no contestas, el default es jueves.';
  assert.equal(hasOptionQuestion(t), false);
  assert.deepEqual(extractOptionMarkers(t), []);
});

test('NO detecta con UN solo marcador (a) — un caso no es un menu', () => {
  const t = 'ok, la opcion (a) es la unica que existe por ahora, segui con eso.';
  assert.equal(hasOptionQuestion(t), false);
  assert.deepEqual(extractOptionMarkers(t), ['a']);
});

test('NO detecta el mismo marcador repetido dos veces (no son distintos)', () => {
  const t = 'la opcion (a) fue mencionada antes, y (a) sigue siendo la unica.';
  assert.equal(hasOptionQuestion(t), false);
});

test('guardia falso-positivo: "(a)" pegado dentro de una URL no cuenta', () => {
  const t = 'segui el link http://board.local/act?task=T-1&note=(a)&verb=approved y (b) confirmalo aparte.';
  // solo (b) es un marcador real (limite de texto); el (a) de la URL esta pegado a "note=" y "&"
  assert.deepEqual(extractOptionMarkers(t), ['b']);
  assert.equal(hasOptionQuestion(t), false);
});

test('guardia falso-positivo: "(a)" pegado a un identificador de codigo no cuenta', () => {
  const t = 'la funcion task(a)bort no es una opcion, y (b) tampoco alcanza solo.';
  assert.deepEqual(extractOptionMarkers(t), ['b']);
  assert.equal(hasOptionQuestion(t), false);
});

test('texto vacio o no-string no explota', () => {
  assert.equal(hasOptionQuestion(''), false);
  assert.equal(hasOptionQuestion(null), false);
  assert.equal(hasOptionQuestion(undefined), false);
  assert.deepEqual(extractOptionMarkers(null), []);
});

test('caso real T-0418 (medido 2026-09-20): 2 opciones detectadas', () => {
  const t = 'El piloto esta construido y revisado; no esta activado. (a) aplicar con la ventana y el '
    + 'rollback que digas, o (b) dejarlo pausado. Sin (a) los AC2 y AC3 no cierran nunca.';
  assert.equal(hasOptionQuestion(t), true);
  assert.deepEqual(extractOptionMarkers(t), ['a', 'b']);
});
