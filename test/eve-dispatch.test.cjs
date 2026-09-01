'use strict';
// eve-dispatch.test.cjs — W2/check 2: el payload EXACTO de task_submit sale de
// la tarjeta, no de la prosa de un pane. Convencion de corr <T-id>:<slug>:<fecha>,
// mode desde contract.mode, doneMeans desde los criterios, idempotencyKey
// sha256(corr), origin sin paneHint y con returnPreference WEZBRIDGE. `--apply`
// mueve la tarjeta a running por saltos LEGALES (queued->ready->running) y toma
// la lease `eve:<jobId>`; refusa sobre una tarjeta ya running o gateada.
// Depende de companions (_docs-curation/ledger.cjs es el FSM real).
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'eve-dispatch.cjs');
const CURATION = path.join(__dirname, '..', '..', '_docs-curation');
const REAL_KINDS = path.join(__dirname, '..', '..', '_intel', 'kinds.json');
const dispatch = require('../scripts/eve-dispatch.cjs');

function sandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-dispatch-'));
  const intel = path.join(root, '_intel');
  const curation = path.join(root, '_docs-curation');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  fs.mkdirSync(curation, { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(intel, 'kinds.json'));
  fs.copyFileSync(path.join(CURATION, 'ledger.cjs'), path.join(curation, 'ledger.cjs'));
  fs.copyFileSync(path.join(CURATION, 'sweeper-config.json'), path.join(curation, 'sweeper-config.json'));
  try { return fn(intel); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function card(intel, id, over = {}) {
  const c = {
    id,
    title: 'Eve consulta graph.json antes de despachar',
    goal: 'Que el gate del kind mande sobre la standing authorization',
    kind: 'tooling-fix',
    repo: 'wezbridge',
    state: 'queued',
    blocked_by: 'agent',
    acceptance_criteria: ['kind=deploy => AWAITING', 'kind=docs => APPROVED'],
    lease: null,
    attempt: 1,
    corr: null,
    contract: { mode: 'scoped_write', gate: null, allowed_paths: ['src/**', 'test/**'] },
    gate: null,
    state_changed_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
  fs.writeFileSync(path.join(intel, 'tasks', `${id}.json`), JSON.stringify(c, null, 2));
  return c;
}

const read = (intel, id) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8'));

function cli(intel, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel }, timeout: 30000,
  });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('W2: el payload de task_submit sale de la tarjeta, campo por campo', () => {
  sandbox((intel) => {
    card(intel, 'T-0401');
    const r = cli(intel, ['T-0401', '--project-id', 'proj-123', '--date', '20260901']);
    assert.equal(r.ok, true, r.stderr);
    // stdout ES el payload: se copia y pega en task_submit sin desarmar nada.
    const p = JSON.parse(r.stdout);
    const corr = 'T-0401:eve-consulta-graphjson:20260901';
    assert.ok(r.stderr.includes(`corr=${corr}`),
      `slug por defecto: kebab de las tres primeras palabras del titulo (stderr: ${r.stderr})`);
    assert.equal(p.projectId, 'proj-123');
    assert.equal(p.mode, 'CHANGE', 'contract.mode=scoped_write es un CHANGE');
    assert.match(p.objective, /gate del kind mande/);
    assert.match(p.objective, /\bkind=tooling-fix\b/, 'el kind viaja EN el objective: es lo unico que Eve puede leer para gatear');
    assert.deepEqual(p.doneMeans, ['kind=deploy => AWAITING', 'kind=docs => APPROVED']);
    assert.equal(p.idempotencyKey, crypto.createHash('sha256').update(corr).digest('hex'));
    assert.equal(p.delegationBrief.authority.mode, 'CHANGE');
    assert.equal(p.delegationBrief.authority.maximumOutput, 'DRAFT_PR');
    assert.deepEqual(p.delegationBrief.verifiedContext, []);
    assert.deepEqual(p.delegationBrief.acceptanceCriteria, p.doneMeans);
    assert.ok(p.delegationBrief.constraints.includes('src/**'), 'los allowed_paths del contrato son restricciones, no sugerencias');
    assert.ok(p.delegationBrief.constraints.some((c) => /^gate=/.test(c)), 'el gate viaja como restriccion declarada');
    assert.equal(p.origin.originProject, 'wezbridge');
    assert.equal(p.origin.correlationId, corr);
    assert.equal(p.origin.returnPreference, 'WEZBRIDGE');
    assert.equal(p.origin.paneHint, undefined, 'sin paneHint: los pane ids mueren en cada restart de wezterm');
  });
});

test('W2: contract.mode none/read_mostly baja la autoridad a INVESTIGATE/REPORT', () => {
  sandbox((intel) => {
    card(intel, 'T-0402', { contract: { mode: 'none', gate: 'operator' } });
    card(intel, 'T-0403', { contract: { mode: 'read_mostly', gate: null } });
    card(intel, 'T-0404', { contract: null });
    for (const id of ['T-0402', 'T-0403', 'T-0404']) {
      const p = JSON.parse(cli(intel, [id, '--project-id', 'p']).stdout);
      assert.equal(p.mode, 'INVESTIGATE', `${id}: sin escritura declarada no se pide CHANGE`);
      assert.equal(p.delegationBrief.authority.maximumOutput, 'REPORT');
    }
  });
});

test('W2: --apply mueve queued->ready->running (el salto directo es ilegal) y toma la lease eve:<job>', () => {
  sandbox((intel) => {
    card(intel, 'T-0405');
    const r = cli(intel, ['T-0405', '--project-id', 'p', '--date', '20260901', '--apply', '--job-id', 'JOB-abc']);
    assert.equal(r.ok, true, r.stderr);
    const after = read(intel, 'T-0405');
    assert.equal(after.state, 'running');
    assert.equal(after.corr, 'T-0405:eve-consulta-graphjson:20260901', 'el corr se setea ANTES del submit: es el unico string que vuelve');
    assert.equal(after.lease.owner, 'eve:JOB-abc', 'el relay necesita el jobId para nombrar la llamada exacta a FinalOrchestra');
    assert.match(r.stderr, /hops=ready->running/, 'los saltos quedan dichos: queued->running es ilegal en el FSM');
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout sigue siendo payload puro aun con --apply');
  });
});

test('W2: --apply refusa sobre una tarjeta ya running, una gateada, y sin --job-id', () => {
  sandbox((intel) => {
    card(intel, 'T-0406', { state: 'running' });
    const running = cli(intel, ['T-0406', '--project-id', 'p', '--apply', '--job-id', 'J']);
    assert.equal(running.ok, false);
    assert.match(running.stderr, /already running/i, 'dos executors sobre una tarjeta es el bug de la lease huerfana al reves');

    card(intel, 'T-0407', { state: 'blocked', blocked_by: 'operator', blocker: 'operator gate: kind deploy' });
    const blocked = cli(intel, ['T-0407', '--project-id', 'p', '--apply', '--job-id', 'J']);
    assert.equal(blocked.ok, false);
    assert.match(blocked.stderr, /gated card, decide first/i, 'un despacho no puede des-gatear: eso lo decide el operador');
    assert.equal(read(intel, 'T-0407').state, 'blocked', 'la tarjeta gateada no se movio ni un poco');

    card(intel, 'T-0408');
    const noJob = cli(intel, ['T-0408', '--project-id', 'p', '--apply']);
    assert.equal(noJob.ok, false);
    assert.match(noJob.stderr, /--job-id/, 'sin jobId la lease seria ilegible, que es el hallazgo que W5 persigue');
    assert.equal(read(intel, 'T-0408').state, 'queued');
  });
});

test('W2: sin --apply NADA se toca — imprimir el payload es una lectura', () => {
  sandbox((intel) => {
    card(intel, 'T-0409');
    const before = read(intel, 'T-0409');
    cli(intel, ['T-0409', '--project-id', 'p']);
    assert.deepEqual(read(intel, 'T-0409'), before);
  });
});

test('W2: el slug se puede fijar a mano y el kebab respeta acentos y puntuacion', () => {
  assert.equal(dispatch.slugFrom('Eve consulta graph.json antes de despachar'), 'eve-consulta-graphjson');
  assert.equal(dispatch.slugFrom('Migración RÁPIDA del índice'), 'migracion-rapida-del');
  assert.equal(dispatch.slugFrom('   '), 'task');
});
