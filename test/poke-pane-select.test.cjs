'use strict';
/**
 * T-0260 item 3 (2026-09-02): poke-pane elige el pane con --tab-title EXACTO
 * (case-insensitive, sin substring) y prefiere el espacio del mux. Antes era
 * `includes`: "infra" matcheaba "infra-old" y "myinfra", y con dos GUIs vivas
 * la misma pane aparecia dos veces con ids distintos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { selectPane } = require('../scripts/poke-pane.cjs');

const MUX = { WEZTERM_UNIX_SOCKET: 'C:/u/.local/share/wezterm/sock', _space: 'mux' };
const GUI = { WEZTERM_UNIX_SOCKET: 'C:/u/.local/share/wezterm/gui-sock-93436', _space: 'gui' };
const row = (pane_id, tab_title, cwd, env) => ({ pane_id, tab_title, title: 'x', cwd: `file://PC/G:/Py Apps/${cwd}`, window_id: 0, tab_id: pane_id, _socketEnv: env });

test('AC4: --tab-title es EXACTO: "infra" no matchea "infra-old" ni "myinfra"', () => {
  const list = [row(9, 'infra', 'infra', MUX), row(10, 'infra-old', 'infra', MUX), row(12, 'myinfra', 'infra', MUX)];
  const { matches, space } = selectPane(list, { tabTitle: 'infra' });
  assert.deepEqual(matches.map((m) => m.pane_id), [9]);
  assert.equal(space, 'mux');
  assert.equal(selectPane(list, { tabTitle: 'infr' }).matches.length, 0, 'un prefijo no es un nombre');
  assert.equal(selectPane(list, { tabTitle: 'INFRA' }).matches.length, 1, 'case-insensitive, si');
  assert.equal(selectPane(list, { tabTitle: ' infra ' }).matches.length, 1, 'espacios alrededor se ignoran');
});

test('AC4: dos panes con el MISMO tab_title son ambiguos: se devuelven los dos, nunca el primero', () => {
  const list = [row(9, 'infra', 'infra', MUX), row(11, 'infra', 'whatsappbot-final', MUX)];
  const { matches } = selectPane(list, { tabTitle: 'infra' });
  assert.deepEqual(matches.map((m) => m.pane_id), [9, 11]);
});

test('AC3 (poke-pane): la misma pane vista en mux y GUI cuenta UNA vez, con el id del mux', () => {
  const list = [row(11, 'wabot', 'whatsappbot-final', MUX), row(4, 'wabot', 'whatsappbot-final', GUI)];
  const { matches, space } = selectPane(list, { project: 'whatsappbot-final' });
  assert.deepEqual(matches.map((m) => m.pane_id), [11], 'el id publicado es el del mux, nunca el de la GUI');
  assert.equal(space, 'mux');
});

test('AC3 (poke-pane): una pane que SOLO existe en la GUI se alcanza igual, y la salida lo dice (gui-only)', () => {
  const list = [row(11, 'wabot', 'whatsappbot-final', MUX), row(7, 'scratch', 'scratch', GUI)];
  const { matches, space } = selectPane(list, { project: 'scratch' });
  assert.deepEqual(matches.map((m) => m.pane_id), [7]);
  assert.equal(space, 'gui-only');
});

test('--project sigue siendo igualdad exacta del basename del cwd', () => {
  const list = [row(9, 'infra', 'infra', MUX), row(2, 'wezbridge', 'wezbridge', MUX)];
  assert.equal(selectPane(list, { project: 'wez' }).matches.length, 0);
  assert.equal(selectPane(list, { project: 'wezbridge' }).matches[0].pane_id, 2);
});
