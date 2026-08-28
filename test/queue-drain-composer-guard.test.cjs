'use strict';
/**
 * T-0242 / AC6 — CABLEADO: el diferimiento vive en el camino que ya corre solo.
 *
 * El predicado suelto no sirve de nada si nadie lo llama. Este archivo prueba
 * `deliverPending` (lo que ejecuta `queue-drain.cjs`, el drenaje automatico del
 * fleet), NO una funcion pura. Sin esto, el guard seria un paso manual que
 * alguien tiene que acordarse de invocar — que es exactamente la clase de
 * arreglo que ya nos fallo antes (los 92 tests que ningun proceso corria).
 *
 * LOS DOS SENTIDOS otra vez, al nivel del cableado:
 *   A) composer con texto ajeno  => 0 entregados, 0 sends, log visible
 *   B) composer limpio           => SI entrega (si no, paralizamos el fleet)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-composer-guard-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP;
const pq = require('../src/project-queue.cjs');

let n = 0;
const freshBase = () => {
  const d = path.join(TMP, `case-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const IDLE_PANE = { paneId: 7, agent: 'claude', status: 'idle', project: 'G:/x/wezbridge', tabTitle: null, title: null };

/** `send` inyectado; `holds` decide que contesta el guard. */
function sendWith(holds, calls) {
  return {
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
    paneComposerHoldsForeignText: () => holds,
  };
}

function consumer(base, send, logs) {
  return pq.createConsumer({
    project: 'wezbridge',
    base,
    discoverPanes: () => [IDLE_PANE],
    send,
    logAction: () => {},
    log: (m) => logs.push(m),
  });
}

const pending = (base) => pq.enqueue(
  { project: 'wezbridge', corr: 'T-guard', type: 'request', from_pane: 0, ok: false, body: 'trabajo real' },
  { base },
);

test('A: composer con texto ajeno => NO entrega, NO manda nada, y lo dice en el log', async () => {
  const base = freshBase(); pending(base);
  const calls = []; const logs = [];
  const out = await consumer(base, sendWith(true, calls), logs).drain();

  assert.strictEqual(out.delivered, 0, 'no puede entregar sobre un composer ocupado');
  assert.strictEqual(calls.length, 0, 'ni siquiera debe intentar el send: el Enter concatenaria');
  assert.ok(logs.some((l) => /composer retiene texto sin enviar/.test(l)),
    `el diferimiento tiene que ser visible, no silencioso. Logs: ${JSON.stringify(logs)}`);
});

test('B: composer limpio => SI entrega (el otro sentido, o paralizamos el fleet)', async () => {
  const base = freshBase(); pending(base);
  const calls = []; const logs = [];
  const out = await consumer(base, sendWith(false, calls), logs).drain();

  assert.strictEqual(out.delivered, 1, 'con el composer limpio la entrega es obligatoria');
  assert.strictEqual(calls.length, 1);
  assert.ok(!logs.some((l) => /composer retiene texto sin enviar/.test(l)),
    'no puede reportar un diferimiento que no ocurrio');
});

test('C: la entrega se reanuda SOLA cuando el composer se vacia (no queda pegada)', async () => {
  const base = freshBase(); pending(base);
  const calls = []; const logs = [];

  let holds = true;
  const send = {
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
    paneComposerHoldsForeignText: () => holds,
  };
  const c = consumer(base, send, logs);

  assert.strictEqual((await c.drain()).delivered, 0, 'primer drain: diferido');
  holds = false; // el operador apreto Enter
  assert.strictEqual((await c.drain()).delivered, 1,
    'el diferimiento no puede consumir intentos ni cooldown: el siguiente drain entrega');
});

test('D: un `send` sin el helper (fake viejo) entrega igual — fail-open', async () => {
  const base = freshBase(); pending(base);
  const calls = []; const logs = [];
  const legacy = {
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
  };
  assert.strictEqual((await consumer(base, legacy, logs).drain()).delivered, 1,
    'un guard que no puede medir no puede frenar');
});
