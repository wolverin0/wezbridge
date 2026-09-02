'use strict';
/**
 * T-0326 AC3 — `decision-unrecorded`: el operador decidio EN un pane y el pane
 * actuo sin escribir el ruling. Fail-first: antes de este hallazgo, una tarjeta
 * gateada por el operador que pasaba a done sin ruling by=operator no producia
 * NADA (medido 4 veces el 2026-09-02: T-0253, T-0297, restart de wabot, T-0310).
 * Los dos sentidos: con ruling del operador NO dispara (la regla cumplida no
 * puede sonar), y el backlog anterior a la epoca tampoco.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const steward = require('../scripts/fleet-steward.cjs');
const { FINDING_CATEGORY } = require('../src/rulings.cjs');
const gate = require('../scripts/steward-gate.cjs');

const NOW = Date.parse('2026-09-02T22:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const CAT = 'decision-unrecorded';

function intelWith({ rulings = [], cards = [] }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-unrecorded-'));
  fs.mkdirSync(path.join(d, 'routine-findings'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'rulings.jsonl'), rulings.map((r) => JSON.stringify(r)).join('\n') + (rulings.length ? '\n' : ''));
  fs.writeFileSync(path.join(d, 'events.jsonl'), '');
  for (const c of cards) fs.writeFileSync(path.join(d, 'tasks', `${c.id}.json`), JSON.stringify(c, null, 2));
  return d;
}
/** Tarjeta gateada por el operador que alguien movio a `state` hace `h` horas sin des-gatear. */
const gated = (over = {}) => ({
  id: 'T-0801', repo: 'infra', kind: 'deploy', title: 'restart de wabot', state: 'done', gate: 'operator',
  blocked_by: 'operator', lease: null, created_at: hoursAgo(30), state_changed_at: hoursAgo(5), updated_at: hoursAgo(5), ...over,
});
const findings = (dir, cards) => steward.audit(cards, NOW, dir).findings.filter((f) => f.category === CAT);

test('AC3 fail-first: tarjeta blocked/operator que paso a done SIN ruling by=operator => decision-unrecorded', () => {
  const card = gated();
  const dir = intelWith({ cards: [card] });
  const f = findings(dir, [card]);
  assert.equal(f.length, 1, 'antes no habia hallazgo: la decision tomada en el pane moria ahi');
  assert.equal(f[0].id, 'T-0801');
  assert.equal(f[0].category, FINDING_CATEGORY.decisionUnrecorded, 'la palabra sale del modulo, no de un literal');
  assert.equal(f[0].age_hours, 5, 'el reloj cuenta desde que la tarjeta se movio');
  assert.match(f[0].why, /decidir\.cjs T-0801/, 'el hallazgo dice como repararlo');
});

test('AC3 el otro sentido: con ruling by=operator (o por tablero/telegram) NO dispara; y el steward ve ready/running/review/cancelled igual que done', () => {
  for (const r of [
    { task: 'T-0801', ruling: 'approved', why: 'dale', at: hoursAgo(6), source: 'orchestrator-pane', by: 'operator' },
    { task: 'T-0801', ruling: 'approved', why: 'tap', at: hoursAgo(6), source: 'board-app' },
    { task: 'T-0801', ruling: 'cancelled', why: 'olvidate', at: hoursAgo(1), source: 'telegram' },
  ]) {
    const card = gated();
    assert.deepEqual(findings(intelWith({ rulings: [r], cards: [card] }), [card]), [], `ruling ${r.ruling}/${r.source}: la regla cumplida no puede sonar`);
  }
  // un ruling firmado por un AGENTE no es la decision del operador
  const card = gated();
  const agentRuling = { task: 'T-0801', ruling: 'approved', why: 'lo aprobe yo', at: hoursAgo(6), source: 'orchestrator-pane', by: 'pane-7' };
  assert.equal(findings(intelWith({ rulings: [agentRuling], cards: [card] }), [card]).length, 1, 'by=pane-7 no es el operador');
  for (const state of ['ready', 'running', 'review', 'cancelled']) {
    const c = gated({ state });
    assert.equal(findings(intelWith({ cards: [c] }), [c]).length, 1, `${state}: salio del gate sin ruling`);
  }
});

test('AC3 no retro-flaggea: sigue blocked => nada; sin gate de operador => nada; movida antes de la epoca => nada', () => {
  const still = gated({ state: 'blocked' });
  assert.deepEqual(findings(intelWith({ cards: [still] }), [still]), [], 'esperando al operador ES el estado correcto');
  const agentCard = gated({ gate: null, blocked_by: 'agent' });
  assert.deepEqual(findings(intelWith({ cards: [agentCard] }), [agentCard]), [], 'una tarjeta que nunca fue del operador no le debe ruling');
  const old = gated({ state_changed_at: '2026-08-20T10:00:00.000Z' });
  assert.deepEqual(findings(intelWith({ cards: [old] }), [old]), [], 'epoca 2026-09-01: el backlog no se retro-flaggea');
});

test('AC3 el gate lo cuenta: decision-unrecorded tiene deadline (24h) y un ruling resolved del operador lo cubre', () => {
  const f = { id: 'T-0801', repo: 'infra', category: CAT, age_hours: 30, title: 'x' };
  const red = gate.evaluate({ findings: [f], rulings: [], now: NOW });
  assert.equal(red.verdict, 'RED', 'sin ruling y vencido => RED');
  const green = gate.evaluate({ findings: [f], rulings: [{ task: 'T-0801', category: CAT, ruling: 'resolved', why: 'escrito tarde', at: hoursAgo(1), source: 'orchestrator-pane', by: 'operator' }], now: NOW });
  assert.equal(green.verdict, 'GREEN');
  const young = gate.evaluate({ findings: [{ ...f, age_hours: 2 }], rulings: [], now: NOW });
  assert.equal(young.verdict, 'GREEN', 'antes de las 24h no vence');
});
