'use strict';
/**
 * orchestrator-waker-unverified.test.cjs — W4: el tercer estado de la entrega.
 * Cubre `classifyDelivery(delivered, submitted)` puro (delivered|failed|
 * unverified) y su consumo en `deliverPending` del waker: un send que no se
 * pudo VERIFICAR no cuenta como entregado, se reintenta una vez tras el
 * cooldown, y a la segunda se flaggea con un motivo que nombra el pane.
 * Tambien fija `status().unverified`. Deps inyectadas, relojes fijos.
 *
 * MEDIDO: `ok = submitted !== 'stuck' && delivered !== 'truncated'` contaba
 * 'unknown' (pane ilegible) como ENTREGADO. El intent desaparecia y el poke
 * jamas habia llegado a ninguna parte — el instrumento mentia en silencio.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWaker } = require('../src/orchestrator-waker.cjs');
const { classifyDelivery } = require('../src/verified-send.cjs');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-unverified-'));
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(eventsPath, '');
  return { dir, eventsPath, stateDir };
}

const beacon = (env, evt) => fs.appendFileSync(env.eventsPath, `${JSON.stringify(evt)}\n`);

function fakeSend(plan = {}) {
  const calls = [];
  return {
    calls,
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return plan.delivered || 'ok'; },
    verifyPromptSubmission: async () => plan.submitted || 'submitted',
  };
}

const IDLE_PANE = { paneId: 0, project: 'G:/Py Apps/wezbridge', title: 'orch', status: 'idle' };

function makeWaker(env, over = {}) {
  return createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: over.discoverPanes || (() => [IDLE_PANE]),
    send: over.send || fakeSend(),
    settleTicks: over.settleTicks ?? 1,
    cooldownMs: over.cooldownMs ?? 0,
    maxAttempts: over.maxAttempts ?? 3,
    now: over.now || (() => 1_000_000),
    log: over.log || (() => {}),
    watchRepos: over.watchRepos || ['walksim'],
  });
}

const flagsOf = (env) => JSON.parse(fs.readFileSync(path.join(env.stateDir, 'flags.json'), 'utf8'));

// ── classifyDelivery puro ──────────────────────────────────────────────────

test('W4: classifyDelivery — solo submitted+ok es "delivered"', () => {
  assert.strictEqual(classifyDelivery('ok', 'submitted'), 'delivered');
});

test('W4: classifyDelivery — stuck o truncated es "failed"', () => {
  assert.strictEqual(classifyDelivery('ok', 'stuck'), 'failed');
  assert.strictEqual(classifyDelivery('truncated', 'submitted'), 'failed');
  assert.strictEqual(classifyDelivery('truncated', 'stuck'), 'failed');
  // Un 'stuck' con integridad ilegible sigue siendo un fallo MEDIDO, no una duda.
  assert.strictEqual(classifyDelivery('unknown', 'stuck'), 'failed');
});

test('W4: classifyDelivery — todo lo demas es "unverified", NUNCA delivered', () => {
  assert.strictEqual(classifyDelivery('ok', 'unknown'), 'unverified');
  assert.strictEqual(classifyDelivery('unknown', 'submitted'), 'unverified');
  assert.strictEqual(classifyDelivery('unknown', 'unknown'), 'unverified');
  assert.strictEqual(classifyDelivery(undefined, undefined), 'unverified');
});

// ── el waker consume el tercer estado ──────────────────────────────────────

test('W4: un send no verificable NO entrega — el intent queda pendiente con unverified=1', async () => {
  const env = makeEnv();
  const send = fakeSend({ submitted: 'unknown' });
  const w = makeWaker(env, { send });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();

  assert.strictEqual(send.calls.length, 1, 'precondicion: el waker intento el poke');
  const pending = Object.values(w._state.pending);
  assert.strictEqual(pending.length, 1, 'un poke no verificado NO puede consumir el intent');
  assert.strictEqual(pending[0].unverified, 1, 'el intento no verificado se cuenta aparte de attempts');
  assert.strictEqual(pending[0].attempts, 0, 'unverified no es un fallo: no quema un attempt');
});

test('W4: se reintenta una vez; el segundo unverified flaggea con motivo que nombra el pane', async () => {
  const env = makeEnv();
  const send = fakeSend({ submitted: 'unknown' });
  const w = makeWaker(env, { send });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();
  await w.tick(); // segundo intento tras el cooldown (0 en el fixture)

  assert.strictEqual(send.calls.length, 2, 'el primer unverified se reintenta exactamente una vez');
  assert.strictEqual(Object.keys(w._state.pending).length, 0, 'a la segunda el intent se flaggea y sale de pending');
  const flags = flagsOf(env);
  const entries = Object.values(flags);
  assert.strictEqual(entries.length, 1);
  assert.match(entries[0].reason, /unverified twice/i,
    `el motivo tiene que decir QUE fallo, no "attempt cap": ${JSON.stringify(entries[0].reason)}`);
  assert.match(entries[0].reason, /composer unreadable/i);
  assert.match(entries[0].reason, /pane 0\b/, 'sin el pane, el operador no sabe donde mirar');
});

test('W4: un send verificado sigue entregando (el otro sentido — anti-freno)', async () => {
  const env = makeEnv();
  const send = fakeSend(); // ok + submitted
  const w = makeWaker(env, { send });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();

  assert.strictEqual(send.calls.length, 1);
  assert.strictEqual(Object.keys(w._state.pending).length, 0, 'delivered sigue consumiendo el intent');
  assert.ok(!fs.existsSync(path.join(env.stateDir, 'flags.json')), 'una entrega sana no flaggea nada');
});

test('W4: un fallo MEDIDO (stuck) sigue usando attempts, no el contador de unverified', async () => {
  const env = makeEnv();
  const send = fakeSend({ submitted: 'stuck' });
  const w = makeWaker(env, { send });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();

  const pending = Object.values(w._state.pending);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].attempts, 1, 'stuck es un fallo: quema un attempt');
  assert.strictEqual(pending[0].unverified, undefined, 'y NO es un unverified');
});

test('W4: status() expone el conteo de unverified — sin numero no se puede fallar', async () => {
  const env = makeEnv();
  const send = fakeSend({ submitted: 'unknown' });
  const w = makeWaker(env, { send });
  assert.strictEqual(w.status().unverified, 0, 'sin intentos, cero');
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();
  assert.strictEqual(w.status().unverified, 1, 'un intento no verificable tiene que ser VISIBLE en status()');
});

test('W4: el conteo SOBREVIVE al flag — es acumulado, no "los que siguen pendientes"', async () => {
  const env = makeEnv();
  const w = makeWaker(env, { send: fakeSend({ submitted: 'unknown' }) });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();
  await w.tick(); // el intent se flaggea y sale de pending
  assert.strictEqual(Object.keys(w._state.pending).length, 0, 'precondicion: ya se flaggeo');
  assert.strictEqual(w.status().unverified, 2,
    'contar solo sobre pending devolveria el numero a 0 justo cuando el problema se CONFIRMO');
});
