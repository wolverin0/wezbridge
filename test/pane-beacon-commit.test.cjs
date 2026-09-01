'use strict';
/**
 * pane-beacon-commit.test.cjs — commit identity on every turn-end (slice 3)
 * plus the PROPOSAL marker (slice 5). Spawns the REAL global hook by absolute
 * path — the file every Claude session on this machine runs on every turn —
 * against a temp WEZBRIDGE_INTEL_DIR and a temp git repo. The fail-soft
 * contract is asserted everywhere: exit 0 always, NEVER any stdout on Stop.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const HOOK = 'C:/Users/pauol/.claude/hooks/pane-beacon.cjs';

const mkIntel = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-intel-'));

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'beacon@test.local');
  git(dir, 'config', 'user.name', 'beacon-test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'one');
  return dir;
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

let n = 0;
function commit(dir, msg) {
  fs.writeFileSync(path.join(dir, 'f.txt'), `${msg}-${n += 1}`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Run the hook exactly as Claude Code does: JSON on stdin, Stop event. */
function beacon(intel, { cwd, session = 'beacontest', transcript = '' } = {}) {
  const transcriptPath = path.join(intel, `${session}.transcript.txt`);
  fs.appendFileSync(transcriptPath, transcript);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'Stop', session_id: session,
      cwd, transcript_path: transcriptPath,
    }),
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel },
    encoding: 'utf8', timeout: 20000,
  });
  assert.strictEqual(res.status, 0, `the hook must NEVER exit non-zero (stderr: ${res.stderr})`);
  assert.strictEqual(res.stdout, '', 'no stdout on Stop — a beacon must never alter the watched session');
  return res;
}

