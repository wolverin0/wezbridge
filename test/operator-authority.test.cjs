'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * Una tarjeta del ledger es la unica autoridad que un gate acepta, asi que su
 * origen tiene que ser comprobable sin creerle a quien la escribio.
 *
 * Medido el 2026-08-25: un pane ejecutor recibio "el operador autorizo" por A2A
 * y lo rechazo con razon — un par no levanta un gate del operador. Se creo
 * entonces la tarjeta T-0262, el pane la verifico, y encontro que NO habia
 * registro corroborante: operator-actions.jsonl tenia 3 entradas de agosto y
 * nada lo escribia desde el dia 16. Un log de auditoria que nadie alimenta
 * responde "no autorizado" a toda consulta y ensena a ignorarlo.
 *
 * Estos tests fijan el circuito: crear con --operator-decision graba el
 * registro, y buscarlo lo encuentra por id de tarjeta.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withTempIntel(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-authority-'));
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  // El modulo lee INTEL al cargarse, asi que hay que reimportarlo por temp dir.
  const modPath = require.resolve('../../_docs-curation/ledger.cjs');
  delete require.cache[modPath];
  const ledger = require(modPath);
  try {
    return fn(ledger, dir);
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = prev;
    delete require.cache[modPath];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('crear una tarjeta con decision del operador deja el registro corroborante', () => {
  withTempIntel((ledger, dir) => {
    const task = ledger.create({ repo: 'wezbridge', criteria: 'algo medible',
      title: 'limpiar filas en una base de terceros',
      goal: 'objetivo verificable',
      'blocked-by': 'agent',
      'operator-decision': 'AskUserQuestion: "Limpiar con dump previo y evidencia"',
    });
    const file = path.join(dir, 'operator-actions.jsonl');
    assert.ok(fs.existsSync(file), 'el registro tiene que existir, no depender de que alguien se acuerde');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
    assert.strictEqual(rec.task_id, task.id);
    assert.strictEqual(rec.source, 'ledger.cjs');
    assert.match(rec.text, /dump previo/);
  });
});

test('operatorDecisionsFor encuentra la corroboracion por id de tarjeta', () => {
  withTempIntel((ledger) => {
    const task = ledger.create({ repo: 'wezbridge', criteria: 'algo medible',
      title: 'con autoridad', goal: 'g', 'blocked-by': 'agent',
      'operator-decision': 'autorizado en vivo',
    });
    const otra = ledger.create({ repo: 'wezbridge', criteria: 'algo medible', title: 'sin autoridad', goal: 'g', 'blocked-by': 'agent' });
    assert.strictEqual(ledger.operatorDecisionsFor(task.id).length, 1);
    // Una tarjeta que NO trae decision no debe parecer autorizada.
    assert.deepStrictEqual(ledger.operatorDecisionsFor(otra.id), []);
  });
});

test('sin archivo, la consulta responde vacio en vez de romper', () => {
  withTempIntel((ledger) => {
    assert.deepStrictEqual(ledger.operatorDecisionsFor('T-9999'), []);
  });
});
