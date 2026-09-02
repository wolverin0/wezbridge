'use strict';
/**
 * T-0314 (2026-09-02) — el cursor de lectura incremental avanzaba en CARACTERES
 * (`chunk.lastIndexOf('\n') + 1`, indice del string decodificado) mientras la
 * posicion del archivo, stat.size y el fingerprint de rotacion se miden en
 * BYTES. Con cualquier caracter multibyte en el jsonl (acentos, guion largo: los
 * hay en todos los briefs) el cursor queda CORTO, el fingerprint del tick
 * siguiente se lee desplazado, no coincide, y el guard de "archivo rotado"
 * dispara un reset falso a 0. Medido en el waker: cursorResets 71 en 70 min
 * (uno por tick), staleDropped 322k, 3,3 MB releidos por minuto; en
 * project-queue: 'cursor reset' en CADA pasada de queue-drain y entradas ya
 * entregadas que vuelven a aparecer (5 replays del mismo request en un dia).
 *
 * Dos modulos, el mismo defecto, el mismo test: dos ticks con eventos multibyte
 * => cero resets y cursor == tamano del archivo. Control: una rotacion REAL
 * sigue disparando exactamente un reset.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWaker } = require('../src/orchestrator-waker.cjs');
const { createConsumer, enqueue, queueFile } = require('../src/project-queue.cjs');

const MULTIBYTE = 'título con acentos — y guión largo · «comillas» ñandú';

// ---------------------------------------------------------------- waker ----
function wakerEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-bytes-'));
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  fs.writeFileSync(eventsPath, '');
  return { dir, eventsPath, stateDir: path.join(dir, 'state') };
}
function beacon(env, evt) { fs.appendFileSync(env.eventsPath, `${JSON.stringify(evt)}\n`); }
function makeWaker(env, now) {
  return createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: () => [{ paneId: 0, project: 'G:/Py Apps/walksim', title: 'x', status: 'working' }],
    send: { sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' },
    settleTicks: 99, cooldownMs: 0, maxAttempts: 1,
    now, log: () => {},
    watchRepos: ['walksim'],
  });
}

test('T-0314 waker: dos ticks con eventos multibyte => 0 resets y cursor == bytes del archivo', async () => {
  const env = wakerEnv();
  let t = 1_000_000;
  const w = makeWaker(env, () => t);
  const evt = (n) => ({ event: 'turn-end', repo: 'walksim', pane: 0, time: new Date(t).toISOString(), title: `${MULTIBYTE} ${n}` });
  beacon(env, evt(1)); beacon(env, evt(2));
  await w.tick();
  t += 60_000;
  beacon(env, evt(3)); beacon(env, evt(4));
  await w.tick();
  t += 60_000;
  await w.tick(); // tercer tick sin escritura nueva: el fingerprint se vuelve a verificar
  const st = w.status();
  assert.equal(st.cursorResets, 0, `reset falso: el cursor avanzo en caracteres, no en bytes (resets=${st.cursorResets})`);
  assert.equal(w._state.cursorBytes, fs.statSync(env.eventsPath).size, 'el cursor tiene que quedar exactamente al final del archivo');
  fs.rmSync(env.dir, { recursive: true, force: true });
});

test('T-0314 waker control: una rotacion REAL (archivo reescrito mas corto) sigue contando exactamente 1 reset', async () => {
  const env = wakerEnv();
  let t = 1_000_000;
  const w = makeWaker(env, () => t);
  for (let i = 0; i < 6; i += 1) beacon(env, { event: 'turn-end', repo: 'walksim', pane: 0, time: new Date(t).toISOString(), title: `${MULTIBYTE} ${i}` });
  await w.tick();
  t += 60_000;
  fs.writeFileSync(env.eventsPath, `${JSON.stringify({ event: 'turn-end', repo: 'walksim', pane: 0, time: new Date(t).toISOString(), title: 'nuevo' })}\n`);
  await w.tick();
  assert.equal(w.status().cursorResets, 1, 'la rotacion real tiene que seguir detectandose');
  fs.rmSync(env.dir, { recursive: true, force: true });
});

// -------------------------------------------------------- project-queue ----
function queueEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-bytes-'));
  const logs = [];
  const consumer = createConsumer({
    project: 'walksim', base,
    discoverPanes: () => [],          // sin pane vivo: solo ingesta, nada se entrega
    send: { sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' },
    log: (m) => logs.push(String(m)),
    now: () => 1_000_000,
  });
  return { base, logs, consumer, file: queueFile('walksim', base) };
}
const entry = (n) => ({ project: 'walksim', corr: `corr-${n}`, type: 'request', from_pane: 1, body: `${MULTIBYTE} ${n}` });

test('T-0314 project-queue: dos ingestas con sobres multibyte => 0 "cursor reset" y cursor == bytes del archivo', () => {
  const q = queueEnv();
  enqueue(entry(1), { base: q.base }); enqueue(entry(2), { base: q.base });
  q.consumer.ingest();
  enqueue(entry(3), { base: q.base });
  q.consumer.ingest();
  q.consumer.ingest(); // sin escritura nueva: re-verifica el fingerprint
  const resets = q.logs.filter((l) => /cursor reset/.test(l));
  assert.deepEqual(resets, [], `reset falso en la cola: ${resets.join(' | ')}`);
  assert.equal(q.consumer._state.cursorBytes, fs.statSync(q.file).size, 'el cursor de la cola tiene que quedar al final del archivo');
  fs.rmSync(q.base, { recursive: true, force: true });
});

test('T-0314 project-queue: un sobre ya entregado NO vuelve a pending tras otra ingesta (el replay de hoy)', () => {
  const q = queueEnv();
  enqueue(entry(1), { base: q.base });
  q.consumer.ingest();
  const pendingBefore = Object.keys(q.consumer._state.pending).length;
  assert.equal(pendingBefore, 1);
  // marcar entregado como lo hace el drain tras un envio verificado
  const id = Object.keys(q.consumer._state.pending)[0];
  q.consumer._state.delivered.push(id); delete q.consumer._state.pending[id];
  enqueue(entry(2), { base: q.base });
  q.consumer.ingest();
  assert.equal(q.consumer._state.pending[id], undefined, 'con el cursor en bytes, el sobre entregado no se re-ingesta; con el bug, el reset lo resucitaba');
  fs.rmSync(q.base, { recursive: true, force: true });
});
