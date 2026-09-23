#!/usr/bin/env node
'use strict';
/**
 * scripts/compute-task-cost.cjs
 *
 * Computes the financial cost (US$/task) of solved tasks by parsing
 * input/output tokens, prompt cache hits, and tool invocations from
 * session JSONL files (Claude Code / Codex / Antigravity).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// Model pricing per 1M tokens (USD)
const PRICING_TABLE = {
  // Claude Sonnet (3.5 / 4 / 5)
  'claude-sonnet': {
    input: 3.00,
    cache_write: 3.75,
    cache_read: 0.30,
    output: 15.00
  },
  // Claude Opus (3 / 4 / 4.8 / 5)
  'claude-opus': {
    input: 15.00,
    cache_write: 18.75,
    cache_read: 1.50,
    output: 75.00
  },
  // Claude Haiku (3.5 / 4.5)
  'claude-haiku': {
    input: 0.80,
    cache_write: 1.00,
    cache_read: 0.08,
    output: 4.00
  },
  // Default / Fable fallback (treated as Sonnet tier)
  'default': {
    input: 3.00,
    cache_write: 3.75,
    cache_read: 0.30,
    output: 15.00
  }
};

function resolvePricing(modelName) {
  if (!modelName) return PRICING_TABLE.default;
  const m = String(modelName).toLowerCase();
  if (m.includes('opus')) return PRICING_TABLE['claude-opus'];
  if (m.includes('haiku')) return PRICING_TABLE['claude-haiku'];
  if (m.includes('sonnet') || m.includes('fable') || m.includes('codex')) return PRICING_TABLE['claude-sonnet'];
  return PRICING_TABLE.default;
}

/**
 * Parse single session JSONL file and compute exact token and cost rollups
 */
async function parseSessionCost(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let turns = 0;
  let toolCalls = 0;
  let uncachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

  let totalCostUsd = 0;
  let fullCostWithoutCacheUsd = 0;
  const modelsUsed = new Set();
  const toolsUsed = {};

  let firstTurnTokens = null;

  for await (const line of rl) {
    if (!line || !line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      // Extract tool calls
      if (entry.type === 'assistant' && entry.message) {
        turns++;
        const msg = entry.message;
        const model = msg.model || 'claude-sonnet-4-5';
        modelsUsed.add(model);
        const pricing = resolvePricing(model);

        // Count tool uses in content
        if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'tool_use' || item.type === 'tool_call') {
              toolCalls++;
              const tName = item.name || 'unknown_tool';
              toolsUsed[tName] = (toolsUsed[tName] || 0) + 1;
            }
          }
        }

        const usage = msg.usage || {};
        const inTokens = Number(usage.input_tokens) || 0;
        const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
        const cacheRead = Number(usage.cache_read_input_tokens) || 0;
        const outTokens = Number(usage.output_tokens) || 0;

        if (firstTurnTokens === null) {
          firstTurnTokens = inTokens + cacheWrite + cacheRead;
        }

        uncachedInputTokens += inTokens;
        cacheCreationTokens += cacheWrite;
        cacheReadTokens += cacheRead;
        outputTokens += outTokens;

        // Turn cost
        const turnCost = (
          (inTokens * pricing.input) +
          (cacheWrite * pricing.cache_write) +
          (cacheRead * pricing.cache_read) +
          (outTokens * pricing.output)
        ) / 1_000_000;

        // Hypothetical cost if caching didn't exist (all prompt tokens at full price)
        const unmemoizedCost = (
          ((inTokens + cacheWrite + cacheRead) * pricing.input) +
          (outTokens * pricing.output)
        ) / 1_000_000;

        totalCostUsd += turnCost;
        fullCostWithoutCacheUsd += unmemoizedCost;
      }

      // Check Antigravity format
      if (entry.type === 'PLANNER_RESPONSE') {
        turns++;
        if (Array.isArray(entry.tool_calls)) {
          toolCalls += entry.tool_calls.length;
          for (const tc of entry.tool_calls) {
            const name = tc.name || 'unknown';
            toolsUsed[name] = (toolsUsed[name] || 0) + 1;
          }
        }
      }
    } catch (_) {}
  }

  const totalInputTokens = uncachedInputTokens + cacheCreationTokens + cacheReadTokens;
  const cacheSavingsUsd = fullCostWithoutCacheUsd - totalCostUsd;
  const cacheSavingsPct = fullCostWithoutCacheUsd > 0
    ? ((cacheSavingsUsd / fullCostWithoutCacheUsd) * 100)
    : 0;

  return {
    filePath,
    fileName: path.basename(filePath),
    turns,
    toolCalls,
    models: Array.from(modelsUsed),
    tokens: {
      firstTurnInput: firstTurnTokens || 0,
      uncachedInput: uncachedInputTokens,
      cacheCreation: cacheCreationTokens,
      cacheRead: cacheReadTokens,
      totalInput: totalInputTokens,
      output: outputTokens,
      total: totalInputTokens + outputTokens
    },
    cost: {
      totalUsd: Number(totalCostUsd.toFixed(4)),
      fullWithoutCacheUsd: Number(fullCostWithoutCacheUsd.toFixed(4)),
      savingsUsd: Number(cacheSavingsUsd.toFixed(4)),
      savingsPct: Number(cacheSavingsPct.toFixed(1)),
      avgCostPerTurnUsd: turns > 0 ? Number((totalCostUsd / turns).toFixed(4)) : 0
    },
    topTools: Object.entries(toolsUsed)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }))
  };
}

