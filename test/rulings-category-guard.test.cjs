'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../src/rulings.cjs');
const S = require('../scripts/fleet-steward.cjs');
const now = Date.parse('2026-09-12T22:00:00Z');
const line = category => ({task: 'T-0458', category, ruling: 'deferred', why: 'bounded check',
  until: '2026-09-13T22:00:00Z', source: 'drill'});

test('unknown category is refused before append; every emitted category and null write', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0458-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const category of ['review-harvest', 'review', 'invented', '', 1, false]) {
    assert.throws(() => R.appendRuling(dir, line(category), {now}), error => {
      assert.match(error.message, /category/);
      for (const valid of Object.values(R.FINDING_CATEGORY)) assert.ok(error.message.includes(valid));
      return true;
    });
    assert.equal(fs.existsSync(path.join(dir, 'rulings.jsonl')), false);
  }
  for (const category of [null, ...Object.values(R.FINDING_CATEGORY)]) {
    assert.equal(R.appendRuling(dir, line(category), {now}).category, category);
  }
});

test('historical invalid categories remain readable and keep file-order semantics', () => {
  const rows = [line('review-harvest'), line(null), line('stale-review')];
  assert.deepEqual(R.rulingsFor(rows, 'T-0458'), rows);
  assert.equal(R.latestRuling(rows, 'T-0458'), rows[2]);
});

test('steward consumes enum and every direct/aggregated literal is in vocabulary', () => {
  const allowed = new Set(Object.values(R.FINDING_CATEGORY));
  for (const file of ['fleet-steward', 'routine-audit', 'cross-repo-audit', 'dispatch-lint', 'lease-reconcile']) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts', file + '.cjs'), 'utf8');
    const literals = [...source.matchAll(/\bcategory:\s*['"]([^'"]+)['"]/g)];
    for (const [, category] of literals) assert.ok(allowed.has(category), `${file}: unknown ${category}`);
    if (file === 'fleet-steward') assert.equal(literals.length, 0, 'steward must emit enum references');
  }
});

test('runtime classification emits an allowed category, not an invented word', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0458-runtime-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const state of ['ready', 'queued', 'blocked', 'review', 'failed', 'running']) {
    const finding = S.classify({id: 'T-9991', repo: 'x', state,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'}, now, dir);
    if (finding) assert.ok(Object.values(R.FINDING_CATEGORY).includes(finding.category), finding.category);
  }
});
