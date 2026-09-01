'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0295 — el plano de control no lo validaba nadie.
 *
 * `_intel` es repo git propio con 273 tarjetas y `rulings.jsonl`, y ningun
 * proceso validaba su FORMA. Misma familia que T-0291 (un artefacto que nadie
 * ejecuta) pero sobre los DATOS en vez del codigo. Corre desde esta suite y no
 * desde un runner propio por la misma razon que alli: `node --test
 * test/*.test.cjs` es el `evaluator` declarado en el contrato de todas las
 * tarjetas, o sea la unica forcing function que existe.
 *
 * EL ALCANCE SE ELIGIO MIDIENDO, y es la parte que decide si esto sobrevive.
 * Contadas las violaciones de cada invariante candidato sobre las 273 tarjetas:
 *
 *   0   id malformado / id != archivo / state invalido / kind invalido
 *   0   fechas no parseables / lease sin vencimiento / depends_on colgado
 *   0   JSON no parseable            <- los datos NO estan corruptos
 *   3   ABIERTAS sin blocked_by      <- T-0229, T-0241, T-0253: el hallazgo vivo
 *  16   sin repo   (11 abiertas)     \
 *  93   sin criterios (16 abiertas)   > deuda heredada, anterior a los guards
 *  60   cerradas sin evidencia       /
 *
 * Un fail-closed sobre las tres ultimas NACE ROJO por 93 filas que ya no se
 * pueden cambiar, y un guard que dispara sobre lo inmodificable se desactiva en
 * una semana. Por eso la deuda se CUENTA y no gatea — y hay un test abajo que
 * lo fija, para que nadie la "mejore" convirtiendola en gate.
 *
 * El corte no es un acto de fe: `repo` se volvio fail-closed en `create()` el
 * 2026-08-28 (T-0282), asi que para tarjetas creadas DESPUES si es exigible.
 * Mismo patron de epoca que `dispatch-lint` usa para no retro-marcar. `criteria`
 * NO lleva epoca a proposito: el operador decidio que no fuera obligatorio.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { validate, validateDir, REPO_REQUIRED_SINCE } = require('../scripts/validate-intel.cjs');

