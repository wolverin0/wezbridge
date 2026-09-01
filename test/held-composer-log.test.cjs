'use strict';
/**
 * held-composer-log.test.cjs — W4: el texto retenido del composer se PERSISTE.
 * Cubre `paneHeldComposerDetail` ({paneId, text}), el append a
 * `<intelDir>/held-composer.jsonl` cuando el waker detecta retencion, el
 * dedupe por sha1(pane|text) a traves de ticks Y de reinicios del waker, y el
 * fail-soft (un intelDir inescribible nunca tumba el tick).
 *
 * MEDIDO: hasta hoy el texto retenido se leia EN VIVO y no se guardaba en
 * ningun lado — la cita falsa del 2026-08-31 salio justamente de reconstruir
 * de memoria algo que nadie habia escrito.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWaker, paneHeldComposer, paneHeldComposerDetail } = require('../src/orchestrator-waker.cjs');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-log-'));
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(eventsPath, '');
  return { dir, eventsPath, stateDir };
}

const beacon = (env, evt) => fs.appendFileSync(env.eventsPath, `${JSON.stringify(evt)}\n`);
const BORDE = '─'.repeat(70);

function paneWith(composerLine, project, paneId) {
  return {
    paneId,
    project,
    title: 'w',
    status: 'idle',
    lastLines: ['  ● algo previo', BORDE, composerLine, BORDE, '   Ctx Used: 21.0%'].join('\n'),
  };
}

const ORCH_PANE = paneWith('❯', 'G:/Py Apps/wezbridge', 0);

function fakeSend() {
  const calls = [];
  return {
    calls,
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
  };
}

function makeWaker(env, panes, over = {}) {
  return createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: () => panes,
    send: over.send || fakeSend(),
    settleTicks: 1,
    cooldownMs: 0,
    now: over.now || (() => Date.parse('2026-09-01T10:00:00Z')),
    log: () => {},
    watchRepos: ['walksim'],
    ...over,
  });
}

const logFile = (env) => path.join(env.dir, 'held-composer.jsonl');
function logLines(env) {
  try {
    return fs.readFileSync(logFile(env), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ── el detalle: quien retiene, no solo que ─────────────────────────────────

test('W4: paneHeldComposerDetail devuelve pane Y texto; paneHeldComposer sigue devolviendo el texto', () => {
  const panes = [ORCH_PANE, paneWith('❯\u00a0dale, hacelo vos', 'G:/Py Apps/walksim', 17)];
  const detail = paneHeldComposerDetail(panes, 'walksim');
  assert.ok(detail, 'con texto retenido tiene que haber detalle');
  assert.strictEqual(detail.paneId, 17, 'sin el pane, la linea persistida no dice DONDE quedo trabado');
  assert.match(detail.text, /dale, hacelo vos/);
  // El wrapper viejo es contrato: sus llamadores y tests siguen vivos.
  assert.strictEqual(paneHeldComposer(panes, 'walksim'), detail.text);
});

test('W4: sin retencion, el detalle es null (fail-open, igual que el wrapper)', () => {
  const panes = [ORCH_PANE, paneWith('❯', 'G:/Py Apps/walksim', 17)];
  assert.strictEqual(paneHeldComposerDetail(panes, 'walksim'), null);
  assert.strictEqual(paneHeldComposer(panes, 'walksim'), null);
});

// ── la persistencia ────────────────────────────────────────────────────────

test('W4: al detectar retencion se escribe UNA linea en held-composer.jsonl con time/repo/pane/held', async () => {
  const env = makeEnv();
  const panes = [ORCH_PANE, paneWith('❯\u00a0mergea el 235 cuando pase CI', 'G:/Py Apps/walksim', 17)];
  const w = makeWaker(env, panes);
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w.tick();

  const lines = logLines(env);
  assert.strictEqual(lines.length, 1, `una deteccion, una linea. Archivo: ${logFile(env)}`);
  assert.strictEqual(lines[0].repo, 'walksim');
  assert.strictEqual(lines[0].pane, 17);
  assert.match(lines[0].held, /mergea el 235/);
  assert.match(lines[0].time, /^2026-09-01T/, 'el reloj inyectado manda');
});

test('W4: el mismo texto retenido no se persiste dos veces (dedupe sha1(pane|text))', async () => {
  const env = makeEnv();
  const panes = [ORCH_PANE, paneWith('❯\u00a0no te olvides del deploy', 'G:/Py Apps/walksim', 17)];
  const w = makeWaker(env, panes);
  for (const t of ['t1', 't2', 't3']) {
    beacon(env, { repo: 'walksim', session: 'a', time: t, event: 'turn-end' });
    await w.tick();
  }
  assert.strictEqual(logLines(env).length, 1,
    'tres ticks con la MISMA retencion son un solo hecho; un append por tick convierte el archivo en ruido');
});

test('W4: el dedupe sobrevive un reinicio del waker (vive en el state dir, no en RAM)', async () => {
  const env = makeEnv();
  const panes = [ORCH_PANE, paneWith('❯\u00a0revisá el PR 246', 'G:/Py Apps/walksim', 17)];
  // El waker se construye ANTES del beacon: un cursor fresco arranca en EOF.
  const w1 = makeWaker(env, panes);
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w1.tick();
  const w2 = makeWaker(env, panes); // instancia NUEVA, mismo state dir
  beacon(env, { repo: 'walksim', session: 'a', time: 't2', event: 'turn-end' });
  await w2.tick();
  assert.strictEqual(logLines(env).length, 1, 'un reinicio del daemon no puede duplicar la linea');
});

test('W4: texto retenido DISTINTO en el mismo pane si es una linea nueva', async () => {
  const env = makeEnv();
  const first = [ORCH_PANE, paneWith('❯\u00a0primera instruccion', 'G:/Py Apps/walksim', 17)];
  const w1 = makeWaker(env, first);
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w1.tick();
  const second = [ORCH_PANE, paneWith('❯\u00a0segunda instruccion distinta', 'G:/Py Apps/walksim', 17)];
  const w2 = makeWaker(env, second);
  beacon(env, { repo: 'walksim', session: 'a', time: 't2', event: 'turn-end' });
  await w2.tick();
  assert.strictEqual(logLines(env).length, 2, 'dedupear por pane solo taparia la segunda instruccion perdida');
});

test('W4: sin retencion NO se crea el archivo (anti-ruido)', async () => {
  const env = makeEnv();
  const panes = [ORCH_PANE, paneWith('❯', 'G:/Py Apps/walksim', 17)];
  const w = makeWaker(env, panes);
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w.tick();
  assert.strictEqual(fs.existsSync(logFile(env)), false, 'un composer limpio no es un hecho para archivar');
});

test('W4: el held se recorta a 200 chars', async () => {
  const env = makeEnv();
  const largo = `x${'y'.repeat(400)}`;
  const panes = [ORCH_PANE, paneWith(`❯\u00a0${largo}`, 'G:/Py Apps/walksim', 17)];
  const w = makeWaker(env, panes);
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w.tick();
  assert.strictEqual(logLines(env)[0].held.length, 200);
});

test('W4: fail-soft — un intelDir inescribible no tumba el tick ni frena el poke', async () => {
  const env = makeEnv();
  // held-composer.jsonl no se puede crear porque su path ya es un DIRECTORIO.
  fs.mkdirSync(logFile(env), { recursive: true });
  const send = fakeSend();
  const panes = [ORCH_PANE, paneWith('❯\u00a0algo retenido', 'G:/Py Apps/walksim', 17)];
  const w = makeWaker(env, panes, { send });
  beacon(env, { repo: 'walksim', session: 'a', time: 't1', event: 'turn-end' });
  await w.tick(); // no debe tirar
  assert.strictEqual(send.calls.length, 1, 'el poke sale igual: un log que no puede escribir no puede frenar el loop');
});
