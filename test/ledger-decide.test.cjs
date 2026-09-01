'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * ledger-decide.test.cjs — `ledger.cjs decide`: la decision del operador por CLI.
 *
 * Afirma el contrato completo: el RULING se escribe PRIMERO (aunque la FSM
 * despues sea ilegal), `approved` sobre blocked va a ready y des-gatea LOS DOS
 * lugares donde vive el gate (`contract.gate` y el top-level, leidos por
 * `gateOf`), deja `blocked_by: agent`, y sin `wezbridge/src/rulings.cjs` REFUSA
 * en vez de appendear crudo. Leer cuando se toque decide, el schema del ruling,
 * o quien puede mover una tarjeta del operador.
 *
 * Se corre por SUBPROCESO sobre una COPIA del ledger real: `INTEL` es constante
 * de require, asi que la unica forma de apuntarlo a un sandbox es el env del
 * hijo. Mismo idioma que clawtrol-retry-transition.test.cjs.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// El MISMO predicado que lee el tablero y fleet-board: la post-condicion del
// des-gate se mide con el lector, nunca con la lista de asignaciones que corrio.
const { gateOf } = require('../scripts/fleet-board.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-decide-'));
const INTEL = path.join(TMP, '_intel');
const LEDGER_DIR = path.join(TMP, '_docs-curation');
fs.mkdirSync(path.join(INTEL, 'tasks'), { recursive: true });
fs.mkdirSync(LEDGER_DIR, { recursive: true });

const LEDGER_SRC = [
  path.join(REPO_ROOT, '..', '_docs-curation', 'ledger.cjs'),
  path.join(REPO_ROOT, '..', '..', '_docs-curation', 'ledger.cjs'),
].find((p) => fs.existsSync(p));
if (!LEDGER_SRC) throw new Error('cannot locate _docs-curation/ledger.cjs from this checkout');
const LEDGER = path.join(LEDGER_DIR, 'ledger.cjs');
fs.copyFileSync(LEDGER_SRC, LEDGER);
fs.copyFileSync(path.join(path.dirname(LEDGER_SRC), 'sweeper-config.json'), path.join(LEDGER_DIR, 'sweeper-config.json'));
const KINDS = [
  path.join(REPO_ROOT, '..', '_intel', 'kinds.json'),
  path.join(REPO_ROOT, '..', '..', '_intel', 'kinds.json'),
].find((p) => fs.existsSync(p));
if (KINDS) fs.copyFileSync(KINDS, path.join(INTEL, 'kinds.json'));

const BASE_ENV = {
  ...process.env,
  WEZBRIDGE_INTEL_DIR: INTEL,
  WEZBRIDGE_LEDGER_DIR: LEDGER_DIR,
  WEZBRIDGE_ROOT: REPO_ROOT,
};

