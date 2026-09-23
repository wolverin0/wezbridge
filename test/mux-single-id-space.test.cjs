'use strict';
/**
 * T-0260 opcion C (2026-09-02) — UN solo espacio de pane_id: el del mux.
 *
 * MEDIDO antes de escribir esto: el mismo pane es 11 en `sock` (mux) y 4 en
 * `gui-sock-93436`; la GUI se reemplazo 17+ veces en un dia (watchdog) y cada
 * vez estrena numeracion; `--prefer-mux` SOLO no alcanza: con
 * WEZTERM_UNIX_SOCKET apuntando a un gui-sock, `wezterm cli --prefer-mux list`
 * sigue listando la numeracion de la GUI (1..10), y sin ese env lista el mux
 * (2,9,..17). O sea que la regla es DOBLE: socket del mux + --prefer-mux, en
 * TODAS las invocaciones, sin excepcion suelta.
 *
 * AC1: ninguna invocacion de `wezterm cli` en src/ o scripts/ sin --prefer-mux.
 * AC5: spawn/split pasan por el mismo helper (no arman arrays a mano).
 * Ademas: buildCliInvocation por defecto fija el socket del mux aunque el env
 * del proceso traiga un gui-sock, y currentSocket() es el mux.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function cliArrayLiterals(src) {
  // Arrays que arrancan en 'cli' (con o sin spread al frente). Deliberadamente
  // angosto: un guard que dispara sobre codigo correcto ensena a esquivarlo.
  const re = /\[\s*(?:\.\.\.\w+,\s*)?'cli',([^\]]*)\]/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, body: m[1] });
  }
  return out;
}

test('AC1: toda invocacion `wezterm cli` en src/ y scripts/ lleva --prefer-mux', () => {
  const culpables = [];
  for (const dir of ['src', 'scripts']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.cjs'))) {
      const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      for (const lit of cliArrayLiterals(src)) {
        if (!/'--prefer-mux'/.test(lit.body)) culpables.push(`${dir}/${f}:${lit.line}`);
      }
    }
  }
  assert.deepEqual(culpables, [], 'invocaciones sin --prefer-mux (otro espacio de ids):\n  ' + culpables.join('\n  '));
});

// T-0400: era un chequeo de texto — buscaba `buildCliInvocation(`/`wezCmd(`
// como substring DENTRO del cuerpo de la funcion. Un `if (false)` alrededor
// de la linea que arma el array cli (dejando `wezCmd(cmdArgs)` viva mas abajo,
// intacta) deja pasar el regex igual: el texto sigue estando, la RUTA que
// realmente se ejecuta puede haber cambiado. Reescrito para invocar
// spawnPane/splitHorizontal DE VERDAD contra el mock (test/mocks/wezterm-mock.cjs,
// vivo via NODE_OPTIONS/setup.cjs) y leer el argv REAL que llego al binario
// (WEZBRIDGE_MOCK_ARGV_LOG) — si alguna de las dos arma un array cli a mano en
// vez de pasar por wezCmd/buildCliInvocation, --prefer-mux (que SOLO vive en
// CLI_BASE, usado por buildCliInvocation) no aparece ahi, y el test lo ve.
test('AC5 (real): spawnPane y splitHorizontal invocan wezterm cli CON --prefer-mux — la unica forma de llegar ahi es via wezCmd/buildCliInvocation, no un array propio', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mux-argvlog-'));
  const logFile = path.join(logDir, 'argv.log');
  const prevLog = process.env.WEZBRIDGE_MOCK_ARGV_LOG;
  process.env.WEZBRIDGE_MOCK_ARGV_LOG = logFile;
  try {
    // wezterm.cjs caches its own module state (listPanes TTL) but not the CLI
    // binary path itself — WEZTERM is resolved once at require-time from
    // WEZBRIDGE_WEZTERM_BIN, already the mock via test/setup.cjs.
    const w = require('../src/wezterm.cjs');
    w.spawnPane({ cwd: '/tmp', program: 'node', capExempt: true });
    w.splitHorizontal(1, { cwd: '/tmp', program: 'node', capExempt: true });
  } finally {
    if (prevLog === undefined) delete process.env.WEZBRIDGE_MOCK_ARGV_LOG; else process.env.WEZBRIDGE_MOCK_ARGV_LOG = prevLog;
  }
  const invocations = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawnOrSplit = invocations.filter((argv) => argv.includes('spawn') || argv.includes('split-pane'));
  assert.ok(spawnOrSplit.length >= 2, `spawnPane and splitHorizontal must each shell out to wezterm cli, saw: ${JSON.stringify(invocations)}`);
  for (const argv of spawnOrSplit) {
    assert.ok(argv.includes('--prefer-mux'), `an invocation reaching wezterm had no --prefer-mux (hand-rolled cli array, bypassing buildCliInvocation): ${argv.join(' ')}`);
  }
});

test('buildCliInvocation por defecto: socket del MUX + --prefer-mux, aunque el env traiga un gui-sock', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mux-'));
  const wz = path.join(home, '.local', 'share', 'wezterm');
  fs.mkdirSync(wz, { recursive: true });
  fs.writeFileSync(path.join(wz, 'sock'), '');
  fs.writeFileSync(path.join(wz, 'gui-sock-99999'), '');
  const script = `
    const w = require(${JSON.stringify(path.join(ROOT, 'src', 'wezterm.cjs'))});
    const inv = w.buildCliInvocation(['list']);
    console.log(JSON.stringify({ cliArgs: inv.cliArgs, sock: inv.env.WEZTERM_UNIX_SOCKET || null, pane: inv.env.WEZTERM_PANE || null, current: w.currentSocket() }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, WEZTERM_UNIX_SOCKET: path.join(wz, 'gui-sock-99999'), WEZTERM_PANE: '4', WEZBRIDGE_PREFER_MUX: '' },
  }).trim());
  assert.ok(out.cliArgs.includes('--prefer-mux'), `sin --prefer-mux: ${out.cliArgs.join(' ')}`);
  assert.ok(out.cliArgs.includes('--no-auto-start'));
  assert.equal(path.basename(out.sock || ''), 'sock', `el socket tiene que ser el del mux, vino ${out.sock}`);
  assert.equal(out.pane, null, 'WEZTERM_PANE del proceso no se hereda: es un id del OTRO espacio');
  assert.equal(path.basename(out.current), 'sock', `currentSocket() tiene que ser el mux, vino ${out.current}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('AC2 (vivo, se salta sin wezterm): listPanes() publica los MISMOS ids que `wezterm cli --prefer-mux list` sin env', (t) => {
  if (process.platform !== 'win32') return t.skip('solo mide en la workstation');
  const w = require('../src/wezterm.cjs');
  let real;
  try {
    const env = { ...process.env }; delete env.WEZTERM_UNIX_SOCKET; delete env.WEZTERM_PANE;
    real = JSON.parse(execFileSync(w.WEZTERM || 'wezterm', ['cli', '--prefer-mux', '--no-auto-start', 'list', '--format', 'json'], { encoding: 'utf8', timeout: 10000, env, windowsHide: true }));
  } catch (e) { return t.skip('wezterm no disponible: ' + String(e.message).split('\n')[0]); }
  if (!Array.isArray(real) || !real.length) return t.skip('sin panes vivos');
  const ours = w.listPanes().map((p) => Number(p.pane_id)).sort((a, b) => a - b);
  const theirs = real.map((p) => Number(p.pane_id)).sort((a, b) => a - b);
  assert.deepEqual(ours, theirs, 'listPanes() habla con otro espacio de ids que el mux');
});