/** Una fila valida; cada test rompe UN campo, para que el rojo nombre la causa. */
const row = (over = {}, file) => {
  const task = {
    id: 'T-0001', title: 't', goal: 'g', kind: 'general', repo: 'wezbridge',
    state: 'ready', blocked_by: 'agent', acceptance_criteria: ['medible'],
    lease: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
  return { file: file || `${task.id}.json`, task };
};
const rules = (rows, opts) => validate(rows, opts).violations.map((v) => v.rule).sort();

// --- el hallazgo vivo -------------------------------------------------------

test('el plano de control VIVO no tiene tarjetas abiertas sin blocked_by', () => {
  // `blocked_by` es —por el comentario del propio ledger— el UNICO campo que
  // mide si la orquestacion funciona: cuantas tareas esperan al operador. Una
  // fila abierta sin el esta fuera de esa cuenta, y como `assertBlockedBy` falla
  // cerrado en `writeTask`, solo pudo entrar editando el JSON a mano.
  const r = validateDir();
  assert.notEqual(r.rows, null, 'no se encontró _intel/tasks: el validador no puede saltearse en silencio');
  const sinBlockedBy = r.violations.filter((v) => v.rule === 'abierta-sin-blocked_by');
  assert.deepEqual(sinBlockedBy.map((v) => v.id), [],
    `tarjetas ABIERTAS invisibles a la métrica de la flota: ${sinBlockedBy.map((v) => `${v.id} (${v.detail})`).join(', ')}`);
});

test('el plano de control VIVO no tiene ninguna otra violación', () => {
  const r = validateDir();
  assert.deepEqual(r.violations.map((v) => `${v.id}:${v.rule}`), [],
    'el ledger vivo dejó de cumplir un invariante que hoy cumple entero');
});

// --- que cada regla dispare de verdad ---------------------------------------

test('capa 1: los invariantes universales atrapan lo suyo', () => {
  assert.deepEqual(rules([row({ id: 'T-LOOP-STALL' }, 'T-LOOP-STALL.json')]), ['id-malformado']);
  assert.deepEqual(rules([row({}, 'T-0999.json')]), ['id-no-coincide-con-archivo']);
  assert.deepEqual(rules([row({ state: 'inventado' })]), ['state-invalido']);
  assert.deepEqual(rules([row({ kind: 'inventado' })], { kinds: ['general'] }), ['kind-fuera-de-vocabulario']);
  assert.deepEqual(rules([row({ created_at: 'ayer' })]), ['fecha-no-parseable']);
  assert.deepEqual(rules([row({ lease: { owner: 'pane-7' } })]), ['lease-sin-vencimiento']);
  assert.deepEqual(rules([row({ depends_on: ['T-9999'] })]), ['depends_on-inexistente']);
});

test('capa 1: un depends_on que SÍ existe no se marca', () => {
  // El guard no puede disparar sobre lo correcto: la dependencia legítima entre
  // tarjetas es el caso normal, no la excepción.
  const rows = [row({ id: 'T-0001', depends_on: ['T-0002'] }), row({ id: 'T-0002' }, 'T-0002.json')];
  assert.deepEqual(rules(rows), []);
});

test('capa 2: blocked_by se exige en ABIERTAS y se ignora en cerradas', () => {
  for (const state of ['queued', 'ready', 'running', 'review', 'blocked']) {
    assert.deepEqual(rules([row({ state, blocked_by: null })]), ['abierta-sin-blocked_by'], `state=${state}`);
  }
  // done/failed/cancelled quedan exentas — el mismo recorte que assertBlockedBy.
  for (const state of ['done', 'failed', 'cancelled']) {
    assert.deepEqual(rules([row({ state, blocked_by: null })]), [], `state=${state} no debe exigirlo`);
  }
  assert.deepEqual(rules([row({ blocked_by: 'inventado' })]), ['abierta-sin-blocked_by'],
    'el vocabulario es cerrado: un valor inventado no cuenta como declarado');
});

// --- la decisión de diseño, fijada para que nadie la "mejore" ---------------

test('capa 3: la deuda heredada se CUENTA y NO gatea', () => {
  // Si esto pasara a gatear, el validador nacería rojo por 93 filas que ya no se
  // pueden cambiar, y en una semana alguien lo desactiva. La deuda se mide para
  // que se vea, no para trabar el gate.
  const legacy = [
    row({ id: 'T-0001', repo: null, acceptance_criteria: [], created_at: '2026-07-01T00:00:00Z' }),
    row({ id: 'T-0002', state: 'done', blocked_by: null, evaluator_evidence: '', created_at: '2026-07-01T00:00:00Z' }, 'T-0002.json'),
  ];
  const r = validate(legacy);
  assert.deepEqual(r.violations, [], 'la deuda heredada NO puede producir violaciones');
  assert.equal(r.debt.sin_repo, 1);
  assert.equal(r.debt.sin_criterios, 1);
  assert.equal(r.debt.done_sin_evidencia, 1);
});

test('capa 3: `repo` SÍ se exige a las creadas después de que el guard existió', () => {
  // El corte por época es lo que hace que "no gatear la deuda" no sea confiar:
  // una violación nueva sólo puede venir de esquivar el ledger.
  const antes = row({ id: 'T-0001', repo: null, created_at: new Date(REPO_REQUIRED_SINCE - 1000).toISOString() });
  const despues = row({ id: 'T-0002', repo: null, created_at: new Date(REPO_REQUIRED_SINCE + 1000).toISOString() }, 'T-0002.json');
  assert.deepEqual(rules([antes]), [], 'una tarjeta anterior al guard no puede marcarse retroactivamente');
  assert.deepEqual(rules([despues]), ['sin-repo-post-guard']);
});

test('`criteria` NO lleva época: exigirlo contradiría la decisión del operador', () => {
  // En T-0282 se decidió a propósito que los criterios no fueran obligatorios en
  // `create()`, porque exigirlos cambia el flujo del operador vía clawtrol. Este
  // validador no puede reponer por la ventana lo que se decidió por la puerta.
  const nueva = row({ acceptance_criteria: [], created_at: new Date(REPO_REQUIRED_SINCE + 1000).toISOString() });
  assert.deepEqual(rules([nueva]), []);
});

// --- el validador no puede fallar hacia el silencio -------------------------

test('un JSON roto es una violación, no una tarjeta que se saltea', () => {
  assert.deepEqual(rules([{ file: 'T-0001.json', task: null, parseError: 'Unexpected token' }]), ['json-parse']);
});

test('sin _intel el resultado dice rows:null, y el test de arriba lo vuelve rojo', () => {
  const r = validateDir(require('node:os').tmpdir());
  assert.equal(r.rows, null, 'un directorio sin tasks/ no puede devolver "0 violaciones"');
});

test('las tarjetas fuera de git se CUENTAN, y no saber no se confunde con cero', () => {
  // Encontrado ejecutando esta tarjeta: 113 de 273 tarjetas existen en disco y
  // NO en git — T-0183 en adelante, ~10 días de trabajo de la flota, mientras
  // `rulings.jsonl` sí está versionado. Es el defecto de T-0291 un nivel más
  // arriba: el diseño entero dice "las sesiones son descartables, los archivos
  // son la memoria", y el 41% de esa memoria se va con un `git clean`.
  //
  // Se cuenta y NO gatea, como el resto de la capa 3: son filas heredadas y un
  // gate que nace rojo se desactiva. Pero queda dicho en cada corrida.
  const r = validateDir();
  assert.ok(r.debt.sin_trackear === null || Number.isInteger(r.debt.sin_trackear),
    'el contador es un número o null; nunca undefined');
  assert.deepEqual(r.violations.filter((v) => /trackear/.test(v.rule)), [],
    'estar fuera de git no puede gatear: son 113 filas heredadas');

  // Y lo que importa más que el número: no poder preguntarle a git tiene que
  // devolver null, no 0. Un cero inventado diría "están todas versionadas".
  const sinRepoGit = validateDir(require('node:os').tmpdir());
  assert.equal(sinRepoGit.rows, null);
});
