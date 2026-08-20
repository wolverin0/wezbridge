// T-0191 (cerrada por entierro). ClawTrol fue RETIRADO por ruling del operador
// (2026-08-13, confirmado 2026-08-20): el cockpit no existe y el bridge acumulo
// 274 fallos de sync consecutivos contra un 404, ensuciando health en todas las
// superficies. El entierro es un REGISTRO DE DECISION en
// _intel/clawtrol-bridge.json (clave `_disarmed_*` con motivo y condicion de
// rearme — la misma convencion que resolveWakerConfig), NO un flag de entorno:
// mientras el registro exista, el bridge se niega a armar aunque
// CLAWTROL_URL/TOKEN sigan exportados en alguna maquina.
//
// Clon de waker-disarm-is-a-decision.test.cjs: la mutacion clave es al reves —
// BORRAR el registro tiene que devolver el comportamiento viejo (el env vuelve
// a mandar), lo que prueba que lo que silencia es el registro, no el env.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Entorno aislado ANTES de requerir el modulo: intel dir temporal y un env
// file de ClawTrol inexistente, para que loadEnvFile no levante credenciales
// reales de <home>/.wezbridge/clawtrol.env en la maquina del operador.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clawtrol-disarm-'));
const INTEL = path.join(TMP, '_intel');
fs.mkdirSync(INTEL, { recursive: true });
process.env.WEZBRIDGE_INTEL_DIR = INTEL;
process.env.WEZBRIDGE_CLAWTROL_ENV = path.join(TMP, 'no-such-clawtrol.env');

const ds = require('../src/daemon-status.cjs');
const bridge = require('../src/clawtrol-bridge.cjs');

const DECISION_FILE = path.join(INTEL, 'clawtrol-bridge.json');
const DECISION = {
  enabled: false,
  _disarmed_2026_08_20: 'ClawTrol retired by operator ruling 2026-08-13; 274 consecutive sync failures / 404. Confirmed by operator 2026-08-20 (bury). Re-arm only if a cockpit exists again and the operator says so.',
};

// ── El resolver: la misma forma que resolveWakerConfig ─────────────────────

test('resolveClawtrolDecision reconoce el registro de entierro y lo devuelve entero', () => {
  const d = bridge.resolveClawtrolDecision({
    intelDir: '/fake',
    readFile: () => JSON.stringify(DECISION),
  });
  assert.equal(d.disarmed, true);
  assert.equal(d.deliberate, true);
  assert.equal(d.decidedAt, '2026-08-20', 'la fecha sale del nombre de la clave');
  assert.match(d.decision, /Re-arm only if a cockpit exists again/,
    'la condicion de rearme viaja ENTERA, no resumida');
  assert.match(d.reason, /ON PURPOSE/i);
});

test('un archivo SIN clave _disarmed_* no es una decision — el env sigue mandando', () => {
  const d = bridge.resolveClawtrolDecision({
    intelDir: '/fake',
    readFile: () => JSON.stringify({ enabled: false }),
  });
  assert.equal(d.disarmed, false, 'enabled:false sin registro no puede enterrar nada');
});

test('archivo ausente o roto → comportamiento viejo (fail-soft, el env decide)', () => {
  const gone = bridge.resolveClawtrolDecision({
    intelDir: '/fake',
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(gone.disarmed, false);
  const broken = bridge.resolveClawtrolDecision({
    intelDir: '/fake',
    readFile: () => 'not json {',
  });
  assert.equal(broken.disarmed, false, 'un registro ilegible no puede tirar el daemon ni decidir nada');
});

// ── EL CABLEADO: registro presente + CLAWTROL_URL seteada → NO arma ────────
// Y la MUTACION del slice: borrar el registro devuelve el comportamiento
// viejo. Eso prueba que lo que silencia es el REGISTRO, no el env.

test('con registro de decision presente, start() NO arma aunque el env este completo', () => {
  fs.writeFileSync(DECISION_FILE, JSON.stringify(DECISION, null, 2));
  process.env.CLAWTROL_URL = 'http://127.0.0.1:9';
  process.env.CLAWTROL_TOKEN = 'test-token-not-real';
  try {
    const armed = bridge.start();
    assert.equal(armed, false, 'un bridge enterrado no puede resucitar porque una maquina siga exportando el env');
  } finally {
    bridge.stop();
  }
});

test('MUTACION del registro: borrarlo devuelve el comportamiento viejo (arma con env)', () => {
  fs.rmSync(DECISION_FILE, { force: true });
  process.env.CLAWTROL_URL = 'http://127.0.0.1:9';
  process.env.CLAWTROL_TOKEN = 'test-token-not-real';
  try {
    const armed = bridge.start();
    assert.equal(armed, true, 'sin registro el env vuelve a mandar — el silenciador es el archivo, no un hardcode');
  } finally {
    bridge.stop();
    delete process.env.CLAWTROL_URL;
    delete process.env.CLAWTROL_TOKEN;
  }
});

test('sin registro Y sin env, start() sigue deshabilitado como siempre', () => {
  fs.rmSync(DECISION_FILE, { force: true });
  delete process.env.CLAWTROL_URL;
  delete process.env.CLAWTROL_TOKEN;
  assert.equal(bridge.start(), false);
});

// ── daemon-status: la decision viaja por el camino real y NO alerta ────────
// set() -> snapshot() -> assessLiveness, el mismo camino que recorre el daemon
// (la leccion del waker 2026-08-19: probar la tuberia, no solo la regla).

test('CABLEADO: los campos deliberate/disarmed_by_decision sobreviven set() -> snapshot()', () => {
  ds._reset();
  ds.set('clawtrol_bridge', {
    armed: false,
    deliberate: true,
    disarmed_by_decision: true,
    decidedAt: '2026-08-20',
    reason: DECISION._disarmed_2026_08_20,
  });
  const snap = ds.snapshot();
  assert.equal(snap.clawtrol_bridge.deliberate, true);
  assert.equal(snap.clawtrol_bridge.disarmed_by_decision, true);
  assert.match(snap.clawtrol_bridge.reason, /Re-arm only if/, 'el motivo es el texto de la decision, entero');
});

test('CABLEADO: el entierro deliberado NO alerta al pasar por el daemon real', () => {
  ds._reset();
  // El waker armado y sano acompana: assessLiveness exige un waker vivo, y el
  // punto de este test es que clawtrol NO agregue alertas encima de eso.
  ds.set('orchestrator_waker', { armed: true, reason: 'armed' });
  ds.set('clawtrol_bridge', {
    armed: false,
    deliberate: true,
    disarmed_by_decision: true,
    reason: DECISION._disarmed_2026_08_20,
  });
  const v = ds.assessLiveness({
    heartbeat: { ts: new Date().toISOString(), services: ds.snapshot() },
    daemonReachable: true,
  });
  assert.deepEqual(v.alerts, [], 'una decision no es una falla — 274 fallos de un muerto no son observabilidad');
  assert.equal(v.ok, true);
});
