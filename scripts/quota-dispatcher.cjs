#!/usr/bin/env node
'use strict';

/**
 * quota-dispatcher.cjs — Quota-aware Mastermind Dispatcher.
 * 
 * Integrates live rate limit telemetries from Orca (`orca account list --json`)
 * with Jev System One complexity classification to dynamically route tasks between:
 * - Codex Astra 6 (Deep Math, RF Governors, Formal Systems)
 * - Claude Fable 5.1 / Opus (Clean Architecture, Workflows, APIs)
 * - Codex Sol / Claude Sonnet / Haiku (Execution Workers & Fast Triage)
 * 
 * Part of Autonomous Multi-Agent Infrastructure (ROADMAP Phase 2).
 */

const { execSync } = require('child_process');

/**
 * Parses Orca account rate limits
 */
function parseOrcaAccountQuotas(rawOrcaData) {
  if (!rawOrcaData || !rawOrcaData.result || !rawOrcaData.result.rateLimits) {
    return {
      claude: { sessionUsed: 0, weeklyUsed: 0, fableUsed: 0, resetDescription: 'unknown' },
      codex: { weeklyUsed: 0, creditsAvailable: 0, resetDescription: 'unknown' },
      isFallback: true
    };
  }

  const limits = rawOrcaData.result.rateLimits;
  const claude = limits.claude || {};
  const codex = limits.codex || {};

  return {
    claude: {
      sessionUsed: claude.session?.usedPercent ?? 0,
      weeklyUsed: claude.weekly?.usedPercent ?? 0,
      fableUsed: claude.fableWeekly?.usedPercent ?? (claude.weekly?.usedPercent ?? 0),
      resetDescription: claude.weekly?.resetDescription ?? 'unknown'
    },
    codex: {
      weeklyUsed: codex.weekly?.usedPercent ?? 0,
      creditsAvailable: codex.rateLimitResetCredits?.availableCount ?? 0,
      resetDescription: codex.weekly?.resetDescription ?? 'unknown'
    },
    isFallback: false
  };
}

/**
 * Fetches live quotas from Orca CLI with fallback
 */
function fetchLiveQuotas(timeoutMs = 4000) {
  try {
    const stdout = execSync('orca account list --json', {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const parsed = JSON.parse(stdout);
    return parseOrcaAccountQuotas(parsed);
  } catch (err) {
    // Return safe fallback values if Orca CLI is momentarily busy
    return parseOrcaAccountQuotas(null);
  }
}

/**
 * Core dispatching decision algorithm
 */
function dispatchModelDecision({ taskCategory, complexity, forceModel, quotas }) {
  const q = quotas || parseOrcaAccountQuotas(null);

  if (forceModel) {
    return {
      recommendedModel: forceModel,
      reason: `Explicit model override requested: ${forceModel}`,
      quotas: q
    };
  }

  // Fast / simple lookups
  if (complexity === 'fast' || taskCategory === 'triage_lookup') {
    return {
      recommendedModel: 'fast:haiku-or-sol',
      reason: 'Low latency triage / lookup task routed to fast lightweight tier',
      quotas: q
    };
  }

  // Mathematical / RF / Low-level networking proofs
  if (taskCategory === 'math_rf') {
    if (q.codex.weeklyUsed < 85) {
      return {
        recommendedModel: 'codex:astra-6',
        reason: `Codex Astra 6 selected for high-depth RF/mathematical formalisms (Codex weekly quota at ${q.codex.weeklyUsed}%)`,
        quotas: q
      };
    } else {
      return {
        recommendedModel: 'claude:opus',
        reason: `Codex weekly quota exhausted (${q.codex.weeklyUsed}% >= 85%). Fallback to Claude Opus for mathematical reasoning`,
        quotas: q
      };
    }
  }

  // Architecture / System Workflows / Protocols
  if (taskCategory === 'architecture_workflow') {
    if (q.claude.fableUsed < 85) {
      return {
        recommendedModel: 'claude:fable-5.1',
        reason: `Claude Fable 5.1 selected for architectural design and dynamic workflows (Fable weekly quota at ${q.claude.fableUsed}%)`,
        quotas: q
      };
    } else {
      return {
        recommendedModel: 'codex:astra-6',
        reason: `Claude Fable weekly quota exhausted (${q.claude.fableUsed}% >= 85%). Fallback to Codex Astra 6`,
        quotas: q
      };
    }
  }

  // General planning / High-level reasoning: Auto-balance based on weekly headroom
  if (q.claude.fableUsed <= q.codex.weeklyUsed) {
    return {
      recommendedModel: 'claude:fable-5.1',
      reason: `Claude Fable 5.1 selected: lower weekly utilization (${q.claude.fableUsed}% vs Codex ${q.codex.weeklyUsed}%) with high architectural alignment`,
      quotas: q
    };
  } else {
    return {
      recommendedModel: 'codex:astra-6',
      reason: `Codex Astra 6 selected: lower weekly utilization (${q.codex.weeklyUsed}% vs Claude Fable ${q.claude.fableUsed}%) with deep planning capability`,
      quotas: q
    };
  }
}

/**
 * Classifies task text via keyword heuristics or Jev System One
 */
function classifyTaskIntent(promptText) {
  const text = String(promptText || '').toLowerCase();

  // Math, RF, RouterOS, Mangle, Physics, Queues
  if (/mikrotik|mangle|pfifo|buffer|rf|snr|frecuencia|tower|airmax|ptp|cpe|latency|evm|formula|proof/.test(text)) {
    return {
      taskCategory: 'math_rf',
      complexity: 'deep_reasoning'
    };
  }

  // Architecture, API, Workflow, Schema, System design
  if (/arquitectura|roadmap|workflow|protocol|api|schema|design|refactor|coo|mastermind|coordinar/.test(text)) {
    return {
      taskCategory: 'architecture_workflow',
      complexity: 'deep_reasoning'
    };
  }

  // Quick command, lookup, ping, check status
  if (/status|ping|uptime|check|test-path|version|ls|dir/.test(text)) {
    return {
      taskCategory: 'triage_lookup',
      complexity: 'fast'
    };
  }

  return {
    taskCategory: 'general_planning',
    complexity: 'deep_reasoning'
  };
}

/**
 * End-to-end evaluation
 */
function evaluateTaskRoute(promptText, options = {}) {
  const quotas = options.quotas || fetchLiveQuotas();
  const classification = classifyTaskIntent(promptText);
  return dispatchModelDecision({
    taskCategory: classification.taskCategory,
    complexity: classification.complexity,
    quotas
  });
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const prompt = args.join(' ') || 'Plan general architecture and model distribution';
  
  console.log('Querying live quotas and dispatching...');
  const quotas = fetchLiveQuotas();
  console.log(`Live Quotas: Claude Fable: ${quotas.claude.fableUsed}%, Claude Weekly: ${quotas.claude.weeklyUsed}%, Codex Weekly: ${quotas.codex.weeklyUsed}%`);
  
  const decision = evaluateTaskRoute(prompt, { quotas });
  console.log('\n--- Dispatcher Verdict ---');
  console.log(`Prompt: "${prompt}"`);
  console.log(`Recommended Model: ${decision.recommendedModel}`);
  console.log(`Reason: ${decision.reason}`);
}

module.exports = {
  parseOrcaAccountQuotas,
  fetchLiveQuotas,
  dispatchModelDecision,
  classifyTaskIntent,
  evaluateTaskRoute
};
