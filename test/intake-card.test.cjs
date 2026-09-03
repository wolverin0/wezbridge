'use strict';
/**
 * T-0338 — intake-card: una idea de Super Productivity (_intel/intake/<taskId>.json)
 * se vuelve UNA tarjeta del ledger con origin sp:<taskId>, y el T-id vuelve al json.
 *  AC1 un json produce exactamente una tarjeta; re-procesarlo no crea otra (origin_key).
 *  AC2 la tarjeta nace con goal, repo y >= 2 criterios: el helper falla cerrado si faltan.
 *  (AC3 es medicion viva.)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ic = require('../scripts/intake-card.cjs');

const LEDGER = path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const haveLedger = fs.existsSync(LEDGER);

function intel() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
  fs.mkdirSync(path.join(d, 'tasks'));
  fs.mkdirSync(path.join(d, 'intake'));
  fs.writeFileSync(path.join(d, 'kinds.json'), JSON.stringify({ kinds: { general: { class: 'work', fallback_mode: 'scoped_write', fallback_gate: null } }, rules: {} }));
  fs.writeFileSync(path.join(d, 'intake', 'QpQn10oaQRLa2FeOIJAR5.json'), JSON.stringify({ taskId: 'QpQn10oaQRLa2FeOIJAR5', title: 'probar Tailscale para el tablero del fleet', notes: '', exportedAt: '2026-09-03T18:30:00Z', t_id: null }));
  return d;
}

test('AC2 fail-closed: sin goal, sin repo o con < 2 criterios no se arma el create', () => {
  const base = { taskId: 'QpQn10oaQRLa2FeOIJAR5', title: 't', goal: 'g', repo: 'wezbridge', kind: 'general', criteria: ['a', 'b'] };
  assert.doesNotThrow(() => ic.buildCreateArgs(base));
  assert.throws(() => ic.buildCreateArgs({ ...base, goal: ' ' }), /--goal/);
  assert.throws(() => ic.buildCreateArgs({ ...base, repo: '' }), /--repo/);
  assert.throws(() => ic.buildCreateArgs({ ...base, criteria: ['solo uno'] }), />= 2 criterios/);
  const args = ic.buildCreateArgs(base);
  assert.ok(args.includes('--origin') && args.includes('sp:QpQn10oaQRLa2FeOIJAR5'), 'origin sp:<taskId>');
  assert.ok(args.includes('--corr') && args.includes('sp:QpQn10oaQRLa2FeOIJAR5'));
  assert.equal(args.filter((a) => a === '--criterion').length, 2, 'un --criterion por criterio, verbatim (T-0252)');
});

test('AC1 idempotencia: crear dos veces desde el mismo json = UNA tarjeta con origin sp:<taskId>, y el json recibe t_id', { skip: !haveLedger && '_docs-curation/ledger.cjs no esta al lado' }, () => {
  const d = intel();
  const opts = { taskId: 'QpQn10oaQRLa2FeOIJAR5', goal: 'Exponer el tablero :4272 por Tailscale Serve y medir que abre desde el telefono', repo: 'wezbridge', kind: 'general', criteria: ['el tablero abre desde el telefono por Tailscale (captura)', 'sin puerto publico: solo la ACL de Tailscale'] };
  const a = ic.createCard(opts, { intel: d, ledger: LEDGER });
  const b = ic.createCard(opts, { intel: d, ledger: LEDGER });
  assert.equal(a.card.id, b.card.id, 'la segunda corrida devuelve la MISMA tarjeta');
  const cards = fs.readdirSync(path.join(d, 'tasks')).filter((f) => /^T-\d{4}\.json$/.test(f));
  assert.equal(cards.length, 1, 'una sola tarjeta');
  const card = JSON.parse(fs.readFileSync(path.join(d, 'tasks', cards[0]), 'utf8'));
  assert.equal(card.origin_key, 'sp:QpQn10oaQRLa2FeOIJAR5');
  assert.equal(card.corr, 'sp:QpQn10oaQRLa2FeOIJAR5');
  assert.equal(card.acceptance_criteria.length, 2);
  assert.deepEqual(card.context_refs, ['_intel/intake/QpQn10oaQRLa2FeOIJAR5.json']);
  const rec = JSON.parse(fs.readFileSync(path.join(d, 'intake', 'QpQn10oaQRLa2FeOIJAR5.json'), 'utf8'));
  assert.equal(rec.t_id, card.id, 'el T-id vuelve al json para que sp-bridge lo escriba en la nota de SP');
  assert.ok(rec.cardedAt);
  assert.deepEqual(ic.listPending(d), [], 'ya no esta pendiente');
  assert.equal(b.reused, true);
});