const lines = (intel) => fs.readFileSync(path.join(intel, 'pane-events.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));

test('same HEAD twice: neither beacon claims head_moved, but heads are tracked', () => {
  const intel = mkIntel();
  const repo = mkRepo();
  beacon(intel, { cwd: repo });
  beacon(intel, { cwd: repo });
  const [first, second] = lines(intel);
  // First-ever observation is a baseline, not movement — and an unchanged HEAD
  // is the mutation this guards: head_moved on a quiet repo is a FALSE work
  // signal, and downstream (board freshness, steward) trusts it as ground truth.
  assert.strictEqual(first.head_moved, undefined, 'first observation is a baseline, not a move');
  assert.strictEqual(second.head_moved, undefined, 'unchanged HEAD must not claim head_moved');
  assert.strictEqual(second.head, undefined);
  assert.strictEqual(second.head_prev, undefined);
  // ...but the state file updates on EVERY turn, marker or no marker.
  const heads = JSON.parse(fs.readFileSync(path.join(intel, '.beacon-heads.json'), 'utf8'));
  const repoKey = path.basename(repo);
  assert.strictEqual(heads[repoKey], git(repo, 'rev-parse', 'HEAD').trim(),
    '.beacon-heads.json must track HEAD on every turn-end, not only when deploy markers appear');
});

test('a commit between beacons stamps head, head_prev and head_moved', () => {
  const intel = mkIntel();
  const repo = mkRepo();
  const sha1 = git(repo, 'rev-parse', 'HEAD').trim();
  beacon(intel, { cwd: repo });                    // baseline
  const sha2 = commit(repo, 'two');
  beacon(intel, { cwd: repo });                    // HEAD moved
  beacon(intel, { cwd: repo });                    // quiet again
  const all = lines(intel);
  const moved = all[1];
  assert.strictEqual(moved.head_moved, true);
  assert.strictEqual(moved.head, sha2);
  assert.strictEqual(moved.head_prev, sha1);
  // The move is reported ONCE. The next quiet turn carries nothing — otherwise
  // one commit reads as perpetual progress.
  assert.strictEqual(all[2].head_moved, undefined, 'a single commit must not echo forever');
  assert.strictEqual(all[2].head, undefined);
});

test('non-repo cwd: head fields absent, exit 0, beacon still lands', () => {
  const intel = mkIntel();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-norepo-'));
  beacon(intel, { cwd: plain });
  const [line] = lines(intel);
  assert.strictEqual(line.event, 'turn-end', 'the beacon itself must still be appended');
  assert.strictEqual(line.head, undefined);
  assert.strictEqual(line.head_prev, undefined);
  assert.strictEqual(line.head_moved, undefined);
});

test('PROPOSAL:<slug> is a recognised marker (slice 5)', () => {
  const intel = mkIntel();
  const repo = mkRepo();
  beacon(intel, { cwd: repo, transcript: 'Recommend filing this. PROPOSAL:board-freshness-gate\n' });
  const [line] = lines(intel);
  assert.ok(line.markers.includes('PROPOSAL:BOARD-FRESHNESS-GATE'),
    `PROPOSAL marker must be captured, got: ${JSON.stringify(line.markers)}`);
});

// ── W4: pistas de pane/cwd del beacon — el waker las acepta y las VERIFICA ──
//
// El beacon escribe hoy solo `repo`: el waker resuelve el pane del repo por
// SUFIJO del cwd, que es ambiguo apenas dos checkouts comparten hoja. El diff
// PROPUESTO al hook (operator-owned, no aplicado aca) agrega `pane` y `cwd`.
//
// La regla que estos tests fijan: un pane id es PISTA, nunca direccion. Esta
// maquina corre DOS mux sockets que numeran los mismos panes distinto
// (pane-identity.cjs:166-180), asi que un id del beacon solo se usa si el censo
// confirma que ese pane vive en el repo. Y el waker tiene que seguir tragando
// la forma ACTUAL del hook, sin pane ni cwd, o el dia del diff se rompe todo.

const { createWaker, paneHeldComposerDetail, paneRunsBypass, paneContextPct } = require('../src/orchestrator-waker.cjs');

function wakerOver(eventsPath, stateDir, repo) {
  return createWaker({
    eventsPath,
    stateDir,
    discoverPanes: () => [],
    send: { sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' },
    settleTicks: 99, // nunca entrega: aca solo se mide la INGESTA
    now: () => Date.now(),
    log: () => {},
    watchRepos: [repo],
  });
}

test('W4: la salida REAL del hook (sin pane/cwd) sigue siendo ingerible por el waker', async () => {
  const intel = mkIntel();
  const repo = mkRepo();
  beacon(intel, { cwd: repo });
  const [line] = lines(intel);
  assert.strictEqual(line.pane, undefined, 'precondicion: el hook de HOY no emite pane (el diff esta PROPUESTO)');

  const w = wakerOver(path.join(intel, 'pane-events.jsonl'), path.join(intel, 'state'), line.repo);
  w._state.cursorBytes = 0; w._state.cursorTail = null; // leer desde el principio
  await w.tick();
  const pending = Object.values(w._state.pending);
  assert.strictEqual(pending.length, 1, 'la forma actual del beacon no puede dejar de producir intents');
  assert.strictEqual(pending[0].pane, undefined);
  assert.strictEqual(pending[0].cwd, undefined);
});

test('W4: una linea de beacon CON pane/cwd guarda ambos en el intent', async () => {
  const intel = mkIntel();
  const eventsPath = path.join(intel, 'pane-events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    time: new Date().toISOString(), repo: 'walksim', session: 'abcd',
    event: 'turn-end', pane: 17, cwd: 'G:/Py Apps/walksim',
  })}\n`);
  const w = wakerOver(eventsPath, path.join(intel, 'state'), 'walksim');
  w._state.cursorBytes = 0; w._state.cursorTail = null;
  await w.tick();
  const [intent] = Object.values(w._state.pending);
  assert.strictEqual(intent.pane, 17);
  assert.strictEqual(intent.cwd, 'G:/Py Apps/walksim');
});

test('W4: pane no entero o cwd no string se descartan — basura del hook no contamina el intent', async () => {
  const intel = mkIntel();
  const eventsPath = path.join(intel, 'pane-events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    time: new Date().toISOString(), repo: 'walksim', session: 'abcd',
    event: 'turn-end', pane: null, cwd: 42,
  })}\n`);
  const w = wakerOver(eventsPath, path.join(intel, 'state'), 'walksim');
  w._state.cursorBytes = 0; w._state.cursorTail = null;
  await w.tick();
  const [intent] = Object.values(w._state.pending);
  assert.strictEqual(intent.pane, undefined, 'pane:null es "no se supo", no un pane');
  assert.strictEqual(intent.cwd, undefined);
});

