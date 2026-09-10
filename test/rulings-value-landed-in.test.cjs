'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRulingLine, appendRuling } = require('../src/rulings.cjs');
const { lintRulings } = require('../scripts/dispatch-lint.cjs');
const NOW = Date.parse('2026-09-10T10:00:00Z');
const BASE = Object.freeze({ task: 'T-0435', category: 'ruling-unlanded', ruling: 'resolved',
  why: 'threshold set to 30 minutes', at: new Date(NOW).toISOString(), source: 'orchestrator-pane' });

test('T-0435 AC1: value_landed_in accepts and preserves a nonempty string', () => {
  const verdict = validateRulingLine({ ...BASE, value_landed_in: 'x.cjs' }, NOW);
  assert.equal(verdict.ok, true, verdict.error);
  assert.equal(verdict.line.value_landed_in, 'x.cjs');
});

test('T-0435 AC1: value_landed_in rejects empty, whitespace and non-string values', () => {
  for (const value of ['', '   ', 42, null, false, [], {}]) {
    const verdict = validateRulingLine({ ...BASE, value_landed_in: value }, NOW);
    assert.equal(verdict.ok, false, JSON.stringify(value));
    assert.match(verdict.error, /value_landed_in/);
  }
});

test('T-0435: value_landed_in remains optional and unknown fields remain rejected', () => {
  const verdict = validateRulingLine(BASE, NOW);
  assert.equal(verdict.ok, true);
  assert.equal(Object.hasOwn(verdict.line, 'value_landed_in'), false);
  assert.equal(validateRulingLine({ ...BASE, value_landed: 'x.cjs' }, NOW).ok, false);
});

test('T-0435 AC2: operational ruling has zero findings with landing, one without', () => {
  assert.deepEqual(lintRulings([{ ...BASE, value_landed_in: 'foo.json' }], NOW), []);
  const findings = lintRulings([BASE], NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'ruling-unlanded');
});

test('T-0435: append roundtrip preserves landing for lint and invalid append writes nothing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0435-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = { ...BASE, value_landed_in: 'foo.json' };
  const written = appendRuling(dir, input, { now: NOW });
  const file = path.join(dir, 'rulings.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(before), written);
  assert.equal(written.value_landed_in, input.value_landed_in);
  assert.deepEqual(lintRulings([JSON.parse(before)], NOW), []);
  for (const value of ['', 42]) assert.throws(() => appendRuling(dir, { ...BASE, value_landed_in: value }, { now: NOW }), /value_landed_in/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(input, { ...BASE, value_landed_in: 'foo.json' });
});
