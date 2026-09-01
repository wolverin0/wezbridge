'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0296 — clawtrol le reporta al operador el estado que PIDIO.
 *
 * `clawtrol-bridge.cjs:475` devuelve `task_state: target`, o sea el objetivo del
 * intent, y `:415` lee el estado de un regex sobre el stdout del ledger. Es el
 * mismo defecto que T-0293 cerro en el retorno de `update()` —confundir la
 * intencion con el resultado— pero una capa MAS ARRIBA: en lo que el operador
 * LEE. Ahi importa mas, porque lo que el ve es la unica base de su proxima
 * decision.
 *
 * ES LATENTE, Y MAS QUE T-0294. Lo busque y NO PUDE construir, con el ledger
 * real, un caso donde el estado conseguido difiera del pedido por el camino de
 * transicion: `update --state X` o aterriza en X o falla, asi que hoy `target`
 * nunca miente. Lo digo en vez de fabricar un rojo y presentarlo como si fuera
 * una divergencia viva. Lo que esta mal es el MECANISMO —reportar la intencion
 * en vez de la respuesta— y eso se rompe apenas el ledger fuerce un estado, que
 * es algo que YA HACE por el otro camino: un kind gateado nace `blocked` sin
 * importar lo que pida el caller.
 *
 * COMO SE PRUEBA, Y POR QUE ES LEGITIMO. `ledgerDir()` resuelve el env en cada
 * llamada, asi que el test le da al bridge un ledger STUB que escribe la tarjeta
 * en un estado y responde con ese estado, mientras el intent pidio otro. Eso no
 * es fabricar datos: es un doble de prueba para la pregunta exacta de esta
 * tarjeta — ¿el llamador le cree a su propio pedido o a la respuesta de quien
 * ejecuta? Los demas tests corren contra el ledger REAL.
 *
 * Y ahora hay una senal mejor que un regex: T-0293 hizo que el retorno declare
 * `state_unchanged`, asi que el ledger ya dice si movio algo. Se lee de ahi.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtrol-actual-'));
const INTEL = path.join(TMP, '_intel');
const LEDGER = path.join(TMP, '_docs-curation');
const REPO = path.join(TMP, 'fakerepo');
fs.mkdirSync(path.join(INTEL, 'tasks'), { recursive: true });
fs.mkdirSync(LEDGER, { recursive: true });
fs.mkdirSync(path.join(REPO, '.agent-workflow'), { recursive: true });
const LEDGER_SRC = [
  path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(__dirname, '..', '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(__dirname, '..', '..', '..', '..', '..', '_docs-curation', 'ledger.cjs'),
].find((p) => fs.existsSync(p));
if (!LEDGER_SRC) throw new Error('cannot locate _docs-curation/ledger.cjs from this checkout');
fs.copyFileSync(LEDGER_SRC, path.join(LEDGER, 'ledger.cjs'));
fs.copyFileSync(path.join(__dirname, '..', '..', '_intel', 'kinds.json'), path.join(INTEL, 'kinds.json'));
fs.writeFileSync(path.join(LEDGER, 'sweeper-config.json'), JSON.stringify({
  root: TMP, repos: [{ name: 'fakerepo', path: 'fakerepo' }],
}));
fs.writeFileSync(path.join(REPO, '.agent-workflow', 'graph.json'), JSON.stringify({
  version: 1, repo: 'fakerepo', defaults: { mode: 'scoped_write' },
  kinds: { 'safe-kind': { mode: 'read_mostly', gate: null }, deploy: { mode: 'none', gate: 'operator' } },
}));
process.env.WEZBRIDGE_INTEL_DIR = INTEL;
process.env.WEZBRIDGE_LEDGER_DIR = LEDGER;
const bridge = require('../src/clawtrol-bridge.cjs');

const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(INTEL, 'tasks', `${id}.json`), 'utf8'));

function cardInState(id, state, extra = {}) {
  fs.writeFileSync(path.join(INTEL, 'tasks', `${id}.json`), JSON.stringify({
    id, title: 'x', goal: 'y', kind: 'safe-kind', repo: 'fakerepo', state,
    blocked_by: 'agent', acceptance_criteria: ['medible'], lease: null, attempt: 1, ...extra,
  }, null, 2));
  return id;
}

/**
 * Un ledger de mentira que escribe `landsIn` y RESPONDE `landsIn`, sin importar
 * el `--state` que le pidan. Es el doble que responde la pregunta de la tarjeta:
 * ¿el bridge le cree a su pedido o a la respuesta?
 */
function withStubLedger(landsIn, fn) {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-ledger-'));
  const stub = `
const fs = require('node:fs'); const path = require('node:path');
const id = process.argv[3];
const file = path.join(process.env.WEZBRIDGE_INTEL_DIR, 'tasks', id + '.json');
const t = JSON.parse(fs.readFileSync(file, 'utf8'));
t.state = ${JSON.stringify(landsIn)};
fs.writeFileSync(file, JSON.stringify(t, null, 2));
console.log(JSON.stringify(t, null, 2));
`;
  fs.writeFileSync(path.join(stubDir, 'ledger.cjs'), stub);
  const prev = process.env.WEZBRIDGE_LEDGER_DIR;
  process.env.WEZBRIDGE_LEDGER_DIR = stubDir;
  return Promise.resolve(fn()).finally(() => {
    process.env.WEZBRIDGE_LEDGER_DIR = prev;
    fs.rmSync(stubDir, { recursive: true, force: true });
  });
}

