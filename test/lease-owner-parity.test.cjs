'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { companionsRoot } = require('./helpers/companions.cjs');
const reader = require('../scripts/lease-reconcile.cjs');
const ledgerPath = process.env.WEZBRIDGE_LEASE_LEDGER_PATH || path.join(companionsRoot(), '_docs-curation', 'ledger.cjs');
if (!fs.existsSync(ledgerPath)) {
  test('T0417 AC3 real ledger parity requires companion', { skip: 'Set WEZBRIDGE_COMPANIONS_DIR to the real Fleet root' }, () => {});
  return;
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-parity-'));
const projects = { wezbridge: { path: 'wezbridge' }, CRM: { path: 'crm' }, 'project with spaces': { path: 'demo' } };
fs.writeFileSync(path.join(fixture, 'repos.json'), JSON.stringify({ repos: projects }));
process.env.WEZBRIDGE_INTEL_DIR = fixture;
const writer = require(ledgerPath);
const hash = fn => crypto.createHash('sha256').update(fn.toString().replace(/\s+/g, ' ')).digest('hex');

function assertContract(w, r) {
  assert.deepEqual(r.LEASE_OWNER_FORMS.map(String), w.LEASE_OWNER_FORMS.map(String));
  // Deliberate review tripwires: a fourth acceptance branch outside the regex
  // table must also force a parity review, not silently evade the corpus.
  assert.equal(hash(w.assertLeaseOwner), 'e84f93214a6d559970b52f96ee97a6a9163c6e415213e45b20e910e3530c3140');
  assert.equal(hash(r.parseOwner), 'ad352876fd156c24b152bcb4eeea923302eaf369eae3f9ac72b0c3f6d4e78db9');
  const samples = [null, 7, '', 'wezbridge', 'CRM', 'crm', 'project with spaces', 'unknown',
    'pane-0', 'pane-94', 'Pane-94', 'pane-94 garbage', 'eve:JOB-1', 'codex:run_1',
    'worker:a.b_c-1', 'EVE:job', 'eve:', 'eve:a b', 'pool/job', 'agent@id', 'thread#id'];
  for (let n = 0; n <= 81; n++) samples.push(`worker:${'a'.repeat(n)}`);
  for (let n = 0; n < 128; n++) samples.push(`x:${String.fromCharCode(n)}`);
  for (const owner of samples) {
    let accepted = true;
    try { w.assertLeaseOwner(owner); } catch { accepted = false; }
    assert.equal(r.parseOwner(owner, projects) !== null, accepted, JSON.stringify(owner));
  }
}

test('T0417 AC3 real assertLeaseOwner and reader accept identical canonical forms', t => {
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  assertContract(writer, reader);
  assert.deepEqual(reader.parseOwner('pane-94 (wezbridge)', projects), { paneId: 94 });
  assert.throws(() => writer.assertLeaseOwner('pane-94 (wezbridge)'), /lease requires/);
});

test('T0417 AC3 inverse: fourth form in writer or reader trips parity guard', () => {
  assert.throws(() => assertContract({ ...writer, LEASE_OWNER_FORMS: [...writer.LEASE_OWNER_FORMS, /^pool\/.+$/] }, reader));
  const widened = owner => owner === 'pool/job' ? { pool: 'job' } : reader.parseOwner(owner, projects);
  assert.throws(() => assertContract(writer, { ...reader, parseOwner: widened }));
});
