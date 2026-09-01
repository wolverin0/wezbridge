'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * ledger-lease-owner.test.cjs — QUIEN puede sostener una lease del ledger.
 *
 * Tres formas y ninguna mas: `pane-N` (un pane de WezTerm), `<executor>:<id>`
 * (un ejecutor remoto, p.ej. `eve:JOB-...`, la convencion del plan para Eve) y
 * un slug de proyecto DECLARADO en `_intel/repos.json` (la forma que usa
 * `takeDispatchLease`). Hasta W1-h el campo no se validaba NADA: `--owner bob`
 * se persistia igual y `lease-reconcile` despues no podia decir si ese dueno
 * vivia. Leer cuando se toque `lease` en ledger.cjs o el parseo de owners de
 * lease-reconcile.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-lease-'));
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

// El registro de proyectos ES parte del contrato del owner: `takeDispatchLease`
// prefiere el nombre de proyecto sobre el pane id (los pane id mueren al
// reiniciar wezterm, T-0235), asi que un slug DECLARADO tiene que entrar.
fs.writeFileSync(path.join(INTEL, 'repos.json'), JSON.stringify({
  version: 1, repos: { wezbridge: { path: 'wezbridge', status: 'active' }, memorymaster: { path: 'memorymaster', status: 'active' } },
}, null, 2));

const ENV = { ...process.env, WEZBRIDGE_INTEL_DIR: INTEL, WEZBRIDGE_ROOT: REPO_ROOT };

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [LEDGER, ...args], { encoding: 'utf8', env: ENV }), stderr: '' };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

let n = 0;
/** Una tarjeta nueva por caso: una lease viva enmascara el error del siguiente. */
function seed() {
  n += 1;
  const id = `T-95${String(n).padStart(2, '0')}`;
  fs.writeFileSync(path.join(INTEL, 'tasks', `${id}.json`), JSON.stringify({
    id, title: 'para leasear', goal: 'g', kind: 'general', repo: 'wezbridge',
    state: 'running', blocked_by: 'agent', acceptance_criteria: ['algo medible'],
    lease: null, attempt: 1,
  }, null, 2));
  return id;
}

const owner = (id) => JSON.parse(fs.readFileSync(path.join(INTEL, 'tasks', `${id}.json`), 'utf8')).lease;

test('eve:JOB queda persistido VERBATIM: el relay necesita ese jobId exacto', () => {
  const id = seed();
  const r = run(['lease', id, '--owner', 'eve:JOB-drill-8', '--minutes', '240']);
  assert.strictEqual(r.code, 0, `${r.stderr}`);
  assert.strictEqual(owner(id).owner, 'eve:JOB-drill-8',
    'ni normalizado ni recortado: el jobId es el nombre de la llamada a FinalOrchestra');
  assert.ok(Number.isFinite(Date.parse(owner(id).expires_at)));
});

test('pane-7 sigue funcionando: la forma vieja no se rompe', () => {
  const id = seed();
  assert.strictEqual(run(['lease', id, '--owner', 'pane-7']).code, 0);
  assert.strictEqual(owner(id).owner, 'pane-7');
});

test('lease refuses an owner that is neither a pane nor an executor', () => {
  // ASESINO de la mutacion "quitar la validacion de owner". Hasta W1-h esto se
  // guardaba tal cual y recien se descubria en lease-reconcile, que no puede
  // verificar la vivacidad de un dueno que no sabe leer: la tarjeta quedaba
  // sostenida por un nombre que no le pertenece a nadie.
  const id = seed();
  const r = run(['lease', id, '--owner', 'bob']);
  assert.notStrictEqual(r.code, 0, '"bob" no es un pane ni un ejecutor');
  assert.match(r.stderr, /pane-N/, 'el error nombra las formas aceptadas');
  assert.match(r.stderr, /eve:/, `y da el ejemplo del ejecutor: ${r.stderr}`);
  assert.match(r.stderr, /repos\.json/, 'y la tercera forma, para que nadie la descubra rompiendo el despacho');
  assert.strictEqual(owner(id), null, 'y no dejo lease escrita');
});

test('las formas son estrictas: mayusculas, vacios y basura se rechazan', () => {
  for (const bad of ['Pane-7', 'pane-', 'pane-x', 'EVE:JOB-1', 'eve:', 'eve:JOB 1', ':JOB-1', '  ', '--minutes']) {
    const id = seed();
    const r = run(['lease', id, '--owner', bad]);
    assert.notStrictEqual(r.code, 0, `"${bad}" fue aceptado como owner`);
    assert.strictEqual(owner(id), null, `"${bad}" dejo lease escrita`);
  }
});

test('un slug de proyecto DECLARADO entra; uno inventado no', () => {
  // Sin esto la validacion romperia el camino vivo: `a2a_send to_project X`
  // toma la lease con el nombre del proyecto, y 6 de las 10 leases vivas del
  // 2026-09-01 tienen esa forma (memorymaster, brlite, finalorchestra, yolo26).
  // `bob` y `memorymaster` son la MISMA forma; lo que los separa es el registro.
  const good = seed();
  assert.strictEqual(run(['lease', good, '--owner', 'memorymaster']).code, 0,
    'un proyecto del registro es un dueno legitimo');
  assert.strictEqual(owner(good).owner, 'memorymaster');
  const bad = seed();
  assert.notStrictEqual(run(['lease', bad, '--owner', 'noexiste']).code, 0,
    'un slug que no esta en repos.json no es nadie');
  assert.strictEqual(owner(bad), null);
});

test('otros ejecutores entran por la misma puerta, sin tocar el codigo', () => {
  // La forma es `<executor>:<id>`, no una lista de nombres: agregar un ejecutor
  // nuevo no puede exigir un release del ledger.
  for (const good of ['codex:run_01ABC', 'eve:JOB-90a5db8f', 'worker:a.b_c-1']) {
    const id = seed();
    assert.strictEqual(run(['lease', id, '--owner', good]).code, 0, `"${good}" deberia entrar`);
    assert.strictEqual(owner(id).owner, good);
  }
});

test('sin --owner sigue siendo un error, ahora con el texto completo', () => {
  const id = seed();
  const r = run(['lease', id]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /pane-N/);
});
