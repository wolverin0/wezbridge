'use strict';
require('../setup.cjs');
const wez = require('../../src/wezterm.cjs');
const MUX = 'C:/fixture/sock';
const GUI = 'C:/fixture/gui-sock-2';
const row = (id, cursor) => ({ pane_id: id, cwd: 'file:///G:/fixture/wezbridge', title: 'Claude Code',
  tab_title: 'wezbridge', cursor_x: cursor, cursor_y: 2, size: { rows: 40, cols: 120 } });
const mode = process.env.CENSUS_ROUTING_MODE;
const groups = [{ socket: GUI, panes: [row(2, 19)] },
  ...(mode === 'missing-mux' ? [] : [{ socket: MUX, panes: mode === 'two-real' ? [row(94, 3), row(104, 3)] : [row(94, 3)] }])];
require.cache[require.resolve('../../src/wezterm.cjs')].exports = { ...wez,
  currentSocket: () => MUX,
  listSockets: () => groups,
  listPanes: () => groups.find((group) => group.socket === MUX)?.panes || [],
  getFullText: (_id, _lines, options) => {
    process.send?.({ t: 'probe', socket: options?.socket });
    return 'Claude Code\nModel: test\ncwd: G:/fixture/wezbridge\n\u276f';
  },
};
