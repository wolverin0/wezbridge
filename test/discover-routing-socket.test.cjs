'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const discovery = require('../src/pane-discovery.cjs');
const { resolve } = require('../src/pane-identity.cjs');
const MUX = 'C:/fixture/sock';
const GUI = 'C:/fixture/gui-sock-125232';

function fixture(groups, socket = MUX) {
  const reads = [];
  return { reads, currentSocket: () => socket, listSockets: () => groups,
    getFullText: (id, lines, options) => {
      reads.push(options.socket);
      return 'Claude Code\nModel: Fable\ncwd: G:/projects/infra\n\u276f';
    },
  };
}
const pane = (id, x) => ({ pane_id: id, cwd: 'file:///G:/projects/infra',
  title: 'Claude Code', tab_title: 'infra', cursor: { x, y: 4 }, size: { rows: 40, cols: 120 } });
const resolveInfra = rows => resolve('infra', rows.map(p => ({ pane_id: p.paneId, cwd: p.project, tab_title: p.tabTitle })));

test('routing killer: two sockets with changed cursor resolve only the transport mux pane', () => {
  const wez = fixture([{ socket: GUI, panes: [pane(2, 12)] }, { socket: MUX, panes: [pane(9, 3)] }]);
  const rows = discovery.discoverRoutingPanes({ wez });
  assert.deepEqual(rows.map(p => p.paneId), [9]);
  assert.deepEqual(resolveInfra(rows).ambiguous, []);
  assert.deepEqual(wez.reads, [MUX], 'never read a foreign socket while routing');
});

test('two actual panes in the transport socket stay ambiguous', () => {
  const rows = discovery.discoverRoutingPanes({ wez: fixture([{ socket: MUX, panes: [pane(9, 3), pane(19, 3)] }]) });
  assert.deepEqual(resolveInfra(rows).ambiguous, [9, 19]);
});

test('an unanswered transport socket never falls back to foreign numeric IDs', () => {
  const wez = fixture([{ socket: GUI, panes: [pane(2, 3)] }]);
  assert.deepEqual(discovery.discoverRoutingPanes({ wez }), []);
  assert.deepEqual(wez.reads, []);
});

test('a GUI selected by the transport remains usable on GUI-only installations', () => {
  const wez = fixture([{ socket: GUI, panes: [pane(2, 3)] }], GUI);
  assert.equal(resolveInfra(discovery.discoverRoutingPanes({ wez })).paneId, 2);
});

test('A2A self/target resolution and queue drain use the routing census', () => {
  const mcp = fs.readFileSync(path.join(__dirname, '../src/mcp-server.cjs'), 'utf8');
  assert.match(mcp, /selfCensus = discovery\.discoverRoutingPanes\(/);
  assert.match(mcp, /mapped = discovery\.discoverRoutingPanes\(/);
  const drain = fs.readFileSync(path.join(__dirname, '../scripts/queue-drain.cjs'), 'utf8');
  assert.match(drain, /discoverPanes: discovery\.discoverRoutingPanes/);
});
