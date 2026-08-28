'use strict';
/**
 * T-0242 / AC6 — no entregar sobre un composer que retiene texto AJENO.
 *
 * Reproducido en vivo el 2026-08-28 (evidencia en la tarjeta y en
 * _intel/briefs/T-0242-reproduccion-en-vivo-20260828.md): TRES panes tenian
 * instrucciones del operador sin enviar en su composer, y `status` decia `idle`
 * en los tres. Un envio en esa ventana no manda el sobre: manda
 * "texto del operador + sobre" CONCATENADOS como un solo prompt.
 *
 * Medido ese mismo dia, y es la razon de que diferir sea la UNICA conducta
 * correcta: un Enter inyectado NO vacia un composer con texto tipeado a mano.
 * Se intento 3 veces (2 por MCP send_key, 1 por `wezterm cli send-text` directo
 * a la pane) y el texto siguio ahi. El camino "reintentar Enter" de
 * verifyPromptSubmission no es un rescate para este caso.
 *
 * LOS DOS SENTIDOS (innegociable): un guard que difiere SIEMPRE pasaria un test
 * que solo mira el caso positivo, y romperia toda la entrega del fleet. Por eso
 * cada aserto de "no entrega" tiene su gemelo de "SI entrega".
 *
 * Fixtures: capturadas de panes REALES con `wezterm cli get-text` el 2026-08-28.
 * La estructura medida es estable: el composer es la linea entre los dos bordes,
 * y separa el marcador del contenido con NBSP (\u00a0) cuando retiene texto.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { inputBoxContent } = require('../src/verified-send.cjs');

// ── fixtures reales (pane-id del CLI de wezterm, 2026-08-28 ~21:50Z) ────────
const BORDE = '─'.repeat(70);

/** pane 15 (infra): el operador escribio y el texto NUNCA se envio. */
const HOLDING_INFRA = ['  algo de scrollback', BORDE, '❯\u00a0dale, hacelo vos', BORDE, '   Model: Opus 5'].join('\n');
/** pane 18 (memorymaster): idem, otra instruccion perdida. */
const HOLDING_MM = [BORDE, '❯\u00a0mergea el 235 cuando pase CI', BORDE].join('\n');
/** pane 28 (wabot): idem. */
const HOLDING_WABOT = [BORDE, '❯\u00a0traeme las facturas que canceló el 17212', BORDE].join('\n');
/** pane 39 (dyndns): composer VACIO — control negativo, con scrollback arriba. */
const EMPTY_DYNDNS = ['❯ the ip of the access control are 192.168.100.250', '❯ /model', BORDE, '❯', BORDE].join('\n');
/** pane 35 (omniremote, codex): PLACEHOLDER, no texto del usuario. */
const PLACEHOLDER_CODEX = ['', '› Ask Codex to do anything', '', '  gpt-5.6-sol high · Ready'].join('\n');

function loadGuard() {
  const mod = require('../src/verified-send.cjs');
  return mod.composerHoldsForeignText;
}

// ── SENTIDO A: retiene texto ajeno => NO entregar ───────────────────────────
test('A1 (fail-first): un composer con texto del operador se detecta como retenido', () => {
  const guard = loadGuard();
  assert.strictEqual(typeof guard, 'function',
    'verified-send debe exportar composerHoldsForeignText — sin el, todo emisor concatena');
  for (const [name, tail] of [['infra', HOLDING_INFRA], ['memorymaster', HOLDING_MM], ['wabot', HOLDING_WABOT]]) {
    assert.strictEqual(guard(tail), true, `${name}: texto del operador retenido, no se puede entregar encima`);
  }
});

// ── SENTIDO B: no retiene => SI entregar (anti-guard-que-difiere-siempre) ───
test('B1 (fail-first, el otro sentido): composer vacio => SE ENTREGA', () => {
  const guard = loadGuard();
  assert.strictEqual(guard(EMPTY_DYNDNS), false,
    'composer vacio con scrollback arriba: diferir aca paralizaria al fleet entero');
});

test('B2: el placeholder de codex NO es texto del usuario => SE ENTREGA', () => {
  const guard = loadGuard();
  assert.strictEqual(guard(PLACEHOLDER_CODEX), false,
    '"Ask Codex to do anything" es chrome del TUI; tratarlo como texto retenido corta toda entrega a paneles codex');
});

test('B3: tail ilegible o vacio => SE ENTREGA (fail-open, igual que el resto del camino)', () => {
  const guard = loadGuard();
  for (const v of ['', null, undefined]) {
    assert.strictEqual(guard(v), false, `tail ${JSON.stringify(v)}: un guard que falla cerrado sobre un pane ilegible es peor que el bug`);
  }
});

// ── el extractor que ya existe tiene que seguir haciendo lo suyo ────────────
test('C1 (regresion): inputBoxContent sigue devolviendo vacio en composer vacio', () => {
  assert.strictEqual(inputBoxContent(EMPTY_DYNDNS.split('\n')), '');
  assert.strictEqual(inputBoxContent(HOLDING_INFRA.split('\n')), 'dale, hacelo vos',
    'el NBSP tiene que quedar comido por \s — si no, el contenido arranca con un espacio raro');
});
