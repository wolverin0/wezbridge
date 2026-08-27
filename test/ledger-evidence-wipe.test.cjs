'use strict';
/**
 * El gate de evidencia no puede BORRAR la evidencia que exige.
 *
 * `ledger.cjs` fail-closed desde 2026-08-21 (commit a60de00, "unlazy
 * adoption"): `done` exige `--evidence`. Pero el chequeo y la escritura miran
 * cosas distintas:
 *
 *   :345  if (opts.evidence !== undefined) patch.evaluator_evidence = opts.evidence || null;
 *   :369  if (opts.state === 'done' && !(opts.evidence || task.evaluator_evidence)) throw ...
 *
 * Con `--evidence ""` sobre una tarjeta que YA tenía evidencia, el gate evalúa
 * `"" || task.evaluator_evidence` → truthy → pasa; después el patch escribe
 * `"" || null` → null. La tarjeta cierra en `done` con la evidencia borrada,
 * atravesando el gate que existe para impedir exactamente eso.
 *
 * No hace falta mala fe para llegar: `parseArgs` (:469-475) se traga el flag
 * siguiente cuando un valor arranca con `--`, así que un `--evidence` al que se
 * le olvidó el valor toma el flag que viene atrás.
 *
 * POR QUÉ ESTE TEST VIVE ACÁ Y NO EN `_docs-curation/test/`: ese directorio no
 * tiene package.json ni runner — sus 9 tests no los ejecuta ningún proceso.
 * `wezbridge/package.json` corre `node --test test/*.test.cjs`, y alcanzar el
 * ledger por CLI desde acá ya es el patrón establecido
 * (ledger-kind-vocabulary.test.cjs:23, clawtrol-bridge.test.cjs:24).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LEDGER = path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const REAL_INTEL = path.join(__dirname, '..', '..', '_intel');

/** Ledger descartable con el vocabulario REAL de kinds — nunca las tarjetas reales. */
function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-evwipe-'));
  fs.mkdirSync(path.join(d, 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(REAL_INTEL, 'kinds.json'), path.join(d, 'kinds.json'));
  return d;
}

const run = (dir, args) => execFileSync(process.execPath, [LEDGER, ...args], {
  env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir }, encoding: 'utf8', stdio: 'pipe',
});

const card = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'tasks', `${id}.json`), 'utf8'));

/** Una tarjeta recién creada, caminada hasta `review` (único camino legal a done). */
function upToReview(dir) {
  const out = run(dir, ['create', '--title', 'probe', '--goal', 'probe',
    '--kind', 'tooling-fix', '--blocked-by', 'agent']);
  const id = JSON.parse(out).id;
  run(dir, ['update', id, '--state', 'ready', '--blocked-by', 'agent']);
  run(dir, ['update', id, '--state', 'running', '--blocked-by', 'agent']);
  run(dir, ['update', id, '--state', 'review', '--blocked-by', 'agent']);
  return id;
}

const REAL_EVIDENCE = 'commit 9e1f477; suite 940 tests, 937 pass, 2 fail, 1 skip';

// --- A1: el fail-first ------------------------------------------------------
test('A1: --evidence "" no puede borrar la evidencia previa al cerrar', () => {
  const dir = sandbox();
  try {
    const id = upToReview(dir);
    run(dir, ['update', id, '--evidence', REAL_EVIDENCE]);
    assert.strictEqual(card(dir, id).evaluator_evidence, REAL_EVIDENCE, 'precondición');

    // El caso: cierro pasando una evidencia vacía explícita.
    try { run(dir, ['update', id, '--state', 'done', '--evidence', '']); } catch { /* rechazar también es válido */ }

    const after = card(dir, id);
    if (after.state === 'done') {
      assert.ok(after.evaluator_evidence,
        'una tarjeta cerrada NUNCA puede quedar sin evidencia: el gate existe para impedirlo');
      assert.strictEqual(after.evaluator_evidence, REAL_EVIDENCE,
        'la evidencia previa tiene que sobrevivir a un --evidence vacío');
    } else {
      assert.strictEqual(after.evaluator_evidence, REAL_EVIDENCE,
        'si el cierre se rechaza, la evidencia previa igual tiene que seguir intacta');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- A2: lo que ya funcionaba sigue funcionando -----------------------------
test('A2: done sin evidencia sigue rechazado, y la tarjeta NO transiciona', () => {
  const dir = sandbox();
  try {
    const id = upToReview(dir);
    assert.throws(() => run(dir, ['update', id, '--state', 'done']), /requires --evidence/);
    assert.strictEqual(card(dir, id).state, 'review',
      'un cierre rechazado no puede dejar la tarjeta a medio mover');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A3: done con evidencia real pasa y la persiste', () => {
  const dir = sandbox();
  try {
    const id = upToReview(dir);
    run(dir, ['update', id, '--state', 'done', '--evidence', REAL_EVIDENCE]);
    const after = card(dir, id);
    assert.strictEqual(after.state, 'done');
    assert.strictEqual(after.evaluator_evidence, REAL_EVIDENCE);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('A3b: una evidencia declarada en un update ANTERIOR sigue satisfaciendo el cierre', () => {
  // Comportamiento existente y deliberado (ledger-done-evidence.test.cjs:80-86).
  // Pineado acá para que el arreglo de A1 no lo rompa de costado.
  const dir = sandbox();
  try {
    const id = upToReview(dir);
    run(dir, ['update', id, '--evidence', REAL_EVIDENCE]);
    run(dir, ['update', id, '--state', 'done']);
    const after = card(dir, id);
    assert.strictEqual(after.state, 'done');
    assert.strictEqual(after.evaluator_evidence, REAL_EVIDENCE);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
