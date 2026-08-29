'use strict';
/**
 * El waker no puede decir "finished work" sobre un pane que nunca recibió nada.
 *
 * MEDIDO 2026-08-29: tres panes (infra, memorymaster, wabot) tenían
 * instrucciones del operador SIN ENVIAR en su composer, y el waker reportó
 * "finished work" por cada una. El pane no había terminado el trabajo del
 * operador: nunca lo había recibido. Cuarenta minutos de infra parado mientras
 * la notificación afirmaba lo contrario.
 *
 * El propio comentario del waker ya nombra la regla que viola acá:
 *   "Say what HAPPENED, not what to do about it. Asserting a mode you have
 *    not checked is how a notification manufactures a fiction."
 *
 * El molde existe: el rider de CONTEXT (`CONTEXT 97% — arm the handoff`) ya
 * cuelga un hecho medido del poke. Este es el mismo mecanismo con el predicado
 * de T-0242.
 *
 * PRECONDICIÓN VERIFICADA, no supuesta: `lastLines` son las últimas 20 líneas
 * NO VACÍAS (pane-discovery.cjs:130), y medido contra las 12 panes vivas el
 * 2026-08-29 la línea del composer entra en las 8 panes de agente. Las 4 que no
 * traen marcador son cmd.exe y una muerta — sin TUI, nada que retener.
 *
 * LOS DOS SENTIDOS son obligatorios: un rider que se cuelga siempre convierte
 * cada poke en ruido y se aprende a ignorar, que es peor que no tenerlo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWaker } = require('../src/orchestrator-waker.cjs');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-composer-'));
  const eventsPath = path.join(dir, 'pane-events.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(eventsPath, '');
  return { dir, eventsPath, stateDir };
}

const beacon = (env, evt) => fs.appendFileSync(env.eventsPath, `${JSON.stringify(evt)}\n`);

function fakeSend() {
  const calls = [];
  return {
    calls,
    sendPromptDeferredEnter: async (paneId, text) => { calls.push({ paneId, text }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted',
  };
}

const BORDE = '─'.repeat(70);

/** lastLines tal como lo arma pane-discovery: últimas 20 líneas NO vacías. */
function paneWith(composerLine, project = 'G:/Py Apps/walksim') {
  return {
    paneId: 0,
    project,
    title: 'orch',
    status: 'idle',
    lastLines: [
      '  ● algo que el pane hizo antes',
      BORDE,
      composerLine,
      BORDE,
      '   Model: Opus 5  Thinking: high',
      '   Ctx Used: 21.0%  Context: [███░░░░░] 208k/1.0M (21%)',
    ].join('\n'),
  };
}

/** El pane del orquestador (destino del poke) siempre con el composer limpio. */
const ORCH_PANE = paneWith('❯', 'G:/Py Apps/wezbridge');

function makeWaker(env, panes, over = {}) {
  return createWaker({
    eventsPath: env.eventsPath,
    stateDir: env.stateDir,
    discoverPanes: () => panes,
    send: over.send || fakeSend(),
    settleTicks: 1,
    cooldownMs: 0,
    now: () => 1_000_000,
    log: () => {},
    watchRepos: ['walksim'],
    ...over,
  });
}

async function pokeFor(env, panes, send) {
  const w = makeWaker(env, panes, { send });
  beacon(env, { repo: 'walksim', session: 'abc', time: 't1', event: 'turn-end' });
  await w.tick();
  assert.ok(send.calls.length >= 1, 'precondición: el waker tiene que haber pokeado');
  return send.calls[send.calls.length - 1].text;
}

// ── SENTIDO A: retiene texto => el poke lo DICE ─────────────────────────────

test('A1 (fail-first): con texto sin enviar en el composer, el poke lo nombra', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const panes = [ORCH_PANE, paneWith('❯\u00a0dale, hacelo vos')];
  const text = await pokeFor(env, panes, send);

  assert.match(text, /composer/i,
    `el poke tiene que decir que el composer retiene texto. Poke: ${JSON.stringify(text)}`);
  assert.match(text, /dale, hacelo vos/,
    'y tiene que citar el texto retenido: sin eso el operador no sabe QUÉ se perdió');
});

test('A2: el poke NO puede afirmar "finished work" a secas sobre un pane trabado', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const panes = [ORCH_PANE, paneWith('❯\u00a0mergea el 235 cuando pase CI')];
  const text = await pokeFor(env, panes, send);

  assert.match(text, /composer/i,
    'sin el rider, el poke dice "finished work" sobre trabajo que el pane nunca recibió');
});

// ── SENTIDO B: no retiene => el poke NO lo menciona (anti-ruido) ────────────

test('B1 (el otro sentido): composer vacío => el poke NO habla de composer', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const panes = [ORCH_PANE, paneWith('❯')];
  const text = await pokeFor(env, panes, send);

  assert.doesNotMatch(text, /composer/i,
    'un rider que se cuelga siempre convierte cada poke en ruido y se aprende a ignorar');
});

test('B2: el placeholder de codex NO es texto retenido', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const panes = [ORCH_PANE, paneWith('› Ask Codex to do anything')];
  const text = await pokeFor(env, panes, send);

  assert.doesNotMatch(text, /composer/i,
    '"Ask Codex to do anything" es chrome del TUI; tratarlo como retención marca toda pane codex');
});

test('B3: un pane sin marcador (cmd.exe, pane muerta) no dispara nada', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const shell = {
    paneId: 9, project: 'G:/Py Apps/walksim', title: 'cmd.exe', status: 'idle',
    lastLines: "'claude' is not recognized as an internal or external command,\njarvissmb@WOLVERIN0 G:\\Py Apps>",
  };
  const text = await pokeFor(env, [ORCH_PANE, shell], send);

  assert.doesNotMatch(text, /composer/i, 'sin TUI no hay composer que retenga nada');
});

test('B4: lastLines ausente o ilegible => fail-open, sin rider', async () => {
  const env = makeEnv();
  const send = fakeSend();
  const blind = { paneId: 9, project: 'G:/Py Apps/walksim', title: 'x', status: 'idle' };
  const text = await pokeFor(env, [ORCH_PANE, blind], send);

  assert.doesNotMatch(text, /composer/i, 'un rider que no puede medir no puede afirmar');
});
