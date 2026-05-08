'use strict';
/**
 * cost-meter.cjs — Per-pane runtime + token cost tracker.
 *
 * Goal: empirically validate the "stay local" decision (mm-5d3d) by
 * tracking actual local cost vs hypothetical Managed Agents cost
 * (mm-3627: $0.08/h active runtime + standard token rates).
 *
 * Persists JSONL events to vault/_wezbridge/cost-meter.jsonl. Each line
 * is a single event:
 *   spawn   { ts, pane_id, model?, cwd? }
 *   tick    { ts, pane_id, ctx_used_pct?, ctx_tokens?, model? }
 *   close   { ts, pane_id }
 *
 * Aggregation: per-pane elapsed_hours + max ctx_tokens → estimated MA
 * runtime+input cost vs $0 local.
 *
 * NOT TRACKED (out of MVP scope): output tokens, cache reads, multi-turn
 * deltas. Status-bar `Ctx Used` is a max-context proxy — overestimates
 * cumulative input. Treat numbers as ±20% rough.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG = path.resolve(__dirname, '..', 'vault', '_wezbridge', 'cost-meter.jsonl');

// Approximate per-MTok input rates (USD). Conservative defaults. Update
// when Anthropic / OpenAI pricing pages change.
const MODEL_INPUT_RATE_USD_PER_MTOK = {
  'claude-opus-4-7':       15.00,
  'claude-opus-4-7-1m':    30.00,    // 1M context tier
  'claude-sonnet-4-6':      3.00,
  'claude-haiku-4-5':       1.00,
  'gpt-5.5-high':           5.00,
  'gpt-5.5':                3.00,
  'unknown':                5.00,    // conservative middle-of-pack default
};

const MA_HOURLY_RATE_USD = 0.08;     // Managed Agents active-runtime base

function _ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Append one event to the JSONL log.
 * @param {Object} event - must have at least `event` (one of spawn|tick|close)
 *                         and `pane_id`. `ts` defaults to now.
 * @param {Object} [opts] - { logPath }
 */
function record(event, opts = {}) {
  if (!event || typeof event !== 'object') return;
  if (!event.event || !event.pane_id) return;
  const logPath = opts.logPath || DEFAULT_LOG;
  _ensureDir(logPath);
  const line = JSON.stringify({ ts: event.ts || new Date().toISOString(), ...event });
  fs.appendFileSync(logPath, line + '\n', 'utf8');
}

/** Read all events from the log. Returns [] if log doesn't exist yet. */
function readEvents(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG;
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Estimate input-side USD cost for `ctxTokens` tokens at `model` rate. */
function estimateInputCostUsd(ctxTokens, model = 'unknown') {
  const rate = MODEL_INPUT_RATE_USD_PER_MTOK[model] ?? MODEL_INPUT_RATE_USD_PER_MTOK.unknown;
  return (Number(ctxTokens) / 1_000_000) * rate;
}

/**
 * Aggregate raw events into a per-pane summary with hypothetical MA cost.
 * Open panes (no close event) use `now` as the end timestamp.
 *
 * @param {Object[]} events - parsed event objects from readEvents()
 * @param {Object} [opts] - { now: epoch ms, fallbackModel: string }
 * @returns {Array} summary entries: { pane_id, model, elapsed_hours,
 *   max_ctx_tokens, local_cost_usd, managed_agents_cost_usd, savings_vs_ma }
 */
function aggregate(events, opts = {}) {
  const nowMs = opts.now || Date.now();
  const fallbackModel = opts.fallbackModel || 'unknown';

  const byPane = new Map();
  for (const e of events) {
    if (!e || !e.pane_id || !e.event) continue;
    const id = String(e.pane_id);
    if (!byPane.has(id)) {
      byPane.set(id, { spawn: null, close: null, model: null, maxCtx: 0 });
    }
    const p = byPane.get(id);
    if (e.event === 'spawn') {
      p.spawn = e.ts;
      if (e.model) p.model = e.model;
    } else if (e.event === 'close') {
      p.close = e.ts;
    } else if (e.event === 'tick') {
      if (typeof e.ctx_tokens === 'number' && e.ctx_tokens > p.maxCtx) {
        p.maxCtx = e.ctx_tokens;
      }
      if (e.model && !p.model) p.model = e.model;
    }
  }

  const summary = [];
  for (const [paneId, p] of byPane) {
    if (!p.spawn) continue; // ignore panes whose spawn we never recorded
    const startMs = Date.parse(p.spawn);
    const endMs = p.close ? Date.parse(p.close) : nowMs;
    const elapsedH = Math.max(0, (endMs - startMs) / 3_600_000);
    const model = p.model || fallbackModel;
    const localCost = 0; // local stack has no per-hour cost
    const maRuntimeCost = elapsedH * MA_HOURLY_RATE_USD;
    const maTokenCost = estimateInputCostUsd(p.maxCtx, model);
    const maCost = maRuntimeCost + maTokenCost;
    summary.push({
      pane_id: paneId,
      model,
      elapsed_hours: Number(elapsedH.toFixed(4)),
      max_ctx_tokens: p.maxCtx,
      local_cost_usd: Number(localCost.toFixed(4)),
      managed_agents_cost_usd: Number(maCost.toFixed(4)),
      ma_runtime_cost_usd: Number(maRuntimeCost.toFixed(4)),
      ma_token_cost_usd: Number(maTokenCost.toFixed(4)),
      savings_vs_ma: Number((maCost - localCost).toFixed(4)),
    });
  }
  // Sort by ma cost desc so heaviest panes show first
  summary.sort((a, b) => b.managed_agents_cost_usd - a.managed_agents_cost_usd);
  return summary;
}

/** Convenience: aggregate + total. */
function summary(opts = {}) {
  const events = readEvents(opts);
  const perPane = aggregate(events, opts);
  const totals = perPane.reduce(
    (acc, p) => {
      acc.elapsed_hours += p.elapsed_hours;
      acc.max_ctx_tokens += p.max_ctx_tokens;
      acc.managed_agents_cost_usd += p.managed_agents_cost_usd;
      return acc;
    },
    { elapsed_hours: 0, max_ctx_tokens: 0, managed_agents_cost_usd: 0 },
  );
  return {
    panes: perPane,
    totals: {
      elapsed_hours: Number(totals.elapsed_hours.toFixed(4)),
      max_ctx_tokens: totals.max_ctx_tokens,
      managed_agents_cost_usd: Number(totals.managed_agents_cost_usd.toFixed(4)),
      savings_vs_ma_usd: Number(totals.managed_agents_cost_usd.toFixed(4)),
    },
  };
}

module.exports = {
  DEFAULT_LOG,
  MA_HOURLY_RATE_USD,
  MODEL_INPUT_RATE_USD_PER_MTOK,
  record,
  readEvents,
  estimateInputCostUsd,
  aggregate,
  summary,
};
