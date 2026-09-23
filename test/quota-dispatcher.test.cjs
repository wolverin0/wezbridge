'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOrcaAccountQuotas,
  dispatchModelDecision,
  evaluateTaskRoute
} = require('../scripts/quota-dispatcher.cjs');

test('T-QUOTA: parseOrcaAccountQuotas extracts Claude and Codex usage cleanly', () => {
  const sampleOrcaOutput = {
    result: {
      rateLimits: {
        claude: {
          session: { usedPercent: 3, resetDescription: '7:00 PM' },
          weekly: { usedPercent: 14, resetDescription: 'Sat 1:00 PM' },
          fableWeekly: { usedPercent: 10, resetDescription: 'Sat 1:00 PM' },
          status: 'ok'
        },
        codex: {
          weekly: { usedPercent: 49, resetDescription: 'Sat 12:25 PM' },
          rateLimitResetCredits: { availableCount: 1 },
          status: 'ok'
        }
      }
    }
  };

  const quotas = parseOrcaAccountQuotas(sampleOrcaOutput);
  assert.equal(quotas.claude.sessionUsed, 3);
  assert.equal(quotas.claude.weeklyUsed, 14);
  assert.equal(quotas.claude.fableUsed, 10);
  assert.equal(quotas.codex.weeklyUsed, 49);
  assert.equal(quotas.codex.creditsAvailable, 1);
});

test('T-QUOTA: parseOrcaAccountQuotas handles missing or malformed payload gracefully', () => {
  const quotas = parseOrcaAccountQuotas(null);
  assert.equal(quotas.claude.weeklyUsed, 0);
  assert.equal(quotas.codex.weeklyUsed, 0);
  assert.equal(quotas.isFallback, true);
});

test('T-QUOTA: dispatchModelDecision routes RF/math tasks to Codex Astra 6 when under 85% quota', () => {
  const quotas = {
    claude: { sessionUsed: 5, weeklyUsed: 20, fableUsed: 15 },
    codex: { weeklyUsed: 50, creditsAvailable: 1 }
  };

  const decision = dispatchModelDecision({
    taskCategory: 'math_rf',
    complexity: 'deep_reasoning',
    quotas
  });

  assert.equal(decision.recommendedModel, 'codex:astra-6');
  assert.match(decision.reason, /RF|math/i);
});

test('T-QUOTA: dispatchModelDecision falls back from Astra to Claude Opus when Codex is exhausted (>85%)', () => {
  const quotas = {
    claude: { sessionUsed: 5, weeklyUsed: 20, fableUsed: 15 },
    codex: { weeklyUsed: 92, creditsAvailable: 0 }
  };

  const decision = dispatchModelDecision({
    taskCategory: 'math_rf',
    complexity: 'deep_reasoning',
    quotas
  });

  assert.equal(decision.recommendedModel, 'claude:opus');
  assert.match(decision.reason, /exhausted|fallback/i);
});

test('T-QUOTA: dispatchModelDecision auto-balances general planning based on lowest weekly usage', () => {
  // Case 1: Claude has much lower usage (10% Fable vs 49% Codex) -> picks Claude Fable 5.1
  const decision1 = dispatchModelDecision({
    taskCategory: 'general_planning',
    complexity: 'deep_reasoning',
    quotas: {
      claude: { sessionUsed: 3, weeklyUsed: 14, fableUsed: 10 },
      codex: { weeklyUsed: 49, creditsAvailable: 1 }
    }
  });
  assert.equal(decision1.recommendedModel, 'claude:fable-5.1');

  // Case 2: Codex has lower usage (20% vs Claude 75%) -> picks Codex Astra 6
  const decision2 = dispatchModelDecision({
    taskCategory: 'general_planning',
    complexity: 'deep_reasoning',
    quotas: {
      claude: { sessionUsed: 50, weeklyUsed: 75, fableUsed: 70 },
      codex: { weeklyUsed: 20, creditsAvailable: 1 }
    }
  });
  assert.equal(decision2.recommendedModel, 'codex:astra-6');
});

test('T-QUOTA: dispatchModelDecision routes fast/triage tasks to lightweight tier', () => {
  const decision = dispatchModelDecision({
    taskCategory: 'triage_lookup',
    complexity: 'fast',
    quotas: {
      claude: { sessionUsed: 10, weeklyUsed: 20, fableUsed: 10 },
      codex: { weeklyUsed: 30, creditsAvailable: 1 }
    }
  });
  assert.equal(decision.recommendedModel, 'fast:haiku-or-sol');
});
