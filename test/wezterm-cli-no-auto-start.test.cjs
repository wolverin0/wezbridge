'use strict';
/**
 * Toda invocacion de `wezterm cli` lleva `--no-auto-start`. Sin excepcion.
 *
 * Medido el 2026-09-01: `wezterm cli` que no logra conectar arranca un
 * `wezterm-mux-server` nuevo, y ese mux borra y re-crea `~/.local/share/wezterm/sock`
 * apuntando a si mismo. El mux viejo sigue vivo con los panes, pero ya no hay
 * path para llegarle: un GUI nuevo `--attach` se cuelga del mux vacio y las
 * sesiones quedan huerfanas. Habia CINCO mux-servers; el quinto lo creo una
 * sonda `cli list` contra el socket de un GUI colgado (recorder.log 17:51:50).
 * `findGuiSocket()` sondeaba cada gui-sock sin el flag cada 30 s desde el
 * daemon, el MCP y el streamer: una fabrica de mux-servers cada vez que un GUI
 * se colgaba. Detalle: artifacts/2026-09-01-wezterm-gui-hang-diagnosis.html.
 *
 * Este test lee el codigo, no lo ejecuta: cada literal `['cli', ...]` de src/ y
 * scripts/ tiene que continuar con '--no-auto-start' (opcionalmente precedido
 * por '--prefer-mux'). Un literal compliant NO dispara (control positivo).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts'];

function cjsFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.cjs') || f.endsWith('.js'))
    .map((f) => path.join(dir, f));
}

// Un literal que empieza con 'cli' (o "cli") seguido de coma. Se permite
// `[...configArgs, 'cli', ...]` porque el spread va antes del 'cli'. El token
// siguiente se captura ENTERO (hasta la proxima coma o cierre), asi un spread
// `['cli', ...args]` tambien cuenta — la primera version de este test solo
// miraba tokens entre comillas y dejo pasar exactamente ese caso.
const CLI_LITERAL = /['"]cli['"]\s*,\s*((?:['"]--prefer-mux['"]\s*,\s*)?)([^,\]\)]+)/g;

function offenders(source) {
  const bad = [];
  let m;
  while ((m = CLI_LITERAL.exec(source)) !== null) {
    const next = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (next !== '--no-auto-start') {
      const line = source.slice(0, m.index).split('\n').length;
      bad.push({ line, next });
    }
  }
  return bad;
}

test('control positivo: un literal compliant no dispara', () => {
  assert.deepStrictEqual(offenders("execFileSync(W, ['cli', '--no-auto-start', 'list'])"), []);
  assert.deepStrictEqual(offenders("['cli', '--prefer-mux', '--no-auto-start', ...args]"), []);
  assert.deepStrictEqual(offenders("`wezterm cli ${args.join(' ')} failed`"), [], 'un mensaje de error no es una invocacion');
});

test('control negativo: un literal sin el flag dispara con la linea', () => {
  const r = offenders("x();\nexecFileSync(W, ['cli', 'list', '--format', 'json'])");
  assert.deepStrictEqual(r, [{ line: 2, next: 'list' }]);
});

test('control negativo: un spread justo despues de cli tambien dispara', () => {
  const r = offenders("cliArgs: guiSocket ? ['cli', ...args] : ['cli', '--no-auto-start', ...args],");
  assert.deepStrictEqual(r, [{ line: 1, next: '...args' }]);
});

test('src/ y scripts/: ninguna invocacion `wezterm cli` sin --no-auto-start', () => {
  const found = [];
  for (const dir of SCAN_DIRS) {
    for (const rel of cjsFiles(dir)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const o of offenders(src)) found.push(`${rel}:${o.line} (sigue '${o.next}')`);
    }
  }
  assert.deepStrictEqual(found, [],
    `Invocaciones de wezterm cli sin --no-auto-start (cada una puede robar el socket del mux):\n  ${found.join('\n  ')}`);
});
