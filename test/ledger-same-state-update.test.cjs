'use strict';
/**
 * T-0293 — `update()` devuelve exito sobre una transicion que NO ocurrio.
 *
 * `ledger.cjs update()` valida la transicion SOLO cuando el estado cambia:
 *
 *     if (opts.state !== task.state && !TRANSITIONS[task.state].includes(opts.state))
 *
 * Asi que pedir el estado que la tarjeta YA tiene pasa como no-op, devuelve la
 * tarjeta y sale 0. El llamador no tiene forma de distinguir "la movi" de "no
 * hice nada". Encontrado verificando T-0292: el retry roto de clawtrol apuntaba
 * a `queued`, fallaba con "illegal transition" desde todos los estados menos
 * `queued` — y ahi devolvia `applied` sin mover nada. El peor caso de aquella
 * tarjeta no fue un error, fue este silencio.
 *
 * LA DECISION, y la cambie a mitad de camino porque la medicion me contradijo.
 *
 * Mi primera eleccion fue RECHAZAR el no-op. Lo implemente, corri la suite
 * entera de wezbridge contra un espejo del arbol con el ledger parcheado, y
 * aparecio una regresion: el `retry` del operador sobre una tarjeta que YA esta
 * en `ready` pasaba a devolver error. Esa situacion es BENIGNA — el fin que el
 * operador pedia (que la tarjeta sea tomable) ya se cumple — y un guard que
 * dispara sobre comportamiento correcto ensena a todo el mundo a esquivarlo.
 * La tarjeta ya lo advertia: "un update idempotente puede ser deseable".
 *
 * Asi que no se rechaza: se hace DISTINGUIBLE. El retorno declara
 * `state_unchanged: true`, que es aditivo — quien lo ignora se comporta igual
 * que antes — y viaja por los DOS canales que usan los llamadores reales:
 *
 *  · `orchestrator-turn.cjs:350` (raiseStall) consume el retorno como OBJETO
 *    TAREA, le lee `.id`, y NO manda `--state`. Sigue intacto: el campo es
 *    aditivo y su camino ni siquiera lo activa.
 *  · `clawtrol-bridge.cjs:459` es el UNICO codigo de produccion que manda
 *    `--state`, y lo hace por CLI: lee el JSON impreso, donde el marcador
 *    aparece igual.
 *
 * El marcador NO se persiste: `writeTask` ya escribio la tarjeta antes, asi que
 * el archivo no gana un campo que no es suyo.
 *
 * Un update SIN `--state` no se toca: escribir blocker, next o evidence sobre
 * una tarjeta quieta es legitimo y frecuente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LEDGER = process.env.WEZBRIDGE_LEDGER_PATH
  || path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const REAL_KINDS = path.join(__dirname, '..', '..', '_intel', 'kinds.json');

function sandbox(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-samestate-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(tmp, 'kinds.json'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function cli(intel, args) {
  try {
    const stdout = execFileSync(process.execPath, [LEDGER, ...args], {
      encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const card = (intel, id) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8'));

function cardInState(intel, id, state) {
  fs.writeFileSync(path.join(intel, 'tasks', `${id}.json`), JSON.stringify({
    id, title: 'x', goal: 'y', kind: 'general', repo: 'wezbridge', state,
    blocked_by: 'agent', acceptance_criteria: ['algo medible'], lease: null, attempt: 1,
    state_changed_at: '2026-01-01T00:00:00.000Z',
  }, null, 2));
  return id;
}

// Los estados abiertos donde el no-op es alcanzable. Cuatro, no uno: el defecto
// no es del retry de clawtrol, es de `update` — sirve para toda la tabla.
const STATES = ['queued', 'ready', 'review', 'blocked'];

test('un update al MISMO estado se DISTINGUE de una transición real, en cada estado abierto', () => {
  sandbox((intel) => {
    const mudos = [];
    for (const state of STATES) {
      const id = cardInState(intel, `T-0${100 + STATES.indexOf(state)}`, state);
      const r = cli(intel, ['update', id, '--state', state]);
      assert.equal(r.ok, true, `el no-op tiene que seguir siendo exitoso: ${r.stderr}`);
      if (JSON.parse(r.stdout).state_unchanged !== true) mudos.push(state);
    }
    assert.deepEqual(mudos, [],
      'en estos estados el llamador NO puede distinguir "la moví" de "no hice nada": '
      + `${mudos.join(', ')}`);
  });
});

test('una transición REAL no lleva el marcador: el guard no puede ser un "siempre true"', () => {
  sandbox((intel) => {
    const id = cardInState(intel, 'T-0200', 'queued');
    const r = cli(intel, ['update', id, '--state', 'ready']);
    assert.equal(r.ok, true, r.stderr);
    assert.equal(JSON.parse(r.stdout).state_unchanged, undefined,
      'si el marcador apareciera también en una transición real no distinguiría nada');
  });
});

test('el marcador NO se persiste: la tarjeta en disco no gana un campo que no es suyo', () => {
  sandbox((intel) => {
    const id = cardInState(intel, 'T-0300', 'review');
    cli(intel, ['update', id, '--state', 'review']);
    assert.equal('state_unchanged' in card(intel, id), false,
      'el marcador es del RETORNO, no de la tarjeta: persistirlo lo dejaría pegado para siempre '
      + 'y cualquiera lo leería como un campo del ledger');
  });
});

test('el no-op SIGUE aplicando el resto del patch: idempotente no es inerte', () => {
  sandbox((intel) => {
    const id = cardInState(intel, 'T-0350', 'blocked');
    const r = cli(intel, ['update', id, '--state', 'blocked', '--blocker', 'el operador decide']);
    assert.equal(r.ok, true, r.stderr);
    assert.equal(card(intel, id).blocker, 'el operador decide',
      'pedir el mismo estado no puede descartar los otros campos del update');
  });
});

test('un no-op NO mueve state_changed_at: el reloj de staleness no se resetea', () => {
  // `writeTask` sólo estampa `state_changed_at` en una transición real, y el
  // steward lee ese campo como "esto se movió". Si un no-op lo tocara, cualquiera
  // podría mantener el tablero verde pidiendo el estado que la tarjeta ya tiene.
  sandbox((intel) => {
    const id = cardInState(intel, 'T-0360', 'ready');
    const antes = card(intel, id).state_changed_at;
    cli(intel, ['update', id, '--state', 'ready']);
    assert.equal(card(intel, id).state_changed_at, antes);
  });
});

// --- lo que NO puede romperse -----------------------------------------------

test('una transición REAL sigue funcionando en cada estado abierto', () => {
  sandbox((intel) => {
    const legales = { queued: 'ready', ready: 'running', review: 'done', blocked: 'ready' };
    for (const [from, to] of Object.entries(legales)) {
      const id = cardInState(intel, `T-04${STATES.indexOf(from)}0`, from);
      const args = ['update', id, '--state', to];
      if (to === 'done') args.push('--evidence', 'medido: suite 1000/998');
      const r = cli(intel, args);
      assert.equal(r.ok, true, `${from} -> ${to} dejó de funcionar: ${r.stderr}`);
      assert.equal(card(intel, id).state, to);
    }
  });
});

test('un update SIN --state no se toca: escribir sobre una tarjeta quieta es legítimo', () => {
  // Es lo que hace raiseStall (orchestrator-turn.cjs:350) en cada re-alarma, y
  // lo que hace cualquiera que anote un blocker o un next sin mover la tarjeta.
  sandbox((intel) => {
    const id = cardInState(intel, 'T-0500', 'blocked');
    const r = cli(intel, ['update', id, '--blocker', 'el operador tiene que decidir', '--next', 'leer los turnos']);
    assert.equal(r.ok, true, `un update sin --state tiene que seguir pasando: ${r.stderr}`);
    const t = card(intel, id);
    assert.equal(t.blocker, 'el operador tiene que decidir');
    assert.equal(t.state, 'blocked');
  });
});

test('una transición ILEGAL sigue dando su propio error, distinto del no-op', () => {
  // Los dos mensajes tienen que seguir siendo distinguibles: "no existe ese
  // camino" y "ya estabas ahí" son problemas distintos del llamador.
  sandbox((intel) => {
    const id = cardInState(intel, 'T-0600', 'queued');
    const r = cli(intel, ['update', id, '--state', 'running']);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /illegal transition/i);
    assert.doesNotMatch(r.stderr, /already in state/i);
  });
});

test('el retorno programático sigue siendo el OBJETO TAREA', () => {
  // raiseStall hace `return ledger.update(card.id, { blocker })` y después le lee
  // `.id`. Si esto pasara a devolver {task, moved} se rompería en silencio —
  // que es exactamente el defecto que esta tarjeta cierra.
  sandbox((intel) => {
    const prev = process.env.WEZBRIDGE_INTEL_DIR;
    process.env.WEZBRIDGE_INTEL_DIR = intel;
    const modPath = require.resolve(LEDGER);
    delete require.cache[modPath];
    try {
      const ledger = require(modPath);
      const id = cardInState(intel, 'T-0700', 'blocked');
      const out = ledger.update(id, { blocker: 'una pregunta' });
      assert.equal(out.id, id, 'el retorno dejó de ser la tarjeta: raiseStall le lee .id');
      assert.equal(out.state, 'blocked');
      assert.equal(out.blocker, 'una pregunta');
    } finally {
      if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
      else process.env.WEZBRIDGE_INTEL_DIR = prev;
      delete require.cache[require.resolve(LEDGER)];
    }
  });
});
