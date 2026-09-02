'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0282 — el ledger acepta y descarta EN SILENCIO, y por eso el backlog roto
 * no se puede reparar con la herramienta.
 *
 * DOS MITADES, y la segunda es la que cierra el circulo:
 *
 *  · `create()` persiste `repo` y `acceptance_criteria` con default silencioso y
 *    CERO validacion, y acepta `--blocker` sin leerlo nunca. Cuatro tarjetas
 *    nacieron rotas en una sola noche (T-0276, T-0278, T-0279, T-0280), las
 *    ultimas dos mientras se documentaba el defecto.
 *  · `update()` descarta `--repo`, `--criteria`, `--kind`, `--title`, `--goal` y
 *    `--note`: sale 0, imprime la tarjeta intacta, y el llamador se va
 *    convencido de que reparo algo. Ese ES el camino de reparacion del backlog,
 *    asi que hoy el backlog historico es IRREPARABLE por CLI — que es por lo que
 *    los orquestadores terminaron editando el JSON a mano, saltandose todos los
 *    guards de `writeTask`.
 *
 * MEDIDO EN EL FUENTE, no inferido (enumerando los accesos a `opts`):
 *    create() lee: blocked-by, corr, criteria, deps, goal, kind, next,
 *                  operator-decision, origin, parent, refs, repo, state, title
 *                  -> `blocker` NO esta.
 *    update() lee: blocked-by, blocker, corr, evidence, next, parent, state
 *                  -> repo, criteria, kind, title, goal, note NO estan.
 *
 * CONSECUENCIA MEDIDA: `fleet-board.cjs:129` agrupa por `t.repo`, asi que una
 * tarjeta sin repo cae en un grupo llamado literalmente 'null' y es irruteable.
 * Y una tarjeta sin criterios no puede cerrarse con evidencia porque no hay
 * contra que medirla.
 *
 * EL FAIL-CLOSED YA ES EL ESTILO DE LA CASA en este mismo archivo:
 * `assertKnownKind` tira ante un kind inventado, `assertBlockedBy` tira ante un
 * blocked_by ausente, y `update --state done` exige `--evidence`. Estos campos
 * simplemente quedaron afuera.
 *
 * POR QUE ESTE TEST VIVE ACA: `_docs-curation/test/` no tiene package.json ni
 * runner — sus 92 tests no los ejecuta ningun proceso (verificado grepeando el
 * arbol: no hay script, hook ni CI). Mismo criterio que
 * ledger-evidence-wipe.test.cjs:21 y ledger-fleet-minimum-gate.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// `_docs-curation` esta fuera de los allowed_paths de este repo, asi que el
// arreglo se disena y se verifica contra una COPIA antes de que el duenno del
// otro repo lo aplique. Este override es lo que hace repetible ese proceso:
// sin el, "verificado contra una copia" seria una afirmacion sin forma de
// reproducirla. Por defecto apunta al ledger real.
const LEDGER = process.env.WEZBRIDGE_LEDGER_PATH
  || path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const REAL_KINDS = path.join(__dirname, '..', '..', '_intel', 'kinds.json');

/**
 * Ledger descartable con el vocabulario REAL de kinds. Nunca las tarjetas
 * reales: un test que escriba en el plano de control es peor que no tenerlo.
 */
function sandbox(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-input-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(tmp, 'kinds.json'));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Llamar al ledger POR CLI, que es la via por la que nacieron las cuatro
 * tarjetas rotas. Devuelve { ok, stdout, stderr } en vez de tirar, porque lo
 * que se mide acá es justamente si falla o si acepta en silencio.
 */
