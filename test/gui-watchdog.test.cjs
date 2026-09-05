'use strict';
/**
 * gui-watchdog.ps1 (T-0315): la cascada del 2026-09-01 y los dos AC que la cortan.
 *
 * MEDIDO (%LOCALAPPDATA%\WezTerm\gui-watchdog.log, 22:17-22:22 ART): cinco
 * hung_confirmed en cinco minutos, cada pid la GUI que el watchdog acababa de
 * crear un minuto antes. El 3-strike era POR PID y cada reemplazo estrena pid,
 * asi que el tope nunca corto nada: cuatro minutos de flota ciega (los MCP de
 * los panes resuelven por el socket gui, que se renumera con cada reemplazo).
 *
 * AC2 (ruling 05/09): cada hung_confirmed registra pid + edad de la GUI + tab;
 *      si la edad es < 60 s se loguea `young_gui_hung` y el recover corre IGUAL
 *      (la hipotesis "arranque lento" quedo refutada: 0,9-1,5 s; el dato es
 *      para atrapar el disparador, no para perdonar a la GUI).
 * AC3: 3-strike por EPISODIO (ventana de 10 min): el tercer cuelgue confirmado
 *      dentro de la ventana NO se recupera (`episode_cutoff`) y se avisa; al
 *      vencer la ventana el watchdog vuelve a actuar.
 *
 * El script se ejercita DE VERDAD (Windows PowerShell 5.1) a traves de
 * test/fixtures/gui-watchdog-harness.ps1, que lo carga como biblioteca y
 * reemplaza solo lo que toca el sistema: censo de GUIs, reloj, recover, mux.
 * Sin PowerShell (no-Windows) el archivo se salta entero.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HARNESS = path.join(__dirname, 'fixtures', 'gui-watchdog-harness.ps1');
const HAVE_PS = process.platform === 'win32';

function run(scenario) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HARNESS, '-Scenario', scenario], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    windowsHide: true,
  });
  assert.strictEqual(r.status, 0, `harness ${scenario} fallo (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
  const line = r.stdout.trim().split('\n').pop();
  let out;
  try { out = JSON.parse(line); } catch (e) { assert.fail(`salida no JSON del harness ${scenario}: ${r.stdout.slice(-800)}`); }
  return out;
}

const lines = (out, re) => out.log.filter((l) => re.test(l));

test('AC2: hung_confirmed registra pid, edad y tab; GUI joven (<60 s) loguea young_gui_hung y el recover corre igual', { skip: !HAVE_PS }, () => {
  const out = run('young');
  const hc = lines(out, /hung_confirmed pid=3000 /);
  assert.strictEqual(hc.length, 1, `esperaba un hung_confirmed de 3000, log:\n${out.log.join('\n')}`);
  assert.match(hc[0], /age_s=20\b/, 'la edad de la GUI tiene que quedar en la linea');
  assert.match(hc[0], /title="\[1\/9\] tab"/, 'la tab enfocada tiene que quedar en la linea');
  assert.strictEqual(lines(out, /young_gui_hung pid=3000 /).length, 1, 'una GUI de 20 s colgada tiene que marcarse young_gui_hung');
  assert.deepStrictEqual(out.recovers.map((r) => r.pid), [3000],
    'young_gui_hung es SOLO registro: el recover NO se salta (ruling 05/09: la gracia respondia a una causa refutada)');
});

test('AC2: GUI vieja no se marca young_gui_hung y se recupera', { skip: !HAVE_PS }, () => {
  const out = run('old');
  assert.strictEqual(lines(out, /young_gui_hung/).length, 0);
  assert.match(lines(out, /hung_confirmed pid=3001 /)[0], /age_s=900\b/);
  assert.deepStrictEqual(out.recovers.map((r) => r.pid), [3001]);
});

test('AC3: la cascada del 01/09 (5 pids en 5 min) corta en el TERCER cuelgue y vuelve al vencer la ventana', { skip: !HAVE_PS }, () => {
  const out = run('cascade');
  const pids = out.recovers.map((r) => r.pid);
  assert.deepStrictEqual(pids.slice(0, 2), [1001, 1002], `los dos primeros cuelgues se recuperan; recovers=${JSON.stringify(out.recovers)}`);
  assert.ok(!pids.includes(1003) && !pids.includes(1004) && !pids.includes(1005),
    `del tercero en adelante NO se recupera dentro de la ventana; recovers=${JSON.stringify(pids)}\nlog:\n${out.log.join('\n')}`);
  const cut = lines(out, /episode_cutoff/);
  assert.ok(cut.length >= 3, `esperaba episode_cutoff para 1003, 1004 y 1005, log:\n${out.log.join('\n')}`);
  assert.match(cut[0], /pid=1003 /, 'el primer corte es el tercer pid');
  assert.match(cut[0], /strike=3\/3/, 'el corte dice en que strike cayo');
  assert.strictEqual(lines(out, /young_gui_hung/).length, 5, 'las cinco GUIs de la cascada tenian ~55 s: las cinco se registran jovenes');
  // Aviso: una sola vez por episodio, y como evento consumible (events.jsonl).
  const ev = out.events.map((l) => JSON.parse(l)).filter((e) => e.event === 'gui-watchdog.episode_cutoff');
  assert.strictEqual(ev.length, 1, `un aviso por episodio, no uno por tick; events=${JSON.stringify(out.events)}`);
  assert.strictEqual(ev[0].strikes, 3);
  // 11 min despues la ventana vencio: el watchdog vuelve a recuperar.
  assert.strictEqual(pids[pids.length - 1], 2000, `al vencer la ventana el cuelgue nuevo se recupera; recovers=${JSON.stringify(pids)}`);
  assert.strictEqual(pids.length, 3);
});
