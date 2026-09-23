'use strict';
/**
 * model-tiers.test.cjs — validator unit tests for _intel/model-tiers.json
 * (T-0545). Covers: the real file loads and validates clean; an unknown
 * model reference fails; an effort not accepted by its model fails; and any
 * mention of the retired/nonexistent "gpt-6-terra" model fails, anywhere in
 * the document. See scripts/validate-model-tiers.cjs for the checks.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  loadModelTiers,
  validateModelTiers,
  ModelTiersError,
  DEFAULT_PATH,
} = require('../scripts/validate-model-tiers.cjs');

function baseDoc() {
  return {
    version: 1,
    updated: '2026-09-23',
    models: {
      'claude-sonnet-5': { vendor: 'anthropic', runtime: 'claude', efforts: ['low', 'medium', 'high'], default_effort: 'high' },
      'claude-haiku-4-5-20251001': { vendor: 'anthropic', runtime: 'claude', efforts: [], default_effort: null },
    },
    tiers: {
      T1: { use: 'sweeps', claude: { model: 'claude-haiku-4-5-20251001', effort: null }, codex: null },
      T2: { use: 'edits', claude: { model: 'claude-sonnet-5', effort: 'medium' }, codex: null },
    },
    classes: { a: 'T1', b: 'T2' },
    degrade_on_rate_limit: { T2: 'T1', T1: 'T1' },
  };
}

test('the real _intel/model-tiers.json file passes validation', () => {
  const data = loadModelTiers(DEFAULT_PATH);
  assert.strictEqual(validateModelTiers(data), true);
});

test('a tier referencing an unknown model fails', () => {
  const doc = baseDoc();
  doc.tiers.T2.claude.model = 'claude-nonexistent-9';
  assert.throws(() => validateModelTiers(doc), (err) => {
    assert.ok(err instanceof ModelTiersError);
    assert.match(err.message, /unknown model "claude-nonexistent-9"/);
    return true;
  });
});

test('an effort not accepted by the referenced model fails', () => {
  const doc = baseDoc();
  doc.tiers.T1.claude.effort = 'xhigh'; // haiku has an empty efforts list
  assert.throws(() => validateModelTiers(doc), (err) => {
    assert.ok(err instanceof ModelTiersError);
    assert.match(err.message, /effort "xhigh" is not accepted by model "claude-haiku-4-5-20251001" \(accepted: \[\]\)/);
    return true;
  });
});

test('"gpt-6-terra" anywhere in the document fails, even outside models', () => {
  const doc = baseDoc();
  doc.tiers.T2.use = 'fallback to gpt-6-terra if rate limited';
  assert.throws(() => validateModelTiers(doc), (err) => {
    assert.ok(err instanceof ModelTiersError);
    assert.match(err.message, /gpt-6-terra/);
    return true;
  });
});