function run(args, envOver = {}) {
  try {
    const stdout = execFileSync(process.execPath, [LEDGER, ...args],
      { encoding: 'utf8', env: { ...BASE_ENV, ...envOver } });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const cardFile = (id) => path.join(INTEL, 'tasks', `${id}.json`);
const card = (id) => JSON.parse(fs.readFileSync(cardFile(id), 'utf8'));

/** El escenario se prepara en disco: preparar no es lo que se prueba. */
function seed(id, over = {}) {
  fs.writeFileSync(cardFile(id), JSON.stringify({
    id, title: `tarjeta ${id}`, goal: 'algo', kind: 'general', repo: 'wezbridge',
    state: 'blocked', blocked_by: 'operator', acceptance_criteria: ['algo medible'],
    lease: null, attempt: 1, corr: null, parent: null,
    contract: { mode: 'scoped_write', gate: 'operator', allowed_paths: ['src/**'] },
    gate: null, blocker: 'operator gate (graph contract, kind=general)',
    next_action: null, created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }, null, 2));
  return id;
}

function rulings() {
  const f = path.join(INTEL, 'rulings.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function actions() {
  const f = path.join(INTEL, 'operator-actions.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const rulingsFor = (id) => rulings().filter((r) => r.task === id);

// ---------------------------------------------------------------------------
// El orden: el ruling es la fuente de verdad, la FSM es el efecto
// ---------------------------------------------------------------------------

test('ruling lands before FSM', () => {
  // ASESINO de la mutacion "invertir el orden append/FSM". `running -> cancelled`
  // NO es una transicion legal hoy, asi que la FSM tira. Si la FSM corriera
  // primero, el proceso saldria por el catch y la decision del operador se
  // perderia entera: la tarjeta seguiria igual Y no habria constancia de que
  // decidio. Con el orden correcto la decision queda escrita y lo que falla es
  // solo el efecto, que se reporta.
  seed('T-9201', { state: 'running', blocked_by: 'agent', lease: { owner: 'pane-3', expires_at: '2099-01-01T00:00:00Z' } });
  const r = run(['decide', 'T-9201', '--ruling', 'cancelled', '--why', 'la premisa murio', '--source', 'ledger-cli']);
  assert.notStrictEqual(r.code, 0, 'una FSM ilegal tiene que salir distinto de cero');
  const mine = rulingsFor('T-9201');
  assert.strictEqual(mine.length, 1, 'EL RULING QUEDA ESCRITO — es la fuente de verdad y va primero');
  assert.strictEqual(mine[0].ruling, 'cancelled');
  assert.strictEqual(mine[0].source, 'ledger-cli');
  assert.match(`${r.stdout}${r.stderr}`, /illegal transition|running/,
    'y la salida dice cual mitad fallo, en vez de fingir exito');
  assert.strictEqual(card('T-9201').state, 'running', 'la tarjeta no se movio');
});

// ---------------------------------------------------------------------------
// approved
// ---------------------------------------------------------------------------

test('approved sobre blocked: ready, des-gatea LOS DOS lugares, blocked_by agent', () => {
  seed('T-9202', { gate: 'operator' });          // el shape real de T-0145: los dos gates
  const r = run(['decide', 'T-9202', '--ruling', 'approved', '--why', 'dale, arranca',
    '--source', 'ledger-cli', '--by', 'operator']);
  assert.strictEqual(r.code, 0, `${r.stderr}${r.stdout}`);

  const after = card('T-9202');
  assert.strictEqual(after.state, 'ready');
  assert.strictEqual(after.contract.gate, null, 'contract.gate limpio');
  assert.strictEqual(after.gate, null, 'y el top-level tambien');
  assert.strictEqual(gateOf(after), null, 'POST-CONDICION medida con el lector, no con las asignaciones');
  assert.strictEqual(after.blocked_by, 'agent', 'ya no espera al operador');
  assert.ok(after.next_action && /approved/i.test(after.next_action), `next_action nombra la decision: ${after.next_action}`);
  assert.ok(after.next_action.includes('dale, arranca'), 'y el porque va textual');
  assert.strictEqual(after.contract.mode, 'scoped_write', 'des-gatear no destripa el contrato');
  assert.deepStrictEqual(after.contract.allowed_paths, ['src/**']);

  const line = rulingsFor('T-9202')[0];
  assert.strictEqual(line.ruling, 'approved');
  assert.strictEqual(line.source, 'ledger-cli');
  assert.strictEqual(line.by, 'operator');
  assert.strictEqual(line.category, 'awaiting-operator', 'la categoria sale del gate que la tarjeta tenia');

  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.ruling.ruling, 'approved', 'el stdout es JSON como el de create/update');
  assert.strictEqual(out.transition.applied, true);
  assert.strictEqual(out.transition.from, 'blocked');
  assert.strictEqual(out.transition.to, 'ready');
  assert.strictEqual(out.transition.ungated, true);
});

test('approved sobre running/review NO mueve el estado, pero des-gatea y deja next_action', () => {
  seed('T-9203', { state: 'running', blocked_by: 'agent', gate: 'operator', contract: { mode: 'scoped_write', gate: 'operator' } });
  const r = run(['decide', 'T-9203', '--ruling', 'approved', '--why', 'segui', '--source', 'orchestrator-pane']);
  assert.strictEqual(r.code, 0, `${r.stderr}${r.stdout}`);
  const after = card('T-9203');
  assert.strictEqual(after.state, 'running', 'aprobar no reinicia trabajo en vuelo');
  assert.strictEqual(gateOf(after), null, 'pero el gate se va igual');
  assert.ok(after.next_action.includes('segui'));
  assert.strictEqual(JSON.parse(r.stdout).transition.applied, false, 'no hubo movimiento de estado y se declara');
});

test('approved sobre una tarjeta SIN gate no rompe nada y sigue dejando el ruling', () => {
  seed('T-9204', { state: 'ready', blocked_by: 'agent', gate: null, contract: { mode: 'read_mostly', gate: null } });
  const r = run(['decide', 'T-9204', '--ruling', 'approved', '--why', 'ok', '--source', 'telegram']);
  assert.strictEqual(r.code, 0, `${r.stderr}${r.stdout}`);
  assert.strictEqual(card('T-9204').state, 'ready');
  assert.strictEqual(rulingsFor('T-9204')[0].category, null, 'sin gate no hay pregunta pendiente: categoria null');
});

// ---------------------------------------------------------------------------
// cancelled / deferred
// ---------------------------------------------------------------------------

test('cancelled sobre blocked: la tarjeta muere CON evidencia', () => {
  seed('T-9205');
  const r = run(['decide', 'T-9205', '--ruling', 'cancelled', '--why', 'el recurso ya no existe', '--source', 'ledger-cli']);
  assert.strictEqual(r.code, 0, `${r.stderr}${r.stdout}`);
  const after = card('T-9205');
  assert.strictEqual(after.state, 'cancelled');
  assert.ok(String(after.evaluator_evidence || '').includes('el recurso ya no existe'),
    'la evidencia dice por que murio la premisa');
});

test('deferred solo escribe el ruling: la tarjeta queda intacta', () => {
  seed('T-9206');
  const before = card('T-9206');
  const until = new Date(Date.now() + 86400000).toISOString();
  const r = run(['decide', 'T-9206', '--ruling', 'deferred', '--why', 'la semana que viene',
    '--source', 'ledger-cli', '--until', until]);
  assert.strictEqual(r.code, 0, `${r.stderr}${r.stdout}`);
  assert.deepStrictEqual(card('T-9206'), before, 'ni un byte de la tarjeta');
  assert.strictEqual(rulingsFor('T-9206')[0].until, until);
});

test('deferred sin --until se rechaza y no escribe NADA', () => {
  seed('T-9207');
  const r = run(['decide', 'T-9207', '--ruling', 'deferred', '--why', 'despues', '--source', 'ledger-cli']);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(rulingsFor('T-9207').length, 0, 'una linea invalida no llega al archivo');
});

// ---------------------------------------------------------------------------
// La dependencia dura y el vocabulario
// ---------------------------------------------------------------------------

test('sin wezbridge/src/rulings.cjs REFUSA — nunca appendea crudo', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-wezbridge-'));
  seed('T-9208');
  const before = rulings().length;
  const r = run(['decide', 'T-9208', '--ruling', 'approved', '--why', 'x', '--source', 'ledger-cli'],
    { WEZBRIDGE_ROOT: empty });
  assert.notStrictEqual(r.code, 0, 'refusa ruidosamente');
  assert.match(`${r.stderr}${r.stdout}`, /rulings\.cjs/, 'y nombra el archivo que falta');
  assert.strictEqual(rulings().length, before, 'CERO appends crudos: dos validadores serian dos schemas');
  assert.strictEqual(card('T-9208').state, 'blocked', 'y la tarjeta tampoco se movio');
});

test('el vocabulario de decide es cerrado y los flags tambien', () => {
  seed('T-9209');
  const badRuling = run(['decide', 'T-9209', '--ruling', 'dispatched', '--why', 'x', '--source', 'ledger-cli']);
  assert.notStrictEqual(badRuling.code, 0, 'decide no despacha ni resuelve: eso no es una decision del operador');
  const badSource = run(['decide', 'T-9209', '--ruling', 'approved', '--why', 'x', '--source', 'curl']);
  assert.notStrictEqual(badSource.code, 0);
  const badFlag = run(['decide', 'T-9209', '--ruling', 'approved', '--why', 'x', '--source', 'ledger-cli', '--categoria', 'x']);
  assert.notStrictEqual(badFlag.code, 0, 'un flag inventado se rechaza, no se ignora (T-0282)');
  assert.match(badFlag.stderr, /unknown flag/);
  const noWhy = run(['decide', 'T-9209', '--ruling', 'approved', '--source', 'ledger-cli']);
  assert.notStrictEqual(noWhy.code, 0, 'una decision sin razon no es una decision');
  assert.strictEqual(rulingsFor('T-9209').length, 0, 'ninguno de los cuatro dejo rastro');
});

test('toda decision queda corroborada en operator-actions.jsonl', () => {
  // Un gate acepta la tarjeta como autoridad; el origen tiene que ser
  // comprobable por separado o "el operador autorizo" vuelve a ser la palabra
  // de quien escribio la tarjeta.
  seed('T-9210');
  const before = actions().length;
  const r = run(['decide', 'T-9210', '--ruling', 'approved', '--why', 'autorizado', '--source', 'ledger-cli']);
  assert.strictEqual(r.code, 0, `${r.stderr}${r.stdout}`);
  const mine = actions().filter((a) => a.task_id === 'T-9210');
  assert.strictEqual(mine.length, 1, `exactamente una entrada nueva (antes habia ${before})`);
  assert.strictEqual(mine[0].kind, 'decision');
  assert.ok(mine[0].text.includes('autorizado'));
});

test('una tarjeta inexistente deja el ruling escrito y lo dice', () => {
  const r = run(['decide', 'T-9299', '--ruling', 'cancelled', '--why', 'nunca existio', '--source', 'ledger-cli']);
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(rulingsFor('T-9299').length, 1, 'la decision del operador no se pierde porque falte el archivo');
});
