'use strict';
/**
 * headless-run.test.cjs — T-0283: el turno headless termina su trabajo pero NO sale; spawnSync lo
 * mataba a los 15 min y lo registraba FAILED con headless_exit:null, indistinguible de "murio sin
 * producir nada". Aca se simula un hijo REAL (node -e) en tres modos: escribe el resumen y no sale;
 * no escribe y no sale; escribe y sale 0. El runner tiene que dar TRES resultados distintos
 * (completed-no-exit | timeout-no-output | exited), matar al hijo a los graceMs de escribir el
 * resumen, y mantener un timeout duro FINITO (AC2: subir el timeout no es un arreglo).
 * Fail-first: RED contra main porque src/headless-run.cjs no existe.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHeadless, OUTCOMES } = require('../src/headless-run.cjs');

function tmpSummary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-run-'));
  return path.join(dir, 'last-summary.txt');
}

/** Hijo que (opcionalmente) escribe el resumen y despues duerme `sleepMs` (o sale). */
function childArgs({ write, sleepMs, exitCode = 0, summaryFile }) {
  const js = [
    `const fs=require('fs');`,
    `process.stdin.resume();`,
    write ? `setTimeout(()=>fs.writeFileSync(${JSON.stringify(summaryFile)}, 'resumen del turno'), 150);` : '',
    sleepMs > 0 ? `setTimeout(()=>process.exit(${exitCode}), ${sleepMs});` : `setTimeout(()=>process.exit(${exitCode}), 300);`,
  ].join('');
  return [process.execPath, ['-e', js]];
}

test('AC1/AC3: hijo que escribe el resumen y NO sale => completed-no-exit, muerto a los graceMs, exit code 0 del turno', async () => {
  const summaryFile = tmpSummary();
  const [cmd, args] = childArgs({ write: true, sleepMs: 60_000, summaryFile });
  const t0 = Date.now();
  const r = await runHeadless({ command: cmd, args, input: 'prompt', summaryFile, graceMs: 400, timeoutMs: 20_000, pollMs: 50 });
  assert.equal(r.outcome, OUTCOMES.COMPLETED_NO_EXIT);
  assert.equal(r.killed, true);
  assert.equal(r.status, null, 'un hijo matado no tiene exit status propio');
  assert.ok(r.summaryWrittenAt && r.exitedAt, JSON.stringify(r));
  assert.ok(r.exitedAt - r.summaryWrittenAt < 5_000, `salio ${r.exitedAt - r.summaryWrittenAt} ms despues del resumen (AC5: <=120 s; aqui grace 400 ms)`);
  assert.ok(Date.now() - t0 < 10_000, 'no espero el timeout duro');
  assert.equal(r.turnExitCode, 0, 'el trabajo se hizo: el turno reporta exito, no FAILED');
});

test('AC3: hijo que NO escribe y NO sale => timeout-no-output, distinto de completed-no-exit, exit code 4', async () => {
  const summaryFile = tmpSummary();
  const [cmd, args] = childArgs({ write: false, sleepMs: 60_000, summaryFile });
  const r = await runHeadless({ command: cmd, args, input: 'prompt', summaryFile, graceMs: 400, timeoutMs: 800, pollMs: 50 });
  assert.equal(r.outcome, OUTCOMES.TIMEOUT_NO_OUTPUT);
  assert.equal(r.killed, true);
  assert.equal(r.summaryWrittenAt, null);
  assert.equal(r.turnExitCode, 4);
  assert.notEqual(OUTCOMES.TIMEOUT_NO_OUTPUT, OUTCOMES.COMPLETED_NO_EXIT);
});

test('AC3: hijo que escribe y sale 0 => exited con status 0 y sin kill', async () => {
  const summaryFile = tmpSummary();
  const [cmd, args] = childArgs({ write: true, sleepMs: 0, exitCode: 0, summaryFile });
  const r = await runHeadless({ command: cmd, args, input: 'prompt', summaryFile, graceMs: 2_000, timeoutMs: 10_000, pollMs: 50 });
  assert.equal(r.outcome, OUTCOMES.EXITED);
  assert.equal(r.status, 0);
  assert.equal(r.killed, false);
  assert.equal(r.turnExitCode, 0);
});

test('AC3: hijo que sale con error sin escribir => exited status != 0, exit code 4', async () => {
  const summaryFile = tmpSummary();
  const [cmd, args] = childArgs({ write: false, sleepMs: 0, exitCode: 3, summaryFile });
  const r = await runHeadless({ command: cmd, args, input: 'prompt', summaryFile, graceMs: 2_000, timeoutMs: 10_000, pollMs: 50 });
  assert.equal(r.outcome, OUTCOMES.EXITED);
  assert.equal(r.status, 3);
  assert.equal(r.turnExitCode, 4);
});

test('AC2: el timeout duro es FINITO y obligatorio — 0 o Infinity se rechazan', async () => {
  const summaryFile = tmpSummary();
  const [cmd, args] = childArgs({ write: true, sleepMs: 0, summaryFile });
  await assert.rejects(() => runHeadless({ command: cmd, args, summaryFile, graceMs: 100, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(() => runHeadless({ command: cmd, args, summaryFile, graceMs: 100, timeoutMs: Infinity }), /timeoutMs/);
});

test('un resumen VIEJO (anterior al arranque) no cuenta como trabajo hecho', async () => {
  const summaryFile = tmpSummary();
  fs.writeFileSync(summaryFile, 'resumen de ayer');
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(summaryFile, old, old);
  const [cmd, args] = childArgs({ write: false, sleepMs: 60_000, summaryFile });
  const r = await runHeadless({ command: cmd, args, input: 'prompt', summaryFile, graceMs: 300, timeoutMs: 800, pollMs: 50 });
  assert.equal(r.outcome, OUTCOMES.TIMEOUT_NO_OUTPUT, 'el mtime viejo no debe leerse como resumen nuevo');
});
