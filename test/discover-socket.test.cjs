'use strict';
/**
 * discover-socket.test.cjs — T-0281: discover_sessions publica pane_ids sin decir SOBRE QUE
 * SOCKET son validos, y con dos muxes vivos los espacios de id se solapan (medido 29-08 y hoy
 * 2026-09-01: GUI 29952 colgada con 12 panes en el mux 54196, GUI 109544 nueva con el pane 30).
 * El test SINTETIZA la condicion (doble de wezterm con dos sockets e ids solapados): no depende
 * de que el operador tenga dos GUIs abiertas para poder fallar. Exige ademas que cada pane venga
 * VERIFICADO: get-text contra SU socket con texto que nombre al proyecto atribuido; rc=0 a secas
 * no distingue (8 panes muertas con "claude didn't exit cleanly" dan rc=0 sin ser de nadie).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { discoverPanes, verifyPaneText } = require('../src/pane-discovery.cjs');

const BORDE = '─'.repeat(60);
const claudeText = (cwdWin) => [
  '● hice algo', BORDE, '❯', BORDE,
  '   Model: Fable 5.1  Thinking: high',
  '   Ctx Used: 16.0%  Context: [██░░░░░░░░░░░░░░] 156k/1.0M (16%)',
  `   cwd: ${cwdWin}  Reset: 2hr 9m  Session: 57.0%  Weekly: 11.0%`,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
const DEAD = 'claude didn\'t exit cleanly\n\n$ ';

/** Doble de wezterm: dos sockets vivos, ids que se solapan (el 4 existe en los dos, con proyectos distintos). */
function twoSocketDouble() {
  const A = 'C:/Users/x/.local/share/wezterm/gui-sock-29952';
  const B = 'C:/Users/x/.local/share/wezterm/gui-sock-109544';
  const panes = {
    [A]: [
      { pane_id: 0, title: 'bash', cwd: '', text: DEAD },
      { pane_id: 4, title: 'orch', cwd: 'file://PC/G:/Py Apps/wezbridge', text: claudeText('G:\\Py Apps\\wezbridge') },
      { pane_id: 9, title: 'wabot', cwd: 'file://PC/G:/Py Apps/whatsappbot-final', text: claudeText('G:\\Py Apps\\whatsappbot-final') },
      { pane_id: 12, title: 'fo', cwd: 'file://PC/G:/Py Apps/finalorchestra', text: claudeText('G:\\Py Apps\\memorymaster') }, // texto de OTRO proyecto
    ],
    [B]: [
      { pane_id: 4, title: 'brlite', cwd: 'file://PC/G:/Py Apps/brlite', text: claudeText('G:\\Py Apps\\brlite') },
      { pane_id: 30, title: 'recovery', cwd: 'file://PC/G:/Py Apps/wezbridge', text: claudeText('G:\\Py Apps\\wezbridge') },
    ],
  };
  const calls = [];
  return {
    calls,
    listSockets: () => Object.keys(panes).map((socket) => ({ socket, panes: panes[socket].map(({ text, ...p }) => p) })),
    listPanes: () => { throw new Error('con listSockets disponible, listPanes() a secas no debe usarse: no dice el socket'); },
    getFullText: (paneId, lines, opts = {}) => {
      calls.push({ paneId, socket: opts.socket || null });
      const row = (panes[opts.socket] || []).find((p) => p.pane_id === paneId);
      if (!row) throw new Error(`pane ${paneId} no existe en ${opts.socket}`);
      return row.text;
    },
  };
}

test('T-0281 AC2/AC3: con dos sockets vivos cada pane publica SU socket; el id 4 existe en los dos con proyectos distintos', () => {
  const wez = twoSocketDouble();
  const out = discoverPanes({ wez });
  assert.equal(out.length, 6, `esperaba 6 registros (4 + 2), vino ${out.length}`);
  for (const p of out) assert.ok(typeof p.socket === 'string' && p.socket.length > 0, `pane ${p.paneId} sin socket: ${JSON.stringify(p.socket)}`);
  const fours = out.filter((p) => p.paneId === 4);
  assert.equal(fours.length, 2);
  assert.notEqual(fours[0].socket, fours[1].socket, 'los dos id=4 deben venir con sockets distintos');
  assert.deepEqual(fours.map((p) => p.projectName).sort(), ['brlite', 'wezbridge']);
  // get-text se hizo contra el socket del pane, nunca contra "el" socket
  for (const c of wez.calls) assert.ok(c.socket, `get-text de pane ${c.paneId} sin socket`);
});

test('T-0281 AC1: verified = el texto del pane nombra al proyecto atribuido; rc=0 a secas no alcanza', () => {
  const out = discoverPanes({ wez: twoSocketDouble() });
  const by = (id, sock) => out.find((p) => p.paneId === id && p.socket.endsWith(sock));
  assert.equal(by(4, '29952').verified, true);
  assert.equal(by(4, '29952').verify, 'project-in-text');
  assert.equal(by(30, '109544').verified, true);
  const dead = by(0, '29952');
  assert.equal(dead.verified, false);
  assert.equal(dead.verify, 'dead-pane-text', 'una pane muerta con "didn\'t exit cleanly" NO se verifica aunque get-text de rc=0');
  const fo = by(12, '29952');
  assert.equal(fo.verified, false);
  assert.equal(fo.verify, 'text-mismatch', 'texto de memorymaster en una pane atribuida a finalorchestra: no verificada');
});