/**
 * Compute costs across multiple task sessions
 */
async function computeBatchTaskCosts(sessionFiles) {
  const results = [];
  for (const sf of sessionFiles) {
    try {
      const summary = await parseSessionCost(sf);
      results.push(summary);
    } catch (err) {
      results.push({
        filePath: sf,
        fileName: path.basename(sf),
        error: err.message
      });
    }
  }
  return results;
}

// CLI runner
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length === 0) {
      console.log('Usage: node scripts/compute-task-cost.cjs <session1.jsonl> [session2.jsonl ...]');
      console.log('Or:    node scripts/compute-task-cost.cjs --sample');
      process.exit(0);
    }

    let files = args;
    if (args[0] === '--sample') {
      const projectsDir = 'C:/Users/pauol/.claude/projects';
      files = [];
      const pDirs = fs.readdirSync(projectsDir);
      for (const pd of pDirs) {
        const pPath = path.join(projectsDir, pd);
        try {
          if (!fs.statSync(pPath).isDirectory()) continue;
          const jsonls = fs.readdirSync(pPath).filter(f => f.endsWith('.jsonl'));
          for (const j of jsonls) {
            const full = path.join(pPath, j);
            const size = fs.statSync(full).size;
            if (size > 100000 && size < 10000000) {
              files.push(full);
              if (files.length >= 6) break;
            }
          }
          if (files.length >= 6) break;
        } catch (_) {}
      }
    }

    console.log(`[compute-task-cost] Evaluating ${files.length} sessions...`);
    const summaries = await computeBatchTaskCosts(files);

    console.log('\n=== TASK COST SUMMARY ===');
    console.table(summaries.map(s => {
      if (s.error) return { file: s.fileName, error: s.error };
      return {
        file: s.fileName.slice(0, 12),
        turns: s.turns,
        tools: s.toolCalls,
        firstTurnIn: s.tokens.firstTurnInput,
        totalIn: s.tokens.totalInput,
        totalOut: s.tokens.output,
        costUsd: `$${s.cost.totalUsd}`,
        withoutCache: `$${s.cost.fullWithoutCacheUsd}`,
        savedPct: `${s.cost.savingsPct}%`
      };
    }));
  })().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = {
  parseSessionCost,
  computeBatchTaskCosts,
  resolvePricing,
  PRICING_TABLE
};
