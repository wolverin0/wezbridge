'use strict';
/**
 * Los tests NO pueden escribir en el plano de control de la flota.
 *
 * Medido el 2026-08-25 y costo horas: los helpers que spawnean el servidor MCP
 * real heredaban process.env entero, asi que sus llamadas quedaban registradas
 * en el events.jsonl VIVO de _intel/. Cuatro corridas del suite dejaron ahi
 * entradas "prompt.sent -> pane 1" de 16.384 bytes, y una investigacion sobre
 * "quien le manda cosas a un pane que no existe" persiguio durante horas un
 * emisor fantasma que era este mismo repositorio probandose a si mismo.
 *
 * La leccion no es "aislar los tests" — eso ya se sabia. Es que un log de
 * auditoria contaminado por sus propios tests es PEOR que no tener log: la
 * senal falsa tiene el mismo formato que la verdadera y nadie la distingue.
 *
 * Este test falla si alguien agrega o edita un helper que spawnee el servidor
 * sin aislar el directorio de intel.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

test('todo helper que spawnea el servidor MCP aisla WEZBRIDGE_INTEL_DIR', () => {
  const offenders = [];
  for (const file of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.cjs'))) {
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    // Solo interesan los que lanzan el servidor de verdad; los que requieren
    // modulos sueltos no tocan el plano de control.
    const spawnsServer = /spawn\(\s*process\.execPath\s*,\s*\[\s*serverPath/.test(src);
    if (!spawnsServer) continue;
    if (!/WEZBRIDGE_INTEL_DIR/.test(src)) offenders.push(file);
  }
  assert.deepStrictEqual(offenders, [],
    `estos helpers spawnean el servidor MCP real sin aislar el intel dir, así que sus eventos van al events.jsonl de la flota: ${offenders.join(', ')}`);
});

test('el directorio de intel se resuelve desde el entorno, que es lo que hace posible el aislamiento', () => {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'wezbridge-intel-assert-'));
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  const modPath = require.resolve('../src/a2a-intel.cjs');
  delete require.cache[modPath];
  try {
    const a2a = require(modPath);
    assert.strictEqual(a2a.intelDir(), tmp);
    a2a.recordEvent({ event: 'test.only', to_pane: 1 });
    const written = fs.readFileSync(path.join(tmp, 'events.jsonl'), 'utf8');
    assert.match(written, /test\.only/, 'el evento tiene que caer en el temp, no en la flota');
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = prev;
    delete require.cache[modPath];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
