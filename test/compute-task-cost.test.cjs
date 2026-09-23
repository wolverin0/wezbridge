'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  parseSessionCost,
  computeBatchTaskCosts,
  resolvePricing,
  PRICING_TABLE
} = require('../scripts/compute-task-cost.cjs');

test('T-0501: resolvePricing matches models to correct pricing tiers', () => {
  const sonnetPricing = resolvePricing('claude-sonnet-4-5');
  assert.equal(sonnetPricing.input, 3.00);
  assert.equal(sonnetPricing.output, 15.00);

  const opusPricing = resolvePricing('claude-opus-5');
  assert.equal(opusPricing.input, 15.00);
  assert.equal(opusPricing.output, 75.00);

  const haikuPricing = resolvePricing('claude-haiku-4-5');
  assert.equal(haikuPricing.input, 0.80);
  assert.equal(haikuPricing.output, 4.00);
});

test('T-0501: parseSessionCost calculates tokens, costs and cache savings accurately', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-test-'));
  const testFile = path.join(tmpDir, 'test-session.jsonl');

  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', name: 'read_file' }],
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50000,
          cache_read_input_tokens: 20000,
          output_tokens: 500
        }
      }
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', name: 'write_to_file' }],
        usage: {
          input_tokens: 50,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 70000,
          output_tokens: 800
        }
      }
    })
  ];

  fs.writeFileSync(testFile, lines.join('\n'), 'utf8');

  try {
    const summary = await parseSessionCost(testFile);

    assert.equal(summary.turns, 2);
    assert.equal(summary.toolCalls, 2);
    assert.equal(summary.tokens.firstTurnInput, 70100);
    assert.equal(summary.tokens.totalInput, 141150);
    assert.equal(summary.tokens.output, 1300);
    assert.ok(summary.cost.totalUsd > 0);
    assert.ok(summary.cost.savingsPct > 0);
    assert.equal(summary.topTools.length, 2);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
