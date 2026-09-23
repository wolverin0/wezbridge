'use strict';
/**
 * T-0485 AC3 — el steward tiene que VER el ruling que escribe `decidir.cjs`.
 *
 * `auditUnrecordedDecisions` (scripts/fleet-steward.cjs:527) arma su set de tarjetas
 * ya decididas con `loadRulings(dir).filter(isOperatorRuling)`. Con el emisor viejo
 * (`source: 'orchestrator-pane'`) ese filtro tiraba la linea, asi que una tarjeta
 * operator-gated movida a review CON su ruling escrito seguia apareciendo como
 * `decision-unrecorded`: el steward le reclamaba al operador una decision que el
 * operador ya habia dado y que el pane ya habia registrado.
 *
 * Los dos sentidos, en el mismo test, para que el verde pruebe algo:
 *   - linea armada por el EMISOR REAL (buildDecideArgs) => NO aparece el hallazgo
 *   - la MISMA linea con el source viejo                => SI aparece
 * Si el fix se revierte, el primero se pone rojo; si el detector se rompe, el segundo.
 *
 * Nada de esto toca `_intel/rulings.jsonl`: cada caso arma su propio intelDir en tmp.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');
const { FINDING_CATEGORY } = require('../src/rulings.cjs');
const { buildDecideArgs } = require('../scripts/decidir.cjs');

const NOW = Date.parse('2026-09-19T22:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const CAT = FINDING_CATEGORY.decisionUnrecorded;

const CARD = {
  id: 'T-0801',
  repo: 'infra',
  kind: 'deploy',
  title: 'restart de wabot',
  state: 'review',
  gate: 'operator',
  blocked_by: 'operator',
  lease: null,
  corr: 'wabot-restart-20260902',
  created_at: hoursAgo(30),
  state_changed_at: hoursAgo(5),
  updated_at: hoursAgo(5),
};

/** La linea de ruling tal como el ledger la escribe a partir de los args de decidir. */
function rulingFromDecidir(overrides = {}) {
  const { args } = buildDecideArgs({
    task: CARD.id,
    verdict: 'aprobar',
    why: 'si, reinicialo ahora',
    card: CARD,
  });
  const line = { task: args[1], at: hoursAgo(6) };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--ruling') line.ruling = args[i + 1];
    if (args[i] === '--why') line.why = args[i + 1];
    if (args[i] === '--source') line.source = args[i + 1];
    if (args[i] === '--by') line.by = args[i + 1];
    if (args[i] === '--corr') line.corr = args[i + 1];
  }
  return { ...line, ...overrides };
}

function intelWith(rulings) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 't0485-steward-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(d, 'rulings.jsonl'),
    rulings.map((r) => JSON.stringify(r)).join('\n') + (rulings.length ? '\n' : ''),
  );
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  fs.writeFileSync(path.join(d, 'tasks', `${CARD.id}.json`), JSON.stringify(CARD, null, 2));
  return d;
}

const unrecorded = (dir) => steward.audit([CARD], NOW, dir).findings.filter((f) => f.category === CAT);

test('AC3 — con el ruling que escribe decidir.cjs, la tarjeta NO aparece como decision-unrecorded', () => {
  const dir = intelWith([rulingFromDecidir()]);
  try {
    const f = unrecorded(dir);
    assert.equal(
      f.length, 0,
      `el steward no vio el ruling de decidir (source=${rulingFromDecidir().source}) y le reclama al `
      + 'operador una decision que ya dio',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3 control positivo — la MISMA linea con el source viejo SI aparece (el detector no esta muerto)', () => {
  // Sin este caso, el verde de arriba tambien pasaria con un detector roto que nunca
  // encuentra nada. Aca se fuerza el mundo viejo y el hallazgo tiene que volver.
  const dir = intelWith([rulingFromDecidir({ source: 'orchestrator-pane' })]);
  try {
    const f = unrecorded(dir);
    assert.equal(f.length, 1, 'con el source viejo el hallazgo TIENE que aparecer');
    assert.equal(f[0].id, CARD.id);
    assert.equal(f[0].category, CAT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC3 control negativo — sin ningun ruling tambien aparece', () => {
  const dir = intelWith([]);
  try {
    assert.equal(unrecorded(dir).length, 1, 'una tarjeta gateada sin ruling sigue siendo un hallazgo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
