'use strict';
/**
 * loop-stall-clears.test.cjs — T-0283 AC6: T-LOOP-STALL se LIMPIA sola cuando el loop vuelve a
 * ser productivo. raiseStall() creaba y re-levantaba la tarjeta pero NADA la cerraba nunca,
 * mientras el contador de stalls SI se reseteaba. clearStall() cancela la tarjeta de stall abierta
 * con evidencia del turno productivo. CRITERIO DE CONTROL: no puede cerrar una tarjeta que un humano
 * dejo abierta a proposito — si hay un ruling humano sobre ella, o no es una tarjeta de stall
 * (origin_key distinto), queda como esta. Sandbox con kinds.json y ledger REALES (idioma de
 * loop-stall-visibility.test.cjs). Fail-first: RED porque clearStall no existe.
 */
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TURN_SRC = require.resolve('../scripts/orchestrator-turn.cjs');
const LEDGER_SRC = path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');

function withTempIntel(fn) {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-stall-clear-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', '_intel', 'kinds.json'), path.join(tmp, 'kinds.json'));
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  delete require.cache[TURN_SRC];
  delete require.cache[LEDGER_SRC];
  try {
    return fn({ intel: tmp, turn: require(TURN_SRC), ledger: require(LEDGER_SRC) });
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prev;
    delete require.cache[TURN_SRC];
    delete require.cache[LEDGER_SRC];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const readCard = (intel, id) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8'));

test('AC6: un turno productivo cancela la tarjeta de stall abierta, con evidencia', () => {
  withTempIntel(({ intel, turn }) => {
    const card = turn.raiseStall(3, ['gate RED', 'nothing changed']);
    assert.ok(card && card.state === 'blocked', 'precondicion: la alarma nace blocked');
    const out = turn.clearStall({ productive: true, now: '2026-09-01T22:00:00.000Z', reason: 'rulings 10->12' });
    assert.equal(out.cleared.length, 1);
    assert.equal(out.cleared[0], card.id);
    const after = readCard(intel, card.id);
    assert.equal(after.state, 'cancelled');
    assert.match(String(after.evaluator_evidence || after.evidence || after.next_action || ''), /productiv/i);
  });
});

test('AC6 control: una tarjeta de stall con ruling HUMANO no se toca; una tarjeta ajena tampoco', () => {
  withTempIntel(({ intel, turn, ledger }) => {
    const stall = turn.raiseStall(3, ['gate RED']);
    fs.appendFileSync(path.join(intel, 'rulings.jsonl'), JSON.stringify({ task: stall.id, category: 'awaiting-operator', ruling: 'deferred', until: '2099-01-01T00:00:00Z', why: 'lo miro yo', at: '2026-09-01T21:00:00Z' }) + '\n');
    const other = ledger.create({ title: 'question the human left open', goal: 'x', kind: 'question', repo: 'wezbridge', state: 'blocked', 'blocked-by': 'operator', criteria: 'a', origin: 'manual:question:1' });
    const out = turn.clearStall({ productive: true, now: '2026-09-01T22:00:00.000Z', reason: 'x' });
    assert.deepEqual(out.cleared, []);
    assert.equal(out.skipped.length, 1, 'la de stall se salta por el ruling humano, y lo dice');
    assert.match(out.skipped[0].reason, /ruling/);
    assert.equal(readCard(intel, stall.id).state, 'blocked');
    assert.equal(readCard(intel, other.id).state, 'blocked', 'una tarjeta que no es de stall no se toca');
  });
});

test('AC6: un turno NO productivo no limpia nada', () => {
  withTempIntel(({ intel, turn }) => {
    const stall = turn.raiseStall(3, ['gate RED']);
    const out = turn.clearStall({ productive: false, now: '2026-09-01T22:00:00.000Z' });
    assert.deepEqual(out.cleared, []);
    assert.equal(readCard(intel, stall.id).state, 'blocked');
  });
});