// ── los riders con pista: cwd exacto > pane verificado > sufijo ─────────────

const BORDE2 = '─'.repeat(70);
const paneOf = (paneId, project, composer, extra = '') => ({
  paneId, project, title: 't', status: 'idle',
  lastLines: ['  ● previo', BORDE2, composer, BORDE2, extra].join('\n'),
});

test('W4: con dos checkouts de la misma hoja, el cwd exacto de la pista gana al sufijo', () => {
  const panes = [
    paneOf(3, 'G:/Py Apps/_worktrees/walksim', '❯\u00a0texto del worktree'),
    paneOf(9, 'G:/Py Apps/walksim', '❯\u00a0texto del checkout principal'),
  ];
  // Sin pista: el sufijo matchea al PRIMERO que aparece — ambiguo por construccion.
  assert.match(paneHeldComposerDetail(panes, 'walksim').text, /worktree/);
  // Con la pista de cwd: se resuelve exactamente el pane que emitio el beacon.
  const hinted = paneHeldComposerDetail(panes, 'walksim', { cwd: 'G:\\Py Apps\\walksim' });
  assert.strictEqual(hinted.paneId, 9, 'el cwd exacto normalizado manda sobre el sufijo');
  assert.match(hinted.text, /checkout principal/);
});

test('W4: el pane id de la pista se usa SOLO si el censo lo pone en el repo', () => {
  const panes = [
    paneOf(9, 'G:/Py Apps/walksim', '❯\u00a0texto del pane correcto'),
    paneOf(17, 'G:/Py Apps/wabot', '❯\u00a0texto de OTRO repo'),
  ];
  // pane 17 existe en el censo pero vive en wabot: la pista se DESCARTA y se
  // cae al sufijo, que resuelve el pane 9. Confiarla a ciegas devolveria el
  // texto de wabot atribuido a walksim — la clase de mentira de los dos sockets.
  const hinted = paneHeldComposerDetail(panes, 'walksim', { pane: 17 });
  assert.strictEqual(hinted.paneId, 9, 'un pane id de otro socket no puede secuestrar el rider');
  assert.match(hinted.text, /pane correcto/);
});

test('W4: un pane id de la pista que SI vive en el repo se usa', () => {
  const panes = [
    paneOf(3, 'G:/Py Apps/_worktrees/walksim', '❯\u00a0worktree'),
    paneOf(9, 'G:/Py Apps/walksim', '❯\u00a0principal'),
  ];
  assert.strictEqual(paneHeldComposerDetail(panes, 'walksim', { pane: 9 }).paneId, 9);
});

test('W4: los otros dos riders aceptan la misma pista con la misma regla', () => {
  const panes = [
    paneOf(9, 'G:/Py Apps/walksim', '❯', '   Ctx Used: 12.0%'),
    paneOf(17, 'G:/Py Apps/wabot', '❯', '   Ctx Used: 97.0%  ⏵⏵ bypass permissions on'),
  ];
  assert.strictEqual(paneContextPct(panes, 'walksim', { pane: 17 }), 12,
    'un id de otro repo no puede prestarle su 97% a walksim');
  assert.strictEqual(paneRunsBypass(panes, 'walksim', { pane: 17 }), false,
    'ni su modo bypass');
  assert.strictEqual(paneContextPct(panes, 'walksim', { cwd: 'G:/Py Apps/walksim' }), 12);
});

test('W4: una pista que no resuelve nada cae al comportamiento de siempre (fail-open)', () => {
  const panes = [paneOf(9, 'G:/Py Apps/walksim', '❯\u00a0algo retenido')];
  assert.match(paneHeldComposerDetail(panes, 'walksim', { pane: 999, cwd: 'D:/nada' }).text, /algo retenido/);
  assert.strictEqual(paneHeldComposerDetail(panes, 'walksim', {}).paneId, 9);
});
