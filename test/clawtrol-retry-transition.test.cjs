'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0292 — el `retry` de clawtrol apunta a un estado sin aristas de entrada.
 *
 * `clawtrol-bridge.cjs:440` elige el destino asi:
 *     approve -> 'ready' | retry -> 'queued' | cancel -> 'cancelled'
 *
 * Pero `queued` NO ES DESTINO DE NINGUNA TRANSICION en la tabla del ledger
 * (`ledger.cjs:43-50`). Los destinos alcanzables son blocked, cancelled, done,
 * failed, ready, review y running. `queued` no esta. Asi que todo retry del
 * operador falla con "illegal transition", desde cualquier estado — y la propia
 * linea 442 detecta el error y lo devuelve, o sea que el codigo SABE que falla
 * y nadie lo arreglo.
 *
 * ESTE ARCHIVO MIDE EL COMPORTAMIENTO DESDE CADA ESTADO ABIERTO, en vez de
 * afirmar "falla siempre". Esa distincion importa: hay un estado donde NO da
 * error, y es peor que los que lo dan (ver el test del no-op silencioso).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Entorno aislado ANTES de requerir el modulo, mismo patron que
// clawtrol-bridge.test.cjs: intel temporal + copia del ledger REAL, para que la
// tabla del FSM que se prueba sea la de produccion y no una maqueta.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtrol-retry-'));
const INTEL = path.join(TMP, '_intel');
const LEDGER = path.join(TMP, '_docs-curation');
const REPO = path.join(TMP, 'fakerepo');
fs.mkdirSync(INTEL, { recursive: true });
fs.mkdirSync(LEDGER, { recursive: true });
fs.mkdirSync(path.join(REPO, '.agent-workflow'), { recursive: true });
const LEDGER_SRC = [
  path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(__dirname, '..', '..', '..', '_docs-curation', 'ledger.cjs'),
  path.join(__dirname, '..', '..', '..', '..', '..', '_docs-curation', 'ledger.cjs'),
].find((p) => fs.existsSync(p));
if (!LEDGER_SRC) throw new Error('cannot locate _docs-curation/ledger.cjs from this checkout');
fs.copyFileSync(LEDGER_SRC, path.join(LEDGER, 'ledger.cjs'));
fs.writeFileSync(path.join(LEDGER, 'sweeper-config.json'), JSON.stringify({
  root: TMP, repos: [{ name: 'fakerepo', path: 'fakerepo' }],
}));
fs.writeFileSync(path.join(REPO, '.agent-workflow', 'graph.json'), JSON.stringify({
  version: 1, repo: 'fakerepo', defaults: { mode: 'scoped_write' },
  kinds: { 'safe-kind': { mode: 'read_mostly', gate: null } },
}));
process.env.WEZBRIDGE_INTEL_DIR = INTEL;
process.env.WEZBRIDGE_LEDGER_DIR = LEDGER;
const bridge = require('../src/clawtrol-bridge.cjs');

const cardFile = (id) => path.join(INTEL, 'tasks', `${id}.json`);
const card = (id) => JSON.parse(fs.readFileSync(cardFile(id), 'utf8'));

/** Escribe el estado directo en disco: preparar el escenario no es lo que se prueba. */
function cardInState(id, state, extra = {}) {
  fs.mkdirSync(path.join(INTEL, 'tasks'), { recursive: true });
  fs.writeFileSync(cardFile(id), JSON.stringify({
    id, title: 'para reintentar', goal: 'x', kind: 'safe-kind', repo: 'fakerepo',
    state, blocked_by: 'agent', acceptance_criteria: ['algo medible'],
    lease: null, attempt: 1, ...extra,
  }, null, 2));
  return id;
}

const retry = (id, n) => bridge.applyIntent({
  id: `i-retry-${n}`, kind: 'retry', payload: { task_id: id },
});

/** Los estados abiertos desde los que un operador puede pedir un reintento. */
const OPEN_STATES = ['queued', 'ready', 'running', 'review', 'blocked', 'failed'];

test('el retry del operador ATERRIZA desde cada estado abierto que la tabla permite', async () => {
  // El fail-first: hoy `retry` apunta a `queued`, que no es destino de ninguna
  // arista, asi que esto falla desde TODOS los estados menos uno.
  const roto = [];
  for (const state of OPEN_STATES) {
    if (state === 'running') continue; // caso propio abajo: el lease manda
    const id = cardInState(`T-10${OPEN_STATES.indexOf(state)}0`, state);
    const r = await retry(id, `${state}`);
    if (r.status !== 'applied') roto.push(`${state}: ${String(r.result.reason).slice(0, 90)}`);
  }
  assert.deepStrictEqual(roto, [],
    'el retry del operador no aterriza desde estos estados:\n  ' + roto.join('\n  '));
});

test('y la tarjeta queda REALMENTE reintentable, no sólo con exit 0', async () => {
  // Un `applied` que deja la tarjeta donde estaba es la misma clase de mentira
  // que T-0282: hay que mirar el disco, no el status devuelto.
  const id = cardInState('T-1100', 'failed');
  const r = await retry(id, 'landing');
  assert.strictEqual(r.status, 'applied', `retry rechazado: ${r.result && r.result.reason}`);
  const after = card(id);
  assert.ok(['ready', 'queued'].includes(after.state),
    `la tarjeta quedó en "${after.state}": un reintento tiene que dejarla tomable por un agente`);
});

