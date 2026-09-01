'use strict';
/**
 * fleet-drill.test.cjs — los nueve checks del drill T31 como filas independientes del reporter.
 * UN sandbox por archivo (copia real de ledger.cjs + kinds.json); cada check siembra su propia
 * precondicion, asi una fila RED no arrastra a la siguiente. RED = assert.fail con el lado
 * (wezbridge|finalorchestra|operator); UNKNOWN = skip ruidoso (no se pudo medir, nunca verde).
 * Corre solo con companions (_docs-curation, _intel) — en checkout aislado se declara y se salta.
 * Para el veredicto operativo con reporte: node scripts/fleet-drill.cjs --report <md>.
 */
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const drill = require('../scripts/fleet-drill.cjs');

const ctx = drill.buildSandbox({ keep: true, log: () => {} });

after(() => { try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

for (const check of drill.CHECKS) {
  test(`drill check ${check.id} [${check.side}] — ${check.title}`, async (t) => {
    try {
      const evidence = await check.run(ctx);
      t.diagnostic((evidence || []).join(' | '));
    } catch (e) {
      if (e && e.name === 'DrillUnknown') { t.skip(`UNKNOWN — no se pudo medir: ${e.message}`); return; }
      assert.fail(`RED — ${e.side || check.side} side: ${e.message}`);
    }
  });
}