// --- el fail-first ----------------------------------------------------------

test('el estado reportado sale de la RESPUESTA del ledger, no del pedido', async () => {
  // El intent pide `ready`; el ledger aterriza la tarjeta en `blocked`. Hoy
  // clawtrol reporta `ready` porque devuelve su propia variable `target`.
  const id = cardInState('T-2000', 'queued');
  await withStubLedger('blocked', async () => {
    const r = await bridge.applyIntent({ id: 'i-a1', kind: 'approve', payload: { task_id: id } });
    assert.strictEqual(r.status, 'applied');
    assert.strictEqual(r.result.task_state, 'blocked',
      `clawtrol le reportó al operador "${r.result.task_state}" cuando el ledger dejó la tarjeta `
      + `en "${onDisk(id).state}". El operador decide sobre lo que lee`);
  });
});

test('y coincide con el disco, que es la única autoridad', async () => {
  const id = cardInState('T-2010', 'queued');
  await withStubLedger('failed', async () => {
    const r = await bridge.applyIntent({ id: 'i-a2', kind: 'approve', payload: { task_id: id } });
    assert.strictEqual(r.result.task_state, onDisk(id).state);
  });
});

test('si la respuesta del ledger no se puede leer, se reporta null y no el pedido', async () => {
  // "No sé" es honesto; repetir el pedido es inventar. Un estado inventado es
  // peor que ninguno, porque el operador no puede distinguirlo de uno medido.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-mudo-'));
  fs.writeFileSync(path.join(stubDir, 'ledger.cjs'), 'process.stdout.write("sin json aca");\n');
  const prev = process.env.WEZBRIDGE_LEDGER_DIR;
  process.env.WEZBRIDGE_LEDGER_DIR = stubDir;
  try {
    const id = cardInState('T-2020', 'queued');
    const r = await bridge.applyIntent({ id: 'i-a3', kind: 'approve', payload: { task_id: id } });
    assert.strictEqual(r.result.task_state, null,
      'sin respuesta legible del ledger, clawtrol repitió el estado que había pedido');
  } finally {
    process.env.WEZBRIDGE_LEDGER_DIR = prev;
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('create_task también reporta lo que el ledger escribió, no lo que se pidió', async () => {
  // Este camino SÍ tiene divergencia real y no fabricada: un kind gateado nace
  // `blocked` aunque el intent no lo pida. Se leía por regex sobre stdout —
  // funcionaba, pero por scraping en vez de por la respuesta parseada.
  const r = await bridge.applyIntent({
    id: 'i-c1', kind: 'create_task',
    payload: { repo: 'fakerepo', kind: 'deploy', title: 'desplegar', brief: 'subir a prod' },
  });
  assert.strictEqual(r.status, 'applied', `create falló: ${r.result && r.result.reason}`);
  assert.strictEqual(r.result.task_state, 'blocked', 'un kind gateado nace blocked, lo pida el intent o no');
  assert.strictEqual(r.result.task_state, onDisk(r.result.task_id).state);
});

// --- se usa la señal de T-0293, no un regex ---------------------------------

test('el no-op se lee de `state_unchanged`, la señal que el ledger ya declara', async () => {
  const id = cardInState('T-2030', 'ready');
  const r = await bridge.applyIntent({ id: 'i-r1', kind: 'retry', payload: { task_id: id } });
  assert.strictEqual(r.status, 'applied');
  assert.match(String(r.result.note || ''), /nothing moved/);
  assert.strictEqual(r.result.task_state, 'ready');
});

test('una transición REAL no lleva la nota y reporta el estado nuevo', async () => {
  const id = cardInState('T-2040', 'failed');
  const r = await bridge.applyIntent({ id: 'i-r2', kind: 'retry', payload: { task_id: id } });
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(r.result.note, undefined);
  assert.strictEqual(r.result.task_state, 'ready');
  assert.strictEqual(onDisk(id).state, 'ready');
});

// --- lo que no puede romperse (T-0292 sigue verde) --------------------------

test('approve y cancel siguen aplicando y reportando el estado real', async () => {
  const a = cardInState('T-2050', 'blocked');
  const okA = await bridge.applyIntent({ id: 'i-ap', kind: 'approve', payload: { task_id: a } });
  assert.strictEqual(okA.status, 'applied', okA.result && okA.result.reason);
  assert.strictEqual(okA.result.task_state, onDisk(a).state);
  assert.strictEqual(onDisk(a).state, 'ready');

  const c = cardInState('T-2060', 'queued');
  const okC = await bridge.applyIntent({ id: 'i-ca', kind: 'cancel', payload: { task_id: c } });
  assert.strictEqual(okC.status, 'applied', okC.result && okC.result.reason);
  assert.strictEqual(okC.result.task_state, onDisk(c).state);
  assert.strictEqual(onDisk(c).state, 'cancelled');
});

test('una transición ilegal sigue rechazándose y no reporta estado', async () => {
  const id = cardInState('T-2070', 'running');
  const r = await bridge.applyIntent({ id: 'i-il', kind: 'retry', payload: { task_id: id } });
  assert.notStrictEqual(r.status, 'applied');
  assert.strictEqual(onDisk(id).state, 'running', 'un rechazo no puede dejar la tarjeta a medio mover');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
