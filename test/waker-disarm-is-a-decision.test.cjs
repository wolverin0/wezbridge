// T-0176. bridge_health alertaba —y dejaba ok:false para siempre— por el waker
// del orquestador desarmado, que esta apagado A PROPOSITO desde 2026-08-13 por
// decision del operador, con su motivo y su condicion de rearme escritos dentro
// de _intel/orch-waker.json.
//
// Una alerta permanente sobre comportamiento CORRECTO es peor que ninguna:
// entrena a todo lector a saltear la lista de alertas, que es justo donde
// aparecen las de verdad. Pero el riesgo del arreglo es el opuesto — silenciar
// de mas — asi que el test que mas importa aca es el que prueba que un desarme
// SIN registro de decision sigue alertando.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ds = require('../src/daemon-status.cjs');
const { resolveWakerConfig } = require('../src/orchestrator-waker.cjs');

const beat = (waker) => ({ ts: new Date().toISOString(), services: { orchestrator_waker: waker } });
const live = (waker) => ds.assessLiveness({ heartbeat: beat(waker), daemonReachable: true });

// EL CABLEADO, no la regla. Estos tres van por set() -> snapshot() ->
// assessLiveness, que es el camino que recorre el daemon de verdad.
//
// Existen porque el 2026-08-19 el arreglo se mergeo, se reinicio el daemon, y
// bridge_health SIGUIO alertando: daemon-status.set() copiaba solo armed/reason
// y TIRABA el campo `deliberate`, asi que la rama nueva nunca se activaba. Los
// tests unitarios de abajo pasaban igual porque le entregan a assessLiveness un
// objeto armado a mano — probaban la regla, no la tuberia.
test('CABLEADO: el campo deliberate sobrevive set() -> snapshot()', () => {
  ds._reset();
  ds.set('orchestrator_waker', { armed: false, reason: 'x', deliberate: true, decidedAt: '2026-08-13' });
  const snap = ds.snapshot();
  assert.equal(snap.orchestrator_waker.deliberate, true, 'el registro no puede descartar lo que un componente declara');
  assert.equal(snap.orchestrator_waker.decidedAt, '2026-08-13');
});

test('CABLEADO: un desarme deliberado NO alerta al pasar por el daemon real', () => {
  ds._reset();
  ds.set('orchestrator_waker', { armed: false, reason: 'disarmed ON PURPOSE', deliberate: true });
  const v = ds.assessLiveness({
    heartbeat: { ts: new Date().toISOString(), services: ds.snapshot() },
    daemonReachable: true,
  });
  assert.deepEqual(v.alerts, [], 'esto es lo que fallaba en produccion con los unitarios en verde');
  assert.equal(v.ok, true);
});

test('CABLEADO: sin registro de decision SIGUE alertando por el camino real', () => {
  ds._reset();
  ds.set('orchestrator_waker', { armed: false, reason: 'enabled is not true', deliberate: false });
  const v = ds.assessLiveness({
    heartbeat: { ts: new Date().toISOString(), services: ds.snapshot() },
    daemonReachable: true,
  });
  assert.equal(v.alerts.length, 1);
  assert.equal(v.ok, false);
});

test('un desarme DELIBERADO no alerta y no ensucia ok', () => {
  const v = live({ armed: false, deliberate: true, reason: 'disarmed ON PURPOSE', decidedAt: '2026-08-13' });
  assert.deepEqual(v.alerts, [], 'una decision no es una falla');
  assert.equal(v.ok, true, 'ok:false permanente sobre una decision desensibiliza al lector');
});

test('un desarme SIN registro de decision SIGUE alertando', () => {
  // El test que impide que este arreglo se convierta en un silenciador.
  // Si alguien pone enabled:false sin explicar por que, eso si es un defecto.
  const v = live({ armed: false, deliberate: false, reason: 'enabled is not true, y NO hay registro' });
  assert.equal(v.alerts.length, 1, 'un apagado sin explicacion tiene que seguir gritando');
  assert.match(v.alerts[0], /ORCHESTRATOR WAKER OFF/);
  assert.equal(v.ok, false);
});

test('un waker que nunca se registro sigue alertando', () => {
  const v = ds.assessLiveness({ heartbeat: { ts: new Date().toISOString(), services: {} }, daemonReachable: true });
  assert.equal(v.ok, false);
  assert.match(v.alerts.join(' '), /WAKER MISSING/);
});

test('un waker armado pero atrasado sigue alertando', () => {
  // La otra rama viva: que el arreglo no haya tapado el caso de atraso.
  const v = live({ armed: true, cursorLagBytes: 999999 });
  assert.equal(v.ok, false);
  assert.match(v.alerts.join(' '), /FALLING BEHIND/);
});

test('resolveWakerConfig reconoce el registro de desarme y lo devuelve entero', () => {
  const cfg = resolveWakerConfig({
    env: {},
    intelDir: '/fake',
    readFile: () => JSON.stringify({
      enabled: false,
      repos: ['brlite'],
      _disarmed_2026_08_13: 'DISARMED by operator decision. RE-ARM CONDITION: only when something downstream of the poke can FAIL.',
    }),
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.deliberate, true);
  assert.equal(cfg.decidedAt, '2026-08-13', 'la fecha sale del nombre de la clave');
  assert.match(cfg.decision, /RE-ARM CONDITION/, 'la condicion de rearme viaja ENTERA, no resumida');
  assert.match(cfg.reason, /ON PURPOSE/i);
});

test('sin registro de decision, resolveWakerConfig NO lo declara deliberado', () => {
  const cfg = resolveWakerConfig({
    env: {},
    intelDir: '/fake',
    readFile: () => JSON.stringify({ enabled: false, repos: [] }),
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.deliberate, false, 'sin registro no se puede saber si fue a proposito');
  assert.match(cfg.reason, /NO decision record/i, 'y el motivo tiene que decir que falta el registro');
});

test('el env WEZBRIDGE_ORCH_WAKER=0 no se disfraza de decision registrada', () => {
  const cfg = resolveWakerConfig({ env: { WEZBRIDGE_ORCH_WAKER: '0' }, intelDir: null });
  assert.equal(cfg.enabled, false);
  assert.ok(!cfg.deliberate, 'un flag de entorno no es un registro de decision con condicion de rearme');
});