test('EL PEOR CASO: desde `queued` el retry no da error, no hace nada, y reporta éxito', async () => {
  // `update` sólo valida la transición cuando el estado CAMBIA
  // (`opts.state !== task.state`), así que queued -> queued pasa como no-op.
  // O sea que el único estado donde el retry roto NO grita es aquel donde
  // silenciosamente no hace nada — y le devuelve `applied` al operador.
  // Con el destino en `ready` este caso pasa a mover la tarjeta de verdad.
  const id = cardInState('T-1200', 'queued');
  const r = await retry(id, 'noop');
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(card(id).state, 'ready',
    'el retry desde queued dejó la tarjeta en queued: exit 0, nada movido, y el operador '
    + 'convencido de que reintentó');
});

test('el contador de intentos SUBE: un reintento que no se cuenta es invisible', async () => {
  // `ledger.cjs:427` incrementa `attempt` SOLO en failed -> ready, y es el único
  // escritor del campo después de la creación. clawtrol muestra ese contador de
  // vuelta al operador (`clawtrol-bridge.cjs:493`) y fleet-status lo renderiza
  // (`:103`). Ese es el argumento medido contra abrir `-> queued`: un segundo
  // camino de reintento que no toca `attempt` deja los reintentos del operador
  // fuera del tablero que el propio clawtrol dibuja.
  const id = cardInState('T-1300', 'failed', { attempt: 2 });
  await retry(id, 'attempt');
  assert.strictEqual(card(id).attempt, 3,
    'el reintento no incrementó attempt: el operador no puede ver cuántas veces se reintentó, '
    + 'y max_repair_cycles deja de poder frenar un bucle');
});

test('desde `running` el retry se RECHAZA con una razón legible, y no toca la tarjeta', async () => {
  // Comportamiento deliberado, no un descuido: running -> ready no está en la
  // tabla. Una tarjeta corriendo tiene dueño; reintentarla de un saque le
  // pisaría el trabajo a quien la tiene. El camino honesto es running -> failed
  // (o review) y recién ahí reintentar, y eso lo decide alguien, no un intent.
  // Se fija acá para que sea una decisión documentada y no una sorpresa.
  const id = cardInState('T-1400', 'running');
  const r = await retry(id, 'running');
  assert.notStrictEqual(r.status, 'applied');
  assert.match(r.result.reason, /illegal transition|ledger error/i);
  assert.strictEqual(card(id).state, 'running', 'un rechazo no puede dejar la tarjeta a medio mover');
});

test('approve y cancel siguen intactos: el arreglo no puede tocarlos', async () => {
  const a = cardInState('T-1500', 'blocked');
  const okA = await bridge.applyIntent({ id: 'i-appr', kind: 'approve', payload: { task_id: a } });
  assert.strictEqual(okA.status, 'applied', `approve rechazado: ${okA.result && okA.result.reason}`);
  assert.strictEqual(card(a).state, 'ready');

  const c = cardInState('T-1600', 'queued');
  const okC = await bridge.applyIntent({ id: 'i-canc', kind: 'cancel', payload: { task_id: c } });
  assert.strictEqual(okC.status, 'applied', `cancel rechazado: ${okC.result && okC.result.reason}`);
  assert.strictEqual(card(c).state, 'cancelled');
});

test('el estado que clawtrol REPORTA es el que quedó en disco', async () => {
  // `:444` devuelve `task_state: target`, o sea el estado que PIDIÓ, no el que
  // consiguió. Mientras el destino era imposible eso no se notaba porque el
  // rechazo salía antes; con el destino correcto tiene que coincidir de verdad.
  const id = cardInState('T-1700', 'review');
  const r = await retry(id, 'report');
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(r.result.task_state, card(id).state,
    'clawtrol le reporta al operador un estado distinto del que quedó en el ledger');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('T-0293: clawtrol DICE cuando la tarjeta ya estaba en el estado pedido', async () => {
  // Cierra el silencio que hacía que el retry roto pareciera funcionar. Sigue
  // siendo `applied` —pedir un estado que ya se tiene es benigno— pero ahora el
  // operador ve que nada se movió, en vez de leer un éxito indistinguible.
  const id = cardInState('T-1800', 'ready');
  const r = await retry(id, 'unchanged');
  assert.strictEqual(r.status, 'applied', `un no-op benigno no puede volverse error: ${r.result && r.result.reason}`);
  assert.strictEqual(card(id).state, 'ready');
  assert.match(String(r.result.note || ''), /nothing moved/,
    'clawtrol le reportó al operador un "applied" liso sobre una tarjeta que no se movió');
});

test('T-0293: una transición REAL no lleva esa nota', async () => {
  const id = cardInState('T-1900', 'failed');
  const r = await retry(id, 'moved');
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(card(id).state, 'ready');
  assert.strictEqual(r.result.note, undefined,
    'si la nota apareciera también en un movimiento real no distinguiría nada');
});
