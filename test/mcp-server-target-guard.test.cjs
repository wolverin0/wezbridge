'use strict';
/**
 * mcp-server-target-guard.test.cjs — T-0281 AC3/AC4 en la superficie MCP real (subproceso
 * JSON-RPC + wezterm mock): discover_sessions publica por fila socket/verified/verify y arriba
 * sockets/unverified; las tools que MUTAN por pane_id (send_prompt, send_key, kill_session,
 * set_tab_title) rehusan un id que el mux vivo no lista, y read_output sigue fail-open.
 * Escape WEZBRIDGE_TARGET_GUARD=off documentado y probado. Un censo mudo no condena (mm-c03b):
 * eso lo cubre el test unitario de pane-discovery, aca el mock siempre responde.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.cjs');

function callTool(name, args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      try { resolve(JSON.parse(stdout.slice(0, nl).trim())); } catch (err) { reject(new Error(`invalid JSON: ${err.message}; stdout=${stdout}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}
const textOf = (res) => res.result.content[0].text;

test('T-0281 AC3: discover_sessions publica socket/verified/verify por fila y sockets/unverified arriba', async () => {
  const res = await callTool('discover_sessions', { only_claude: false });
  const out = JSON.parse(textOf(res));
  assert.ok(out.sessions.length >= 1, 'el mock lista al menos un pane');
  for (const row of out.sessions) {
    assert.ok('socket' in row, `fila sin campo socket: ${JSON.stringify(row)}`);
    assert.equal(typeof row.verified, 'boolean');
    assert.equal(typeof row.verify, 'string');
  }
  assert.equal(typeof out.sockets, 'object');
  assert.equal(typeof out.unverified, 'number');
  if (out.unverified > 0) assert.match(out.unverified_note, /direcciona por proyecto/);
});

test('T-0281 AC4: send_prompt/send_key/kill_session/set_tab_title rehusan un pane_id que el mux no lista, nombrando los ids vivos', async () => {
  const cases = [
    ['send_prompt', { pane_id: 9871, text: 'hola' }],
    ['send_key', { pane_id: 9871, key: 'enter' }],
    ['kill_session', { pane_id: 9871 }],
    ['set_tab_title', { pane_id: 9871, title: 'x' }],
  ];
  for (const [tool, args] of cases) {
    const res = await callTool(tool, args);
    assert.equal(res.result.isError, true, `${tool} no rehuso: ${textOf(res).slice(0, 120)}`);
    assert.match(textOf(res), /target-guard: .* pane 9871 no existe en el mux vivo \(ids: /, tool);
  }
});

test('T-0281 AC4: un id que SI esta en el censo pasa el guard (set_tab_title sobre el pane 1 del mock)', async () => {
  const res = await callTool('set_tab_title', { pane_id: 1, title: 'guard-ok' });
  assert.notEqual(res.result.isError, true, textOf(res));
  assert.match(textOf(res), /tab title set/);
});

test('T-0281 AC4: read_output queda fail-open (leer no daña) y WEZBRIDGE_TARGET_GUARD=off desarma el guard', async () => {
  const ro = await callTool('read_output', { pane_id: 9871, lines: 5 });
  assert.doesNotMatch(textOf(ro), /target-guard/);
  const off = await callTool('set_tab_title', { pane_id: 9871, title: 'x' }, { WEZBRIDGE_TARGET_GUARD: 'off' });
  assert.doesNotMatch(textOf(off), /target-guard/);
});
