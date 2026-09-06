'use strict';
/**
 * T-0403 — `isOperatorRuling` aceptaba `by=operator` SIN mirar `source`, asi que
 * cualquier pane que escribiera esa palabra se auto-otorgaba la autoridad del
 * operador. Hallado por el verificador adversarial de T-0325 (whatsappbot,
 * 2026-09-05) contra el `approved` real de T-0359.
 *
 * EL AGUJERO (src/rulings.cjs:128): el early-return por `by` disparaba antes de
 * `OPERATOR_SOURCES`, dejando muerto el enum de canales que SOLO opera el humano.
 * Medido el 06/09 sobre 565 lineas: 30 con `by=operator`, de las cuales **20 son
 * `source=orchestrator-pane`** — un pane, no el operador.
 *
 * LA REGLA NUEVA, y por que no es "solo board-app": la procedencia la da el
 * CANAL, no la palabra. Cuentan como del operador `board-app` y `telegram` (los
 * dos que el humano opera a mano) y `ledger-cli`, que es como `scripts/decidir.cjs`
 * registra una orden que el operador dio TEXTUALMENTE en un pane — la via que la
 * regla T-0326 exige y que cerrarla obligaria al operador a usar el tablero para
 * todo. `orchestrator-pane` y `drill` no cuentan, escriban lo que escriban en `by`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isOperatorRuling, OPERATOR_SOURCES } = require('../src/rulings.cjs');

const line = (over = {}) => ({
  task: 'T-0900', category: 'awaiting-operator', ruling: 'approved',
  why: 'dale', at: '2026-09-06T12:00:00.000Z', source: 'orchestrator-pane', by: 'operator',
  ...over,
});

test('AC1: un ruling by=operator escrito por un PANE no es una decision del operador', () => {
  assert.strictEqual(isOperatorRuling(line()), false,
    'un relay que escribe by=operator con source=orchestrator-pane se auto-otorgaba la autoridad');
  assert.strictEqual(isOperatorRuling(line({ source: 'drill' })), false, 'un drill tampoco decide por el operador');
});

test('AC1: los canales que el operador opera a mano SI cuentan, con cualquier by', () => {
  assert.strictEqual(isOperatorRuling(line({ source: 'board-app' })), true);
  assert.strictEqual(isOperatorRuling(line({ source: 'board-app', by: 'operator-link' })), true,
    'T-0349: el enlace firmado vale como la firma del operador');
  assert.strictEqual(isOperatorRuling(line({ source: 'telegram', by: null })), true);
});

test('AC1: ledger-cli sigue contando — es como decidir.cjs registra una orden textual en el pane (T-0326)', () => {
  assert.strictEqual(isOperatorRuling(line({ source: 'ledger-cli' })), true,
    'cerrar ledger-cli obligaria al operador a usar el tablero para todo; el caso real es T-0262 "CERRALO"');
  assert.ok(OPERATOR_SOURCES.includes('ledger-cli'), 'ledger-cli tiene que estar en el enum, no ser una excepcion suelta');
});

test('AC1: entradas basura nunca son del operador', () => {
  for (const bad of [null, undefined, 'operator', 42, {}, { by: 'operator' }, { source: 'nope', by: 'operator' }]) {
    assert.strictEqual(isOperatorRuling(bad), false, `${JSON.stringify(bad)} no puede autorizar nada`);
  }
});

// ── AC2: el guard de deploy de whatsappbot consume ESTE predicado ────────────
// El guard importa isOperatorRuling del lector canonico de wezbridge (nunca
// re-parsea), asi que el arreglo tiene que verse en su exit code: un relay
// forjado deja de autorizar y sale 3 (DENIED).
const GUARD = path.join(__dirname, '..', '..', 'whatsappbot-prod - Copy - Copy', 'whatsappbot-final', 'scripts', 'deploy', 'require-operator-ruling.cjs');
const HAVE_GUARD = fs.existsSync(GUARD);

function runGuard(rulingLines, { task = 'T-0900', corr = 'corr-T-0900' } = {}) {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 't0403-intel-'));
  fs.writeFileSync(path.join(intel, 'rulings.jsonl'), rulingLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(intel, 'action-log.jsonl'), '');
  return spawnSync(process.execPath, [GUARD, '--task', task, '--corr', corr, '--intel-dir', intel], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, WEZBRIDGE_DIR: path.join(__dirname, '..'), DEPLOY_GUARD_TEST: '1' },
  });
}

test('AC2: el guard de deploy NIEGA (exit 3) un approved forjado por un pane con by=operator', { skip: !HAVE_GUARD }, () => {
  const r = runGuard([line({ corr: 'corr-T-0900' })]);
  assert.strictEqual(r.status, 3,
    `un relay con by=operator NO puede autorizar un deploy; exit=${r.status}\n${r.stdout}\n${r.stderr}`);
});

test('AC2 control: el guard AUTORIZA (exit 0) el mismo approved cuando viene del tablero', { skip: !HAVE_GUARD }, () => {
  const r = runGuard([line({ corr: 'corr-T-0900', source: 'board-app' })]);
  assert.strictEqual(r.status, 0,
    `una decision real del operador tiene que seguir autorizando; exit=${r.status}\n${r.stdout}\n${r.stderr}`);
});
