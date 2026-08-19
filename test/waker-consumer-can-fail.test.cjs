// La condicion de rearme del 2026-08-13, hecha ejecutable: "solo cuando algo
// aguas abajo del poke pueda FALLAR". Estos tests prueban que ahora ALGO FALLA
// — el gate sale 1 y la salud alerta — cuando los pokes se acumulan sin
// consumirse o quedan indeliverables.
//
// Disciplina aprendida HOY, dos veces: se prueba la TUBERIA real (set ->
// snapshot -> assessLiveness, y el gate por CLI con un state dir hermetico),
// no funciones alimentadas a mano. Un guard perfecto que nadie invoca, o cuyo
// dato se pierde en un registro intermedio, protege igual que ninguno.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ds = require('../src/daemon-status.cjs');

const GATE = path.join(__dirname, '..', 'scripts', 'waker-gate.cjs');

function runGate(intelDir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE], {
      encoding: 'utf8',
      env: { ...process.env, WEZBRIDGE_INTEL_DIR: intelDir, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function mkIntel(cfg, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-gate-'));
  if (cfg !== undefined) fs.writeFileSync(path.join(dir, 'orch-waker.json'), JSON.stringify(cfg));
  if (state) {
    const sd = path.join(dir, '.orch-waker-state');
    fs.mkdirSync(sd);
    for (const [name, val] of Object.entries(state)) {
      fs.writeFileSync(path.join(sd, `${name}.json`), JSON.stringify(val));
    }
  }
  return dir;
}

const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

// ── el gate, por la CLI real ──────────────────────────────────────────────

test('GATE RED: un intent pendiente mas viejo que el umbral', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, {
    pending: { abc: { repo: 'x', time: minsAgo(45), attempts: 1 } },
    flags: {},
  });
  const r = runGate(dir);
  assert.equal(r.code, 1, 'un poke de 45 min sin consumir DEBE ser rojo');
  assert.match(r.out, /older than 30 min/);
  assert.match(r.out, /2026-08-13/, 'nombra el incidente que motiva el gate');
});

test('GATE RED: intents flaggeados (indeliverables) — nunca se resuelven solos', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, {
    pending: {},
    flags: { dead1: { repo: 'x', flagged_at: minsAgo(5) } },
  });
  const r = runGate(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /attempt cap/);
});

test('GATE RED: enabled pero sin state dir — armado solo en papel', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, null);
  const r = runGate(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /paper/);
});

test('GATE GREEN: cola drenada o fresca', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, {
    pending: { fresh: { repo: 'x', time: minsAgo(2), attempts: 0 } },
    flags: {},
  });
  const r = runGate(dir);
  assert.equal(r.code, 0, 'un poke de 2 min es cola normal, no falla');
});

test('GATE GREEN: desarme con registro de decision — una decision no es una falla', () => {
  const dir = mkIntel({ enabled: false, _disarmed_2026_08_13: 'decision del operador' }, null);
  const r = runGate(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /recorded decision/);
});

test('GATE UNKNOWN(3): config ilegible NUNCA se reporta como verde', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-gate-'));
  const r = runGate(dir); // sin orch-waker.json
  assert.equal(r.code, 3);
});

test('el umbral es configurable y el default es 30', () => {
  const dir = mkIntel({ enabled: true, repos: ['x'] }, {
    pending: { a: { repo: 'x', time: minsAgo(10), attempts: 0 } },
    flags: {},
  });
  assert.equal(runGate(dir).code, 0, '10 min con umbral 30: verde');
  assert.equal(runGate(dir, { WAKER_GATE_STALE_MINUTES: '5' }).code, 1, '10 min con umbral 5: rojo');
});

// ── la tuberia de salud: set -> snapshot -> assessLiveness ────────────────

const beatFromRegistry = () => ({ ts: new Date().toISOString(), services: ds.snapshot() });

test('TUBERIA: pokes viejos alertan pasando por el registro real', () => {
  ds._reset();
  ds.set('orchestrator_waker', {
    armed: true, reason: 'armed',
    probe: () => ({ pending: 3, pendingOldestMinutes: 94, flagged: 0, cursorLagBytes: 0 }),
  });
  const v = ds.assessLiveness({ heartbeat: beatFromRegistry(), daemonReachable: true });
  assert.equal(v.ok, false);
  assert.match(v.alerts.join(' '), /UNATTENDED/);
  assert.match(v.alerts.join(' '), /94 min/);
});

test('TUBERIA: intents flaggeados alertan', () => {
  ds._reset();
  ds.set('orchestrator_waker', {
    armed: true, reason: 'armed',
    probe: () => ({ pending: 0, pendingOldestMinutes: 0, flagged: 2, cursorLagBytes: 0 }),
  });
  const v = ds.assessLiveness({ heartbeat: beatFromRegistry(), daemonReachable: true });
  assert.equal(v.ok, false);
  assert.match(v.alerts.join(' '), /UNDELIVERABLE/);
});

test('TUBERIA: cola fresca NO alerta — un gate ruidoso entrena a ignorarlo', () => {
  ds._reset();
  ds.set('orchestrator_waker', {
    armed: true, reason: 'armed',
    probe: () => ({ pending: 2, pendingOldestMinutes: 12, flagged: 0, cursorLagBytes: 100 }),
  });
  const v = ds.assessLiveness({ heartbeat: beatFromRegistry(), daemonReachable: true });
  assert.deepEqual(v.alerts, []);
  assert.equal(v.ok, true);
});
