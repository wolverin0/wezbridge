'use strict';
/**
 * T-0303 (2026-09-02) — poke-pane fragmentaba sobres multi-linea en N prompts y
 * los declaraba VERIFIED. Reproducido en vivo contra un doble de TUI en un pane
 * real de wezterm (test/fixtures/tui-double.cjs):
 *   payload de 3 lineas + poke-pane de HEAD~ => 4 prompts ("[submitted #1..#4]",
 *   el 4to vacio) y `exit 0 — VERIFIED (composer cleared)`.
 * Medido ademas: en Windows/ConPTY wezterm no envuelve el paste en marcadores
 * bracketed y los bytes llegan IGUAL con o sin --no-paste (un chunk); que eso
 * sea un prompt o N depende de la heuristica de rafaga del TUI. Por eso la
 * entrega es UNA LINEA en el cable (saltos -> " ⏎ ", declarado en el log).
 *
 *  Parte 1 (unit, siempre corre): composer-state.cjs ve la COLA, un fragmento
 *    corto y una linea con borde derecho — los tres eran invisibles para la
 *    copia vieja (solo cabeza) — y pasteLandedIntact distingue intacto /
 *    colapsado / fragmentado / vacio. Un envio fragmentado no puede terminar
 *    en exit 0: el veredicto 'fragmented' mapea a die(9) en poke-pane.
 *  Parte 2 (live, se salta sin wezterm): un pane real con el doble en modo
 *    ESTRICTO (cada salto = Enter, como un TUI sin bracketed paste) recibe un
 *    payload de 3 lineas por poke-pane y submitea EXACTAMENTE UN prompt con
 *    las 3 lineas; el composer queda vacio; exit 0.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { composerStillHolds, pasteLandedIntact, composerContent } = require('../scripts/composer-state.cjs');

const B = '─'.repeat(70);
const PAYLOAD = '[A2A from pane-2 to pane-33 | corr=T-0276 | type=request]\nRevisa el result y confirma el cierre; no hagas nada mas.\nCriterios: (1) test verde (2) doc actualizada (3) sin cambios fuera de docs. Result esperado en _intel/results/T-0276.md';
const box = (...lines) => [B, ...lines, B].join('\n');

// ---------------------------------------------------------------- Parte 1: unit
test('AC2 fail-first: el composer con la COLA del payload (con borde derecho) y con un fragmento corto se detecta como retenido', () => {
  // Los tres casos que la copia vieja (poke-pane.cjs, solo cabeza) devolvia false. Medido 21:1xZ.
  assert.equal(composerStillHolds(box('│ ❯ Result esperado en _intel/results/T-0276.md                      │'), PAYLOAD), true, 'cola con borde derecho');
  assert.equal(composerStillHolds(box('❯ docs.'), PAYLOAD), true, 'fragmento corto (< 8 chars) de la cola');
  assert.equal(composerStillHolds(box('❯ Result esperado en _intel/results/T-0276.md'), PAYLOAD), true, 'cola limpia');
  assert.equal(composerStillHolds(box('❯ [A2A from pane-2 to pane-33 | corr=T-0276 | type=request]'), PAYLOAD), true, 'cabeza (lo que ya veia)');
  assert.equal(composerStillHolds(box('❯ [Pasted text #1 +3 lines]'), PAYLOAD), true, 'paste colapsado');
});

test('AC2 control (el otro sentido): composer vacio, placeholder o texto AJENO NO cuentan como "mi payload retenido"', () => {
  assert.equal(composerStillHolds(box('❯'), PAYLOAD), false, 'vacio => entregado');
  assert.equal(composerStillHolds(['', '› Ask Codex to do anything', ''].join('\n'), PAYLOAD), false, 'placeholder de codex');
  assert.equal(composerStillHolds(box('❯ la verdad me mata tener 2 dashboard,'), PAYLOAD), false, 'texto del operador no es mi payload');
  assert.equal(composerStillHolds('', PAYLOAD), false);
});

test('AC4 pasteLandedIntact: cabeza => intact, colapsado => collapsed, otra linea del payload o texto ajeno => fragmented, sin composer => empty', () => {
  assert.equal(pasteLandedIntact(box('❯ [A2A from pane-2 to pane-33 | corr=T-0276 | type=request]'), PAYLOAD), 'intact');
  assert.equal(pasteLandedIntact(box('❯ [A2A from pane-2 to pane-33 | corr=T-02'), PAYLOAD), 'intact', 'cabeza truncada por el ancho');
  assert.equal(pasteLandedIntact(box('❯ [Pasted text #1 +3 lines]'), PAYLOAD), 'collapsed');
  assert.equal(pasteLandedIntact(box('❯ Criterios: (1) test verde (2) doc actualizada (3) sin cambios fuera de docs. Result esperado en _intel/results/T-0276.md'), PAYLOAD), 'fragmented', 'la ULTIMA linea sola en el composer = las anteriores ya se submitearon');
  assert.equal(pasteLandedIntact(box('❯ la verdad me mata tener 2 dashboard,'), PAYLOAD), 'fragmented', 'texto ajeno delante: Enter lo hibridaria');
  assert.equal(pasteLandedIntact('C:\\Users\\x> ', PAYLOAD), 'empty', 'shell sin marcador: no se afirma nada');
  assert.equal(composerContent(box('│ ❯ hola   │')), 'hola', 'bordes de los dos lados fuera');
});

// T-0400: era un chequeo de fuente (regex sobre el bloque `if (landed ===
// 'fragmented')` + comparacion de indices contra el Enter). Un `if (false)`
// alrededor del `die(9, ...)` real deja ambos literales en su mismo lugar del
// archivo — el regex y la comparacion de indices siguen viendo el texto,
// aunque el guard nunca corra. Reescrito para invocar poke-pane.cjs DE VERDAD
// contra test/mocks/wezterm-fragmented-mock.cjs (el unico doble de este repo
// cuyo get-text, DESPUES del paste, muestra un composer con texto que NO es
// la cabeza del payload — el mock estatico de setup.cjs jamas produce
// 'fragmented': su get-text es constante y sin marcador de composer) y
// asertar sobre el exit code y el log reales.
// T-0473: entre el chequeo y el die(9) ahora vive el self-clean del residuo
// (Ctrl+C + verificacion de ownership) — el fragmento del mock ("unrelated
// leftover fragment") NO es un tail de `payload`, asi que composerStillHolds
// lo rechaza y la corrida real cae por la rama "left untouched" SIN mandar
// Ctrl+C ni Enter; se asertan ambos hechos reales (log real, no grep de
// fuente) en vez de solo el exit code.
test('AC4 (real): poke-pane mapea fragmented -> exit 9 y nunca a 0; Enter nunca se manda y el residuo ajeno queda intocado', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-frag-state-'));
  const intelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-frag-intel-'));
  try {
    const r = spawnSync(process.execPath, [POKE, '--tab-title', 'wb-frag-test', '--text', 'linea uno\nlinea dos\nlinea tres'], {
      env: {
        ...process.env,
        WEZTERM_BIN: path.join(REPO, 'test', 'mocks', 'wezterm-fragmented-mock.cjs'),
        WEZBRIDGE_MOCK_STATE: path.join(stateDir, 'state.json'),
        WEZBRIDGE_INTEL_DIR: intelDir,
      },
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 9, `poke-pane exit ${r.status}, esperaba 9 (fragmented): ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /paste did not land as ONE prompt/, 'el log tiene que nombrar la falla de integridad');
    assert.doesNotMatch(r.stdout, /VERIFIED/, 'un fragmented jamas puede reportar VERIFIED — el Enter nunca se manda');
    assert.match(r.stdout, /Enter NOT sent/, 'T-0473: el log tiene que declarar explicitamente que el Enter real nunca se mando');
    assert.match(r.stdout, /residue left untouched: not provably this run's own payload/, 'T-0473: un fragmento AJENO al payload de esta corrida se deja intocado (T-0242/T-0323), sin Ctrl+C');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(intelDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Parte 2: live
const REPO = path.join(__dirname, '..');
const POKE = path.join(REPO, 'scripts', 'poke-pane.cjs');
const DOUBLE = path.join(REPO, 'test', 'fixtures', 'tui-double.cjs');
const WEZTERM = process.env.WEZTERM_BIN || 'wezterm';

function muxEnv() {
  try {
    const wez = require('../src/wezterm.cjs');
    const sock = wez.muxSocketPath();
    if (!sock) return null;
    const env = { ...process.env, WEZTERM_UNIX_SOCKET: sock };
    delete env.WEZTERM_PANE;
    return env;
  } catch { return null; }
}
function cli(env, args, input) {
  return execFileSync(WEZTERM, ['cli', '--prefer-mux', '--no-auto-start', ...args], { env, encoding: 'utf8', timeout: 20000, windowsHide: true, ...(input !== undefined ? { input } : {}) });
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function liveAvailable() {
  const env = muxEnv();
  if (!env) return null;
  try {
    const list = JSON.parse(cli(env, ['list', '--format', 'json']));
    return Array.isArray(list) && list.length > 0 ? env : null;
  } catch { return null; }
}

test('AC3 live: un payload de 3 lineas llega a un TUI ESTRICTO (cada salto = Enter) como EXACTAMENTE UN prompt; composer vacio; exit 0; el log declara el aplanado', { skip: !liveAvailable() && 'wezterm mux no alcanzable' }, () => {
  const env = liveAvailable();
  const projName = `t0303live${Date.now().toString(36)}`;
  const dir = path.join(os.tmpdir(), projName);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(DOUBLE, path.join(dir, 'tui-double.cjs'));
  const msg = path.join(dir, 'msg.txt');
  fs.writeFileSync(msg, 'Linea uno del sobre [corr=T-0303]\nLinea dos: revisa el result y confirma.\nLinea tres: criterios (1) verde (2) doc. Result en _intel/results/T-0303.md\n');
  // pane real con el doble en modo estricto (TUI_DOUBLE_STRICT=1 via cmd /k set)
  const paneId = cli(env, ['spawn', '--cwd', dir, '--', 'cmd', '/k', 'set TUI_DOUBLE_STRICT=1&& node tui-double.cjs']).trim();
  assert.match(paneId, /^\d+$/, `spawn no devolvio pane id: ${paneId}`);
  const tab = `${projName}-tab`;
  try {
    cli(env, ['set-tab-title', '--pane-id', paneId, tab]);
    // esperar el composer del doble
    let ready = false;
    for (let i = 0; i < 20 && !ready; i += 1) { sleep(300); ready = /❯/.test(cli(env, ['get-text', '--pane-id', paneId, '--start-line', '-10'])); }
    assert.ok(ready, 'el doble no llego a renderizar su composer');
    const r = spawnSync(process.execPath, [POKE, '--tab-title', tab, '--project', projName, '--file', msg], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `poke-pane exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /FLATTENED: 3 lines -> 1 line/, 'si aplana lo tiene que decir');
    assert.match(r.stdout, /VERIFIED \(paste intact, composer cleared\)/);
    sleep(600);
    const submits = fs.readFileSync(path.join(dir, 'submits.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(submits.length, 1, `el TUI estricto recibio ${submits.length} prompts, tenia que ser 1: ${JSON.stringify(submits.map((s) => s.text.slice(0, 40)))}`);
    for (const piece of ['Linea uno del sobre [corr=T-0303]', 'Linea dos: revisa el result y confirma.', 'Result en _intel/results/T-0303.md']) {
      assert.ok(submits[0].text.includes(piece), `falta "${piece}" en el unico prompt: ${submits[0].text}`);
    }
    assert.ok(submits[0].text.includes(' ⏎ '), 'los saltos quedan visibles como ⏎, no se pierden');
    assert.equal(composerContent(cli(env, ['get-text', '--pane-id', paneId, '--start-line', '-6'])), '', 'el composer queda vacio');
  } finally {
    try { cli(env, ['kill-pane', '--pane-id', paneId]); } catch { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
