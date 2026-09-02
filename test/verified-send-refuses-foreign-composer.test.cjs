'use strict';
/**
 * T-0323 (2026-09-02) — el guard de composer AJENO vive en la PRIMITIVA.
 * Incidente real: un llamador directo (node, sin el wrapper del MCP) llamo
 * sendPromptDeferredEnter(13, sobre) con una frase del operador sin enviar en
 * el composer de finalorchestra; la primitiva pego el sobre detras y el Enter
 * diferido submiteo el hibrido. El guard (T-0242/AC6) existia pero solo lo
 * consultaba project-queue; todo otro llamador heredaba el agujero.
 *  AC1 con texto ajeno: la primitiva devuelve {refused:'composer-foreign-text', held}
 *      y NO toca el pane (ni paste ni Enter). Fail-first: antes escribia y submiteaba.
 *  AC2 sendTextBracketed/sendText no cambian; una sola deteccion (composerHoldsForeignText).
 *  AC3 force:true + why pisa a proposito y queda en action-log como composer-override con el texto.
 *  AC4 composer vacio o con placeholder NO rehusa (control: el guard que difiere siempre paraliza al fleet).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vs = require('../src/verified-send.cjs');

const BORDE = '─'.repeat(70);
/** fixtures reales (composer-foreign-text-guard.test.cjs, 2026-08-28) */
const HOLDING = [BORDE, '❯ la verdad me mata tener 2 dashboard,', BORDE].join('\n');
const EMPTY = ['❯ /model', BORDE, '❯', BORDE].join('\n');
const PLACEHOLDER_CODEX = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol high · Ready'].join('\n');

function fakeWez(tail) {
  const calls = [];
  return {
    calls,
    invalidateGetTextCache() {},
    getFullText() { return tail; },
    sendTextBracketed(pane, text) { calls.push(['sendTextBracketed', pane, text]); },
    sendTextNoEnter(pane, text) { calls.push(['sendTextNoEnter', pane, text]); },
    sendText(pane, text) { calls.push(['sendText', pane, text]); },
  };
}
function make(tail) {
  const wez = fakeWez(tail);
  const logged = [];
  const api = vs.createVerifiedSend({ wez, sleep: async () => {}, logAction: (action, meta) => logged.push({ action, ...meta }) });
  return { wez, logged, api };
}

test('AC1 fail-first: composer con texto del operador => {refused, held} y CERO escrituras al pane (ni paste ni Enter)', async () => {
  const { wez, api } = make(HOLDING);
  const r = await api.sendPromptDeferredEnter(13, '[A2A from pane-2 to finalorchestra | corr=x | type=request]\nsobre');
  assert.equal(typeof r, 'object', 'antes devolvia un string de integridad tras escribir: el sobre ya estaba pegado detras del texto del operador');
  assert.equal(r.refused, vs.REFUSED_COMPOSER_FOREIGN_TEXT);
  assert.equal(r.held, 'la verdad me mata tener 2 dashboard,');
  assert.equal(r.pane, 13);
  assert.deepEqual(wez.calls, [], 'un Enter sobre texto ajeno LO MANDA: el pane no se toca en absoluto');
  assert.equal(vs.isRefusal(r), true);
  assert.equal(vs.classifyDelivery(r, 'unknown'), 'unverified', 'un rechazo nunca cuenta como entrega');
});

test('AC4 control: composer VACIO y placeholder de codex => SE ENTREGA (paste + Enter), retorno string de integridad', async () => {
  for (const [name, tail] of [['vacio', EMPTY], ['placeholder codex', PLACEHOLDER_CODEX]]) {
    const { wez, api } = make(tail);
    const r = await api.sendPromptDeferredEnter(7, 'hola mundo, sobre corto');
    assert.equal(typeof r, 'string', `${name}: rehusar aca paralizaria al fleet`);
    assert.deepEqual(wez.calls.map((c) => c[0]), ['sendTextBracketed', 'sendTextNoEnter'], `${name}: dos fases, paste y Enter separado`);
    assert.equal(vs.isRefusal(r), false);
  }
});

test('AC3 force:true + why pisa a proposito, escribe, y queda en action-log como composer-override con el texto pisado', async () => {
  const { wez, logged, api } = make(HOLDING);
  const r = await api.sendPromptDeferredEnter(13, 'sobre urgente', { force: true, why: 'drill T-0323: el operador autorizo pisar' });
  assert.equal(typeof r, 'string');
  assert.deepEqual(wez.calls.map((c) => c[0]), ['sendTextBracketed', 'sendTextNoEnter']);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, 'composer-override');
  assert.equal(logged[0].target, 'pane-13');
  assert.equal(logged[0].why, 'drill T-0323: el operador autorizo pisar');
  assert.equal(logged[0].extra.held, 'la verdad me mata tener 2 dashboard,', 'lo pisado queda escrito: es lo unico que permite reconstruir que se perdio');
});

test('AC3 force:true SIN why se rechaza (tira) y no toca el pane; force sobre composer limpio no loguea nada', async () => {
  const held = make(HOLDING);
  await assert.rejects(() => held.api.sendPromptDeferredEnter(13, 'x', { force: true }), /requires a why/);
  assert.deepEqual(held.wez.calls, []);
  const clean = make(EMPTY);
  await clean.api.sendPromptDeferredEnter(7, 'sobre normal', { force: true, why: 'no hace falta' });
  assert.equal(clean.logged.length, 0, 'override solo se audita cuando efectivamente piso algo');
});

test('AC2 una sola deteccion: paneComposerHoldsForeignText y la primitiva coinciden sobre las 3 fixtures; las primitivas de transporte del fake se llaman con el texto intacto', async () => {
  for (const [tail, expected] of [[HOLDING, true], [EMPTY, false], [PLACEHOLDER_CODEX, false]]) {
    const { api } = make(tail);
    assert.equal(api.paneComposerHoldsForeignText(1), expected);
    const r = await api.sendPromptDeferredEnter(1, 'texto de prueba largo para integridad');
    assert.equal(vs.isRefusal(r), expected);
  }
  const { wez, api } = make(EMPTY);
  await api.sendPromptDeferredEnter(1, 'linea 1\nlinea 2');
  assert.deepEqual(wez.calls[0], ['sendTextBracketed', 1, 'linea 1\nlinea 2'], 'el cuerpo viaja entero por bracketed paste, sin cambios');
  assert.deepEqual(wez.calls[1], ['sendTextNoEnter', 1, '\r']);
});