test('T-0281 AC1: verifyPaneText es pura y nombra por que', () => {
  assert.deepEqual(verifyPaneText({ projectName: 'wezbridge', text: claudeText('G:\\Py Apps\\wezbridge') }), { verified: true, verify: 'project-in-text' });
  assert.deepEqual(verifyPaneText({ projectName: 'wezbridge', text: DEAD }), { verified: false, verify: 'dead-pane-text' });
  assert.deepEqual(verifyPaneText({ projectName: 'wezbridge', text: claudeText('G:\\Py Apps\\brlite') }), { verified: false, verify: 'text-mismatch' });
  assert.deepEqual(verifyPaneText({ projectName: null, text: '$ ' }), { verified: false, verify: 'no-project' });
  assert.deepEqual(verifyPaneText({ projectName: 'wezbridge', text: '' }), { verified: false, verify: 'empty-text' });
});

test('T-0281: sin enumeracion de sockets (wez viejo) la salida lo DICE — socket null y verify socket-unknown, nunca un socket inventado', () => {
  const wez = {
    listPanes: () => [{ pane_id: 7, title: 't', cwd: 'file://PC/G:/Py Apps/wezbridge' }],
    getFullText: () => claudeText('G:\\Py Apps\\wezbridge'),
  };
  const out = discoverPanes({ wez });
  assert.equal(out.length, 1);
  assert.equal(out[0].socket, null);
  assert.equal(out[0].verified, false);
  assert.equal(out[0].verify, 'socket-unknown');
});

// ---------------------------------------------------------------------------
// El wrapper real: wezterm.cjs enumera sockets y get-text acepta el socket.
// Bajo el mock (test/setup.cjs) cada socket candidato responde con los panes del
// mock; lo que se prueba es la FORMA (socket por grupo, panes array) y que la
// discovery real ya no publica filas sin socket.
// ---------------------------------------------------------------------------
test('T-0281: wezterm.listSockets() devuelve grupos {socket, panes} y discoverPanes() real tagea cada fila', () => {
  const wez = require('../src/wezterm.cjs');
  assert.equal(typeof wez.listSockets, 'function');
  assert.equal(typeof wez.currentSocket, 'function');
  const groups = wez.listSockets();
  assert.ok(Array.isArray(groups));
  for (const g of groups) {
    assert.ok(typeof g.socket === 'string' && g.socket.length > 0);
    assert.ok(Array.isArray(g.panes));
  }
  if (groups.length) {
    const rows = discoverPanes();
    assert.ok(rows.length >= 1);
    for (const r of rows) assert.ok(typeof r.socket === 'string', `fila ${r.paneId} sin socket con enumeracion disponible`);
  }
});

// ---------------------------------------------------------------------------
// Dedupe (medido 2026-09-01 tras la restauracion): la GUI 109544 y el `sock` del mux
// sirven LOS MISMOS panes con ids distintos (30/46/53.. vs 2/9/11..): 19 filas para
// ~10 panes, y un `to_project` con dos filas del mismo proyecto se vuelve ambiguo.
// La misma pane (mismo cwd, titulo y texto) tiene que ser UNA fila, direccionada por
// el socket que el bridge usa para hablar (currentSocket), con `also_on` para el otro.
// ---------------------------------------------------------------------------
function samePaneTwoSocketsDouble() {
  const GUI = 'C:/Users/x/.local/share/wezterm/gui-sock-109544';
  const MUX = 'C:/Users/x/.local/share/wezterm/sock';
  const crm = { title: '✳ crm-disaster-recovery', cwd: 'file://PC/G:/Py Apps/crm', text: claudeText('G:\Py Apps\crm') };
  const rec = { title: 'recovery', cwd: 'file://PC/G:/Py Apps/wezbridge', text: claudeText('G:\Py Apps\wezbridge') };
  const panes = {
    [GUI]: [{ pane_id: 60, ...crm }, { pane_id: 30, ...rec }],
    [MUX]: [{ pane_id: 16, ...crm }],
  };
  return {
    currentSocket: () => GUI,
    listSockets: () => Object.keys(panes).map((socket) => ({ socket, panes: panes[socket].map(({ text, ...p }) => p) })),
    listPanes: () => { throw new Error('no'); },
    getFullText: (paneId, lines, opts = {}) => { const row = (panes[opts.socket] || []).find((p) => p.pane_id === paneId); if (!row) throw new Error('no pane'); return row.text; },
  };
}

test('T-0281 dedupe: la misma pane vista por dos sockets es UNA fila en el socket del bridge, con also_on para el otro', () => {
  const out = discoverPanes({ wez: samePaneTwoSocketsDouble() });
  const crm = out.filter((p) => p.projectName === 'crm');
  assert.equal(crm.length, 1, `crm debe ser una sola fila, vinieron ${crm.length}`);
  assert.equal(crm[0].paneId, 60, 'se conserva el id del socket con el que el bridge habla (currentSocket)');
  assert.ok(crm[0].socket.endsWith('gui-sock-109544'));
  assert.deepEqual(crm[0].also_on, [{ socket: 'C:/Users/x/.local/share/wezterm/sock', paneId: 16 }]);
  const rec = out.filter((p) => p.projectName === 'wezbridge');
  assert.equal(rec.length, 1);
  assert.equal(rec[0].also_on, undefined, 'una pane vista por un solo socket no lleva also_on');
  assert.equal(out.length, 2);
});
