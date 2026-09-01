'use strict';
/**
 * headless-run.cjs — T-0283: correr un hijo headless (claude -p) distinguiendo TRES finales.
 * spawnSync con timeout mataba al hijo a los 15 min y registraba FAILED aunque el trabajo
 * estuviera hecho (rulings/board/last-summary escritos a los 5 min, hijo colgado 10 min mas).
 * Aca: `exited` (salio solo, status real) | `completed-no-exit` (escribio el resumen y no salio:
 * se lo mata a los graceMs, el turno cuenta como OK) | `timeout-no-output` (ni resumen ni salida
 * al timeout duro, que sigue FINITO y obligatorio — AC2). Se vigila el mtime de summaryFile
 * relativo al arranque: un resumen viejo no cuenta. Kill en arbol (taskkill /T en win32).
 */
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const OUTCOMES = Object.freeze({
  EXITED: 'exited',
  COMPLETED_NO_EXIT: 'completed-no-exit',
  TIMEOUT_NO_OUTPUT: 'timeout-no-output',
});

function summaryMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 10000 }); } catch { /* best effort */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ya muerto */ }
}

/**
 * @param {object} o
 * @param {string} o.command
 * @param {string[]} [o.args]
 * @param {string} [o.input]        se escribe en stdin y se cierra
 * @param {string} o.summaryFile    el archivo cuyo mtime (posterior al arranque) significa "trabajo hecho"
 * @param {number} o.timeoutMs      duro y FINITO (>0, < Infinity) — AC2
 * @param {number} [o.graceMs]      cuanto esperar la salida DESPUES del resumen (120 s por defecto — AC5)
 * @param {number} [o.pollMs]
 * @param {object} [o.spawnOpts]    cwd/env/shell para spawn
 * @returns {Promise<{outcome, status, killed, summaryWrittenAt, exitedAt, startedAt, stdout, stderr, turnExitCode}>}
 */
function runHeadless({ command, args = [], input, summaryFile, timeoutMs, graceMs = 120000, pollMs = 2000, spawnOpts = {} }) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new Error('runHeadless: timeoutMs debe ser finito y > 0 (AC2: subir el timeout no es un arreglo)')); return; }
    if (!summaryFile) { reject(new Error('runHeadless: summaryFile requerido')); return; }
    const startedAt = Date.now();
    const before = summaryMtime(summaryFile);
    let stdout = ''; let stderr = '';
    let settled = false;
    let summaryWrittenAt = null;
    let killed = false;
    let outcome = null;
    let timers = [];
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...spawnOpts });
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    if (input !== undefined) { try { child.stdin.write(input); } catch { /* hijo cerro stdin */ } }
    try { child.stdin.end(); } catch { /* idem */ }

    const finish = (status) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      clearInterval(poll);
      const exitedAt = Date.now();
      const finalOutcome = outcome || OUTCOMES.EXITED;
      const turnExitCode = finalOutcome === OUTCOMES.EXITED ? (status === 0 ? 0 : 4)
        : finalOutcome === OUTCOMES.COMPLETED_NO_EXIT ? 0 : 4;
      resolve({ outcome: finalOutcome, status: killed ? null : status, killed, summaryWrittenAt, exitedAt, startedAt, stdout, stderr, turnExitCode });
    };

    child.on('error', (e) => { stderr += `\nspawn error: ${e.message}`; if (!settled) { outcome = outcome || OUTCOMES.EXITED; finish(null); } });
    child.on('exit', (code) => finish(code));

    // El resumen escrito DESPUES del arranque significa "trabajo hecho": desde ahi
    // el hijo tiene graceMs para salir solo; si no, se lo mata y el turno es OK.
    const poll = setInterval(() => {
      if (settled || summaryWrittenAt) return;
      const m = summaryMtime(summaryFile);
      if (m !== null && m !== before && m >= startedAt - 1000) {
        summaryWrittenAt = Date.now();
        timers.push(setTimeout(() => {
          if (settled) return;
          outcome = OUTCOMES.COMPLETED_NO_EXIT; killed = true; killTree(child);
          timers.push(setTimeout(() => finish(null), 1500)); // por si 'exit' no llega
        }, graceMs));
      }
    }, pollMs);

    // Timeout duro: ni resumen ni salida. Sigue siendo finito a proposito.
    timers.push(setTimeout(() => {
      if (settled) return;
      if (!outcome) outcome = summaryWrittenAt ? OUTCOMES.COMPLETED_NO_EXIT : OUTCOMES.TIMEOUT_NO_OUTPUT;
      killed = true; killTree(child);
      timers.push(setTimeout(() => finish(null), 1500));
    }, timeoutMs));
  });
}

module.exports = { runHeadless, OUTCOMES, killTree };
