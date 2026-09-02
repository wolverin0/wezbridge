'use strict';
/**
 * T-0260 AC3 (2026-09-02): discover_sessions publica UN pane_id por pane real, y
 * es el del MUX. Con el mux como socket canonico (currentSocket), la misma pane
 * vista tambien por una GUI queda como also_on; una pane que solo vive en una
 * GUI se conserva pero marcada gui_only: su id no es del espacio canonico.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { discoverPanes } = require('../src/pane-discovery.cjs');

const MUX = 'C:/u/.local/share/wezterm/sock';
const GUI = 'C:/u/.local/share/wezterm/gui-sock-93436';

function claudeText(cwdWin) {
  return [
    '❯ ',
    '   Model: Fable 5.1  Thinking: high',
    '   Ctx Used: 16.0%  Context: [██░░░░░░░░░░░░░░] 156k/1.0M (16%)',
    `   cwd: ${cwdWin}  Reset: 2hr 9m  Session: 57.0%  Weekly: 11.0%`,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
}

/** 3 panes reales: dos vistos por los dos sockets (ids distintos), uno solo en la GUI. */
function fixture() {
  const mk = (project, pane_id, cursor_y, extra = {}) => ({
    pane_id, title: '◐ ' + project, tab_title: project, cursor_x: 0, cursor_y, size: { rows: 50, cols: 200 },
    cwd: `file://PC/G:/Py Apps/${project}`, text: claudeText(`G:/Py Apps/${project}`), ...extra,
  });
  const panes = {
    [MUX]: [mk('wezbridge', 2, 10), mk('infra', 9, 20)],
    [GUI]: [mk('wezbridge', 1, 10), mk('infra', 2, 20), mk('scratch', 7, 33)],
  };
  return {
    currentSocket: () => MUX,
    listSockets: () => Object.keys(panes).map((socket) => ({ socket, panes: panes[socket].map(({ text, ...p }) => p) })),
    listPanes: () => { throw new Error('con listSockets disponible no se usa listPanes()'); },
    getFullText: (paneId, _lines, opts = {}) => {
      const r = (panes[opts.socket] || []).find((p) => p.pane_id === paneId);
      if (!r) throw new Error(`pane ${paneId} no existe en ${opts.socket}`);
      return r.text;
    },
  };
}

test('AC3: 5 filas crudas (2 sockets) => 3 panes, ids del MUX, GUI solo en also_on', () => {
  const out = discoverPanes({ wez: fixture() });
  assert.equal(out.length, 3, `esperaba 3 panes reales, vinieron ${out.map((p) => p.projectName + ':' + p.paneId).join(',')}`);
  const wb = out.find((p) => p.projectName === 'wezbridge');
  const inf = out.find((p) => p.projectName === 'infra');
  assert.equal(wb.paneId, 2, 'wezbridge publica el id del mux (2), no el de la GUI (1)');
  assert.equal(wb.socket, MUX);
  assert.deepEqual(wb.also_on, [{ socket: GUI, paneId: 1 }]);
  assert.equal(inf.paneId, 9, 'infra publica 9 (mux): el 2 de la GUI colisiona con wezbridge en el mux — justo el misroute de hoy');
  assert.deepEqual(inf.also_on, [{ socket: GUI, paneId: 2 }]);
  assert.equal(wb.gui_only, undefined);
});

test('AC3: una pane que solo existe en la GUI se conserva y se marca gui_only', () => {
  const out = discoverPanes({ wez: fixture() });
  const sc = out.find((p) => p.projectName === 'scratch');
  assert.ok(sc, 'la pane gui-only no se pierde');
  assert.equal(sc.paneId, 7);
  assert.equal(sc.gui_only, true, 'su id no es del espacio canonico y la fila lo dice');
  assert.equal(sc.also_on, undefined);
});

test('control: con la GUI como canonica (escape hatch) el id publicado es el de la GUI y nada es gui_only', () => {
  const wez = fixture();
  wez.currentSocket = () => GUI;
  const out = discoverPanes({ wez });
  const wb = out.find((p) => p.projectName === 'wezbridge');
  assert.equal(wb.paneId, 1);
  assert.ok(out.every((p) => p.gui_only === undefined), 'gui_only solo tiene sentido cuando el mux es el canonico');
});
