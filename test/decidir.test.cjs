'use strict';
/**
 * T-0326 AC2 — scripts/decidir.cjs: tarjeta + veredicto + textual del operador =>
 * una linea en rulings.jsonl con source=orchestrator-pane y by=operator (y el
 * corr de la tarjeta si no se pasa), escrita por `ledger decide` — el mismo
 * camino del tablero: ruling primero, FSM despues, des-gate.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildDecideArgs } = require('../scripts/decidir.cjs');

const REPO = path.join(__dirname, '..');
const DECIDIR = path.join(REPO, 'scripts', 'decidir.cjs');
const LEDGER = path.join(REPO, '..', '_docs-curation', 'ledger.cjs');

test('AC2 puro: aprobar/cancelar/diferir (y letras) arman el decide con source orchestrator-pane, by operator y el corr de la tarjeta', () => {
  const card = { id: 'T-0303', corr: 'T-0303' };
  const a = buildDecideArgs({ task: 'T-0303', verdict: 'aprobar', why: 'dale, hacelo', card });
  assert.equal(a.ruling, 'approved');
  assert.deepEqual(a.args, ['decide', 'T-0303', '--ruling', 'approved', '--why', 'dale, hacelo', '--source', 'orchestrator-pane', '--by', 'operator', '--corr', 'T-0303']);
  assert.equal(buildDecideArgs({ task: 'T-0253', verdict: 'c', why: 'olvidate de eso' }).ruling, 'cancelled');
  const d = buildDecideArgs({ task: 'T-0312', verdict: 'diferir', why: 'despues del deploy', until: '2026-09-03T14:00:00Z', corr: 'X:r2' });
  assert.equal(d.ruling, 'deferred');
  assert.ok(d.args.includes('--until') && d.args.includes('X:r2'), 'un corr explicito gana sobre el de la tarjeta');
  assert.throws(() => buildDecideArgs({ task: 'T-0312', verdict: 'diferir', why: 'x' }), /--until/);
  assert.throws(() => buildDecideArgs({ task: 'T-0303', verdict: 'aprobar', why: '   ' }), /textual/);
  assert.throws(() => buildDecideArgs({ task: 'T-0303', verdict: 'quizas', why: 'x' }), /aprobar \| cancelar \| diferir/);
});

test('AC2 e2e: corre ledger decide y la linea escrita en rulings.jsonl lleva by=operator, source=orchestrator-pane, corr y el textual; la tarjeta gateada sale de blocked', { skip: !fs.existsSync(LEDGER) && '_docs-curation/ledger.cjs no esta al lado' }, () => {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'decidir-'));
  fs.mkdirSync(path.join(intel, 'tasks'));
  fs.writeFileSync(path.join(intel, 'kinds.json'), JSON.stringify({ kinds: { deploy: { class: 'work', fallback_mode: 'scoped_write', fallback_gate: 'operator' } }, rules: {} }));
  fs.writeFileSync(path.join(intel, 'tasks', 'T-0801.json'), JSON.stringify({
    id: 'T-0801', title: 'restart de wabot', goal: 'x', kind: 'deploy', repo: 'wabot', state: 'blocked', gate: 'operator',
    blocked_by: 'operator', blocker: 'operator gate: restart', corr: 'wabot-restart-20260902', lease: null, acceptance_criteria: ['a'],
    created_at: new Date().toISOString(),
  }, null, 2));
  const r = spawnSync(process.execPath, [DECIDIR, 'T-0801', 'aprobar', 'si, reinicialo ahora'], {
    encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel, WEZBRIDGE_ROOT: REPO },
  });
  assert.equal(r.status, 0, `decidir fallo: ${r.stdout}${r.stderr}`);
  const lines = fs.readFileSync(path.join(intel, 'rulings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.equal(line.task, 'T-0801');
  assert.equal(line.ruling, 'approved');
  assert.equal(line.by, 'operator', 'sin by=operator el steward no lo cuenta como decision del operador');
  assert.equal(line.source, 'orchestrator-pane');
  assert.equal(line.corr, 'wabot-restart-20260902', 'el corr sale de la tarjeta');
  assert.equal(line.why, 'si, reinicialo ahora');
  assert.equal(line.category, 'awaiting-operator', 'la tarjeta estaba gateada: lo que se respondio fue la pregunta del operador');
  const card = JSON.parse(fs.readFileSync(path.join(intel, 'tasks', 'T-0801.json'), 'utf8'));
  assert.notEqual(card.state, 'blocked', 'ruling primero, FSM despues: la tarjeta sale del gate');
  assert.match(r.stdout, /escrito en rulings\.jsonl ANTES de actuar/);
  fs.rmSync(intel, { recursive: true, force: true });
});
