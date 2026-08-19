// El guard nacido de la correccion del operador (2026-08-19, dos veces):
// "dice SIGO, AHORA LO HAGO... y nadie hace nada". Un turno que termina en
// promesa sin continuacion armada debe BLOQUEARSE (exit 2). Y la regla del
// operador sobre guards: uno que dispara en turnos CUMPLIDORES es peor que
// ninguno — por eso la mitad de estos tests prueban que NO dispara.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'promise-guard-hook.cjs');

function runHook(entries, extraInput = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-guard-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const stdin = JSON.stringify({ transcript_path: transcript, ...extraInput });
  try {
    execFileSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8' });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status, err: String(e.stderr || '') };
  }
}

const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const toolUse = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

// ── debe BLOQUEAR ──────────────────────────────────────────────────────────

test('BLOQUEA: el caso literal de hoy — "Ahora arreglo el P0." sin loop', () => {
  const r = runHook([assistantText('Encontré el bug y está documentado.\n\nAhora arreglo el P0.')]);
  assert.equal(r.code, 2, 'promesa final sin continuación DEBE bloquear');
  assert.match(r.err, /PROMISE-GUARD/);
  assert.match(r.err, /evidencia o con un loop armado/);
});

test('BLOQUEA: "sigo con la Ola 1" al final, sin mecanismo armado', () => {
  const r = runHook([assistantText('Roadmap hecho, PR abierto.\n\nSigo con la Ola 1 del plan.')]);
  assert.equal(r.code, 2);
});

test('BLOQUEA: ScheduleWakeup con stop:true NO cuenta como continuación', () => {
  const r = runHook([
    toolUse('ScheduleWakeup', { stop: true }),
    assistantText('Loop cortado.\n\nAhora arreglo el bug pendiente.'),
  ]);
  assert.equal(r.code, 2, 'cerrar el loop y prometer es exactamente el caso malo');
});

// ── NO debe disparar (un guard ruidoso entrena a ignorarlo) ────────────────

test('PASA: promesa + ScheduleWakeup armado en el turno', () => {
  const r = runHook([
    assistantText('Sigo con la meta 2 en el próximo ciclo.'),
    toolUse('ScheduleWakeup', { delaySeconds: 900, prompt: '/loop ...' }),
  ]);
  assert.equal(r.code, 0, 'promesa CON loop armado es el comportamiento correcto');
});

test('PASA: turno que termina en evidencia, sin promesa', () => {
  const r = runHook([assistantText('Hecho: commit abc123 pusheado, 9/9 tests verdes. Nada pendiente.')]);
  assert.equal(r.code, 0);
});

test('PASA: promesa en el MEDIO pero final con evidencia', () => {
  const filler = 'Detalle de verificación y números finales. '.repeat(20);
  const r = runHook([assistantText(`Primero dije: ahora arreglo el parser. Lo hice.\n${filler}\nResultado: 12/12 verdes, mergeado.`)]);
  assert.equal(r.code, 0, 'la promesa vieja ya cumplida no debe disparar');
});

test('PASA: Monitor armado cuenta como continuación', () => {
  const r = runHook([
    toolUse('Monitor', { event: 'task-finished' }),
    assistantText('Quedo mirando el build; sigo con el informe cuando termine.'),
  ]);
  assert.equal(r.code, 0);
});

test('PASA: stop_hook_active=true nunca re-bloquea (sin bucles infinitos)', () => {
  const r = runHook([assistantText('Ahora arreglo el P0.')], { stop_hook_active: true });
  assert.equal(r.code, 0);
});

test('PASA: WEZBRIDGE_PROMISE_GUARD=0 lo apaga', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-guard-'));
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify(assistantText('Ahora arreglo todo.')) + '\n');
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: transcript }),
    encoding: 'utf8',
    env: { ...process.env, WEZBRIDGE_PROMISE_GUARD: '0' },
  });
  assert.equal(out, '');
});

test('PASA: transcript inexistente o stdin roto → permitir, nunca romper el stop', () => {
  const r1 = runHook([]); // transcript vacío → sin finalText
  assert.equal(r1.code, 0);
  try {
    execFileSync(process.execPath, [HOOK], { input: 'no-es-json', encoding: 'utf8' });
  } catch (e) {
    assert.fail('stdin roto no debe salir distinto de 0');
  }
});
