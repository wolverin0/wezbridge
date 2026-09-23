'use strict';
// T30: depende de _docs-curation/ledger.cjs fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

/**
 * T-0548 — runtime/model/effort/tier por tarjeta en ledger.cjs.
 *
 * La tarjeta es la fuente del despacho (task_router.py --from-card): si acepta un
 * modelo inventado o un effort que ese modelo no tiene, el despacho sale roto y
 * nadie lo nota hasta que el runtime lo rechaza (o lo ignora en silencio).
 * El fixture de model-tiers.json es propio del test (subconjunto del formato
 * canonico de _intel/model-tiers-crosscheck-chatgpt-20260923.md) para que el
 * test no dependa del archivo vivo, que otro agente edita.
 *
 * Contra el ledger anterior TODOS estos casos fallan: --tier/--model/--effort
 * eran flags desconocidos (exit 1 incluso en el camino valido) y el dashboard no
 * imprimia modelo.
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

const TIERS_FIXTURE = {
  version: 1,
  models: {
    'claude-fable-5-1': { runtime: 'claude', alias: 'fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'high' },
    'claude-opus-5-5': { runtime: 'claude', alias: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
    'claude-sonnet-5': { runtime: 'claude', alias: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'high' },
    'claude-haiku-4-5-20251001': { runtime: 'claude', alias: 'haiku', efforts: [], default_effort: null },
    'gpt-6-astra': { runtime: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_effort: 'low' },
    'gpt-6-sol': { runtime: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_effort: 'medium' },
    'gpt-6-luna': { runtime: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium' },
  },
  tiers: {
    T1: { claude: { model: 'claude-haiku-4-5-20251001', effort: null }, codex: { model: 'gpt-6-luna', effort: 'low' } },
    T2: { claude: { model: 'claude-sonnet-5', effort: 'medium' }, codex: { model: 'gpt-6-luna', effort: 'medium' } },
    T3: { claude: { model: 'claude-sonnet-5', effort: 'high' }, codex: { model: 'gpt-6-sol', effort: 'high' } },
    T4: { claude: { model: 'claude-opus-5-5', effort: 'high' }, codex: { model: 'gpt-6-astra', effort: 'high' } },
    T5: { claude: { model: 'claude-fable-5-1', effort: 'xhigh' }, codex: null },
    V: { claude: { model: 'claude-sonnet-5', effort: 'high' }, codex: { model: 'gpt-6-sol', effort: 'high' } },
  },
};

function mkIntel({ tiers = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-model-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(tmp, 'kinds.json'));
  if (tiers) fs.writeFileSync(path.join(tmp, 'model-tiers.json'), JSON.stringify(TIERS_FIXTURE));
  return tmp;
}

function run(intel, args) {
  try {
    const stdout = execFileSync(process.execPath, [LEDGER, ...args], {
      encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const BASE = ['create', '--title', 'tarjeta', '--goal', 'algo', '--repo', 'wezbridge', '--blocked-by', 'agent',
  '--criterion', 'medible'];
const card = (intel, id) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8'));

test('create --tier T2 guarda runtime=claude, model=claude-sonnet-5, effort=medium, tier=T2', () => {
  const intel = mkIntel();
  try {
    const r = run(intel, [...BASE, '--tier', 'T2']);
    assert.equal(r.ok, true, r.stderr);
    const c = card(intel, 'T-0001');
    assert.deepEqual({ runtime: c.runtime, model: c.model, effort: c.effort, tier: c.tier },
      { runtime: 'claude', model: 'claude-sonnet-5', effort: 'medium', tier: 'T2' });
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});

test('create --runtime codex --tier T1 expande al mapping codex; --model gpt-6-luna --effort low valida', () => {
  const intel = mkIntel();
  try {
    let r = run(intel, [...BASE, '--runtime', 'codex', '--tier', 'T1']);
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual([card(intel, 'T-0001').model, card(intel, 'T-0001').effort], ['gpt-6-luna', 'low']);
    r = run(intel, [...BASE, '--model', 'gpt-6-luna', '--effort', 'low']);
    assert.equal(r.ok, true, r.stderr);
    assert.equal(card(intel, 'T-0002').runtime, 'codex', 'runtime se deriva del modelo');
    r = run(intel, [...BASE, '--model', 'opus']);
    assert.equal(r.ok, true, r.stderr);
    assert.deepEqual([card(intel, 'T-0003').model, card(intel, 'T-0003').effort], ['claude-opus-5-5', 'medium'],
      'el alias mapea al id y sin --effort toma el default_effort del modelo');
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});

test('--model gpt-6-terra falla con mensaje claro y NO crea tarjeta', () => {
  const intel = mkIntel();
  try {
    const r = run(intel, [...BASE, '--model', 'gpt-6-terra']);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /unknown model "gpt-6-terra"/);
    assert.match(r.stderr, /gpt-6-luna/, 'el mensaje lista los modelos validos');
    assert.deepEqual(fs.readdirSync(path.join(intel, 'tasks')), []);
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});

test('--effort ultra sobre claude-sonnet-5 falla (ultra es de Codex); effort sobre haiku falla', () => {
  const intel = mkIntel();
  try {
    let r = run(intel, [...BASE, '--model', 'claude-sonnet-5', '--effort', 'ultra']);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /effort "ultra" is not valid for claude-sonnet-5/);
    r = run(intel, [...BASE, '--model', 'haiku', '--effort', 'low']);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /takes no effort/);
    r = run(intel, [...BASE, '--model', 'gpt-6-sol', '--runtime', 'claude']);
    assert.equal(r.ok, false, 'runtime que contradice al modelo se rechaza');
    r = run(intel, [...BASE, '--tier', 'T5', '--runtime', 'codex']);
    assert.equal(r.ok, false, 'T5 no tiene mapping codex');
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});

test('sin model-tiers.json el flag falla con el path que falta (no adivina)', () => {
  const intel = mkIntel({ tiers: false });
  try {
    const r = run(intel, [...BASE, '--tier', 'T2']);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /model-tiers\.json and it is not there/);
    const plain = run(intel, BASE);
    assert.equal(plain.ok, true, `una tarjeta sin modelo no depende del archivo: ${plain.stderr}`);
    assert.equal('model' in card(intel, 'T-0001'), false, 'sin flags de modelo la tarjeta conserva su forma');
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});

test('update --effort revalida contra el modelo de la tarjeta; --evidence-append suma sin pisar', () => {
  const intel = mkIntel();
  try {
    assert.equal(run(intel, [...BASE, '--tier', 'T3']).ok, true);
    let r = run(intel, ['update', 'T-0001', '--effort', 'ultra']);
    assert.equal(r.ok, false, 'ultra no existe en sonnet');
    r = run(intel, ['update', 'T-0001', '--effort', 'xhigh']);
    assert.equal(r.ok, true, r.stderr);
    assert.equal(card(intel, 'T-0001').effort, 'xhigh');
    assert.equal(run(intel, ['update', 'T-0001', '--evidence', 'suite 10/0']).ok, true);
    r = run(intel, ['update', 'T-0001', '--evidence-append', 'model_effort_used: claude-sonnet-5/high']);
    assert.equal(r.ok, true, r.stderr);
    assert.equal(card(intel, 'T-0001').evaluator_evidence, 'suite 10/0\nmodel_effort_used: claude-sonnet-5/high');
    assert.equal(run(intel, ['update', 'T-0001', '--evidence-append', '']).ok, false, 'append vacio se rechaza');
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});

test('dashboard muestra runtime y model=<m>/<e> en las tarjetas running; list --state running los trae', () => {
  const intel = mkIntel();
  try {
    assert.equal(run(intel, [...BASE, '--state', 'ready', '--runtime', 'codex', '--tier', 'T2']).ok, true);
    assert.equal(run(intel, [...BASE, '--state', 'ready', '--tier', 'T4']).ok, true);
    assert.equal(run(intel, ['update', 'T-0001', '--state', 'running']).ok, true);
    assert.equal(run(intel, ['dashboard']).ok, true);
    const md = fs.readFileSync(path.join(intel, 'dashboard.md'), 'utf8');
    const line1 = md.split('\n').find((l) => l.includes('**T-0001**'));
    assert.match(line1, / · runtime=codex · model=gpt-6-luna\/medium/);
    const line2 = md.split('\n').find((l) => l.includes('**T-0002**'));
    assert.doesNotMatch(line2, /model=/, 'solo las running llevan el modelo');
    const listed = JSON.parse(run(intel, ['list', '--state', 'running']).stdout);
    assert.deepEqual(listed.map((t) => [t.id, t.runtime, t.model, t.effort]), [['T-0001', 'codex', 'gpt-6-luna', 'medium']]);
  } finally { fs.rmSync(intel, { recursive: true, force: true }); }
});