function cli(intel, args) {
  try {
    const stdout = execFileSync(process.execPath, [LEDGER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const cards = (intel) => fs.readdirSync(path.join(intel, 'tasks'))
  .filter((f) => /^T-\d{4}\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', f), 'utf8')));

const only = (intel) => {
  const all = cards(intel);
  assert.equal(all.length, 1, `esperaba exactamente una tarjeta, hay ${all.length}`);
  return all[0];
};

// --- create(): lo que acepta en silencio -----------------------------------

test('create RECHAZA una tarjeta sin repo', () => {
  sandbox((intel) => {
    const r = cli(intel, ['create', '--title', 'sin dueño', '--goal', 'x', '--blocked-by', 'agent']);
    assert.equal(r.ok, false,
      'una tarjeta sin repo nace irruteable: fleet-board.cjs:129 agrupa por t.repo y la manda a un '
      + 'grupo llamado literalmente "null", donde nadie es su dueño y nadie la levanta');
    assert.match(r.stderr, /repo/i, 'el error tiene que nombrar el campo que falta');
    assert.equal(cards(intel).length, 0, 'y no debe quedar ninguna tarjeta escrita');
  });
});

/**
 * DECISIÓN PENDIENTE DEL OPERADOR, pineada acá para que no se pierda en prosa.
 *
 * El argumento para exigir criterios en `create()` es bueno: una tarjeta sin
 * ellos nace INCERRABLE, porque `update --state done` exige `--evidence` y la
 * evidencia se mide CONTRA los criterios. Con ninguno no hay contra qué medir.
 *
 * PERO exigirlos rompe el camino de intents del OPERADOR, y esto está MEDIDO,
 * no supuesto: `clawtrol-bridge.cjs:411` empuja `--criteria` sólo si el payload
 * trae `acceptance`, así que con el fail-closed puesto **4 tests de
 * clawtrol-bridge se pusieron en rojo, y no son fixtures — es la ruta viva por
 * la que el operador abre trabajo**.
 *
 * Cambiar eso cambia SU flujo de trabajo, y ésa no es una decisión del ledger
 * ni de un agente. El número que la acompaña: 16 de 49 tarjetas abiertas hoy no
 * tienen criterios.
 *
 * Este test fija el comportamiento ACTUAL. Si alguien lo pone fail-closed, se
 * pone rojo y lee acá por qué se decidió lo contrario, en vez de descubrirlo
 * cuando el operador no pueda abrir una tarjeta.
 */
test('DECISIÓN ABIERTA: create ACEPTA sin criterios — exigirlos rompe el camino del operador', () => {
  sandbox((intel) => {
    const r = cli(intel, ['create', '--title', 'sin medida', '--goal', 'x',
      '--repo', 'wezbridge', '--blocked-by', 'agent']);
    assert.equal(r.ok, true,
      'hoy se acepta a propósito: el fail-closed rompe clawtrol-bridge, que es cómo el '
      + 'operador abre trabajo. La decisión de cambiarlo es suya, no del ledger');
    assert.equal(cards(intel).length, 1);
    assert.deepEqual(cards(intel)[0].acceptance_criteria, [],
      'nace sin criterios y por lo tanto incerrable: el hueco es REAL y queda visible acá');
  });
});

test('create PERSISTE --blocker en vez de comérselo', () => {
  // Medido en vivo al crear T-0287: se pasó la pregunta al operador por
  // --blocker y la tarjeta nació con blocker:null. Es el PEOR de los tres
  // droppers por consecuencia: la rutina del orquestador dice que `blocker` es
  // el texto que el operador lee en el tablero, así que una tarjeta gateada sin
  // blocker le pide al operador que decida sin decirle sobre qué.
  sandbox((intel) => {
    const r = cli(intel, ['create', '--title', 'con pregunta', '--goal', 'x',
      '--repo', 'wezbridge', '--criterion', 'a', '--criterion', 'b', '--blocked-by', 'operator',
      '--state', 'blocked', '--blocker', '¿migramos el NAS o lo retiramos?']);
    assert.equal(r.ok, true, `create falló: ${r.stderr}`);
    assert.equal(only(intel).blocker, '¿migramos el NAS o lo retiramos?',
      'el flag se aceptó y no se leyó nunca: la pregunta al operador se perdió al nacer la tarjeta');
  });
});

test('create SIGUE aceptando lo que está bien formado', () => {
  // El guard no puede disparar sobre comportamiento correcto: eso entrena a
  // todo el mundo a esquivarlo, que es la razón por la que el vocabulario se
  // fue a la deriva la primera vez.
  sandbox((intel) => {
    const r = cli(intel, ['create', '--title', 'bien formada', '--goal', 'y',
      '--repo', 'wezbridge', '--criterion', 'algo medible', '--criterion', 'otra cosa', '--blocked-by', 'agent']);
    assert.equal(r.ok, true, `una tarjeta completa tiene que pasar: ${r.stderr}`);
    const t = only(intel);
    assert.equal(t.repo, 'wezbridge');
    assert.deepEqual(t.acceptance_criteria, ['algo medible', 'otra cosa']);
  });
});

// --- update(): el camino de reparación del backlog -------------------------

test('update REPARA el repo de una tarjeta nacida rota', () => {
  sandbox((intel) => {
    // Nacida rota por la vía histórica: escrita a mano, que es exactamente lo
    // que hicieron los orquestadores porque el CLI no podía.
    fs.writeFileSync(path.join(intel, 'tasks', 'T-0001.json'), JSON.stringify({
      id: 'T-0001', title: 'rota', goal: 'x', kind: 'general', repo: null,
      state: 'queued', blocked_by: 'agent', acceptance_criteria: [], lease: null,
    }, null, 2));

    const r = cli(intel, ['update', 'T-0001', '--repo', 'pedrito']);
    assert.equal(r.ok, true, `update falló: ${r.stderr}`);
    assert.equal(only(intel).repo, 'pedrito',
      'update salió 0 e imprimió la tarjeta intacta: el llamador cree que la reparó y no reparó nada. '
      + 'Este es el camino con el que hay que arreglar 11 tarjetas sin repo');
  });
});

test('update REPARA los criterios de aceptación', () => {
  sandbox((intel) => {
    fs.writeFileSync(path.join(intel, 'tasks', 'T-0001.json'), JSON.stringify({
      id: 'T-0001', title: 'rota', goal: 'x', kind: 'general', repo: 'wezbridge',
      state: 'queued', blocked_by: 'agent', acceptance_criteria: [], lease: null,
    }, null, 2));

    const r = cli(intel, ['update', 'T-0001', '--criterion', 'medible', '--criterion', 'verificable']);
    assert.equal(r.ok, true, `update falló: ${r.stderr}`);
    assert.deepEqual(only(intel).acceptance_criteria, ['medible', 'verificable'],
      'sin esto, las 16 tarjetas abiertas sin criterios no se pueden cerrar nunca con evidencia');
  });
});

test('update REPARA title, goal y kind, y el kind sigue validado', () => {
  sandbox((intel) => {
    fs.writeFileSync(path.join(intel, 'tasks', 'T-0001.json'), JSON.stringify({
      id: 'T-0001', title: 'titulo malo', goal: 'objetivo malo', kind: 'general',
      repo: 'wezbridge', state: 'queued', blocked_by: 'agent',
      acceptance_criteria: ['a'], lease: null,
    }, null, 2));

    const ok = cli(intel, ['update', 'T-0001', '--title', 'titulo bueno',
      '--goal', 'objetivo bueno', '--kind', 'tooling-fix']);
    assert.equal(ok.ok, true, `update falló: ${ok.stderr}`);
    const t = only(intel);
    assert.equal(t.title, 'titulo bueno');
    assert.equal(t.goal, 'objetivo bueno');
    assert.equal(t.kind, 'tooling-fix');

    // Reparar no puede ser una puerta trasera al vocabulario cerrado: el mismo
    // fail-closed que create() aplica en assertKnownKind vale acá.
    const bad = cli(intel, ['update', 'T-0001', '--kind', 'inventado']);
    assert.equal(bad.ok, false, 'un kind inventado por update esquivaría assertKnownKind');
    assert.match(bad.stderr, /unknown kind/i);
    assert.equal(only(intel).kind, 'tooling-fix', 'y la tarjeta no debe quedar tocada');
  });
});

// --- flags desconocidos ----------------------------------------------------

test('un flag que el comando no entiende se RECHAZA, no se descarta', () => {
  sandbox((intel) => {
    const r = cli(intel, ['create', '--title', 'x', '--goal', 'y', '--repo', 'wezbridge',
      '--criteria', 'a', '--blocked-by', 'agent', '--prioridad', 'alta']);
    assert.equal(r.ok, false,
      'aceptar un flag que nunca se lee es la forma general de este defecto: el llamador ve exit 0 '
      + 'y cree que su dato entró');
    assert.match(r.stderr, /prioridad/,
      'el error tiene que nombrar el flag que sobra, si no el llamador no sabe qué corregir');
  });
});

test('--note de clawtrol deja de perderse: se registra en el evento', () => {
  // clawtrol-bridge.cjs:441 manda --note en CADA approve/retry/cancel, y se
  // pierde siempre. Si los flags desconocidos se rechazan SIN honrar --note,
  // approve y cancel —que hoy funcionan— empiezan a fallar. La provenance de
  // una transición no tiene campo en la tarjeta, así que va al evento, que es
  // donde vive "quién hizo esto y por qué".
  sandbox((intel) => {
    fs.writeFileSync(path.join(intel, 'tasks', 'T-0001.json'), JSON.stringify({
      id: 'T-0001', title: 'x', goal: 'y', kind: 'general', repo: 'wezbridge',
      state: 'queued', blocked_by: 'agent', acceptance_criteria: ['a'], lease: null,
    }, null, 2));

    const r = cli(intel, ['update', 'T-0001', '--state', 'ready',
      '--note', 'approve via clawtrol intent abc-123']);
    assert.equal(r.ok, true, `el approve de clawtrol tiene que seguir funcionando: ${r.stderr}`);
    assert.equal(only(intel).state, 'ready');

    const events = fs.readFileSync(path.join(intel, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const upd = events.filter((e) => e.event === 'task.updated').pop();
    assert.equal(upd.note, 'approve via clawtrol intent abc-123',
      'la nota de provenance se perdía en silencio en cada intent de clawtrol');
  });
});
