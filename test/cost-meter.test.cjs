'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const meter = require(path.resolve(__dirname, '..', 'src', 'cost-meter.cjs'));

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cost-meter-'));
  return path.join(dir, 'cost-meter.jsonl');
}

// estimateInputCostUsd ----------------------------------------------------

test('estimateInputCostUsd: 1M tokens at opus rate = $15', () => {
  const cost = meter.estimateInputCostUsd(1_000_000, 'claude-opus-4-7');
  assert.equal(cost, 15.0);
});

test('estimateInputCostUsd: 500k tokens at sonnet rate = $1.50', () => {
  const cost = meter.estimateInputCostUsd(500_000, 'claude-sonnet-4-6');
  assert.equal(cost, 1.5);
});

test('estimateInputCostUsd: unknown model uses default rate', () => {
  const cost = meter.estimateInputCostUsd(1_000_000, 'made-up-model');
  assert.equal(cost, meter.MODEL_INPUT_RATE_USD_PER_MTOK.unknown);
});

test('estimateInputCostUsd: 0 tokens = 0', () => {
  assert.equal(meter.estimateInputCostUsd(0, 'claude-opus-4-7'), 0);
});

// record + readEvents roundtrip -----------------------------------------

test('record + readEvents: writes and reads JSONL', () => {
  const logPath = tmpLog();
  meter.record({ event: 'spawn', pane_id: 12, model: 'claude-opus-4-7' }, { logPath });
  meter.record({ event: 'tick', pane_id: 12, ctx_tokens: 100_000 }, { logPath });
  meter.record({ event: 'close', pane_id: 12 }, { logPath });
  const events = meter.readEvents({ logPath });
  assert.equal(events.length, 3);
  assert.equal(events[0].event, 'spawn');
  assert.equal(events[2].event, 'close');
});

test('readEvents: returns [] for nonexistent log', () => {
  const events = meter.readEvents({ logPath: '/nonexistent/path/foo.jsonl' });
  assert.deepEqual(events, []);
});

test('record: ignores invalid events without crashing', () => {
  const logPath = tmpLog();
  meter.record(null, { logPath });
  meter.record({}, { logPath });
  meter.record({ event: 'spawn' }, { logPath }); // missing pane_id
  meter.record({ pane_id: 12 }, { logPath });    // missing event
  const events = meter.readEvents({ logPath });
  assert.equal(events.length, 0);
});

test('readEvents: skips malformed JSON lines', () => {
  const logPath = tmpLog();
  meter.record({ event: 'spawn', pane_id: 12 }, { logPath });
  fs.appendFileSync(logPath, 'not-json\n', 'utf8');
  meter.record({ event: 'close', pane_id: 12 }, { logPath });
  const events = meter.readEvents({ logPath });
  assert.equal(events.length, 2);
});

// aggregate -------------------------------------------------------------

test('aggregate: simple spawn + close pane', () => {
  const events = [
    { event: 'spawn', pane_id: 12, ts: '2026-05-07T19:00:00Z', model: 'claude-opus-4-7' },
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:30:00Z', ctx_tokens: 200_000 },
    { event: 'close', pane_id: 12, ts: '2026-05-07T20:00:00Z' },
  ];
  const summary = meter.aggregate(events);
  assert.equal(summary.length, 1);
  const p = summary[0];
  assert.equal(p.pane_id, '12');
  assert.equal(p.model, 'claude-opus-4-7');
  assert.equal(p.elapsed_hours, 1);
  assert.equal(p.max_ctx_tokens, 200_000);
  assert.equal(p.local_cost_usd, 0);
  // 1h × $0.08/h = $0.08 runtime + 200k tokens × $15/MTok = $3.00 input = $3.08
  assert.equal(p.ma_runtime_cost_usd, 0.08);
  assert.equal(p.ma_token_cost_usd, 3);
  assert.equal(p.managed_agents_cost_usd, 3.08);
  assert.equal(p.savings_vs_ma, 3.08);
});

test('aggregate: open pane (no close) uses opts.now', () => {
  const events = [
    { event: 'spawn', pane_id: 12, ts: '2026-05-07T19:00:00Z', model: 'claude-sonnet-4-6' },
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:30:00Z', ctx_tokens: 100_000 },
  ];
  const summary = meter.aggregate(events, { now: Date.parse('2026-05-07T20:00:00Z') });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].elapsed_hours, 1);
});

test('aggregate: takes max ctx across multiple ticks', () => {
  const events = [
    { event: 'spawn', pane_id: 12, ts: '2026-05-07T19:00:00Z' },
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:10:00Z', ctx_tokens: 50_000 },
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:20:00Z', ctx_tokens: 800_000 }, // peak
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:30:00Z', ctx_tokens: 100_000 }, // post-compact
    { event: 'close', pane_id: 12, ts: '2026-05-07T19:40:00Z' },
  ];
  const summary = meter.aggregate(events);
  assert.equal(summary[0].max_ctx_tokens, 800_000);
});

test('aggregate: ignores panes with no spawn event', () => {
  const events = [
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:00:00Z', ctx_tokens: 100_000 },
    { event: 'close', pane_id: 12, ts: '2026-05-07T20:00:00Z' },
  ];
  const summary = meter.aggregate(events);
  assert.equal(summary.length, 0);
});

test('aggregate: sorts by ma cost descending', () => {
  const events = [
    { event: 'spawn', pane_id: 1, ts: '2026-05-07T18:00:00Z', model: 'claude-haiku-4-5' },
    { event: 'tick',  pane_id: 1, ts: '2026-05-07T18:30:00Z', ctx_tokens: 50_000 },
    { event: 'close', pane_id: 1, ts: '2026-05-07T19:00:00Z' },
    { event: 'spawn', pane_id: 2, ts: '2026-05-07T18:00:00Z', model: 'claude-opus-4-7' },
    { event: 'tick',  pane_id: 2, ts: '2026-05-07T18:30:00Z', ctx_tokens: 500_000 },
    { event: 'close', pane_id: 2, ts: '2026-05-07T19:00:00Z' },
  ];
  const summary = meter.aggregate(events);
  assert.equal(summary[0].pane_id, '2'); // opus + 500k > haiku + 50k
  assert.equal(summary[1].pane_id, '1');
});

test('aggregate: tick-supplied model used when spawn lacks one', () => {
  const events = [
    { event: 'spawn', pane_id: 12, ts: '2026-05-07T19:00:00Z' }, // no model
    { event: 'tick',  pane_id: 12, ts: '2026-05-07T19:30:00Z', ctx_tokens: 100_000, model: 'gpt-5.5' },
    { event: 'close', pane_id: 12, ts: '2026-05-07T20:00:00Z' },
  ];
  const summary = meter.aggregate(events);
  assert.equal(summary[0].model, 'gpt-5.5');
});

// summary ---------------------------------------------------------------

test('summary: returns aggregated panes + totals from log', () => {
  const logPath = tmpLog();
  meter.record({ event: 'spawn', pane_id: 1, ts: '2026-05-07T19:00:00Z', model: 'claude-opus-4-7' }, { logPath });
  meter.record({ event: 'tick',  pane_id: 1, ts: '2026-05-07T19:30:00Z', ctx_tokens: 100_000 }, { logPath });
  meter.record({ event: 'close', pane_id: 1, ts: '2026-05-07T20:00:00Z' }, { logPath });
  const out = meter.summary({ logPath });
  assert.equal(out.panes.length, 1);
  assert.equal(out.totals.elapsed_hours, 1);
  assert.equal(out.totals.max_ctx_tokens, 100_000);
  // 1h × $0.08 + 100k × $15/MTok = $0.08 + $1.50 = $1.58
  assert.equal(out.totals.managed_agents_cost_usd, 1.58);
});

// constants -------------------------------------------------------------

test('MA_HOURLY_RATE_USD matches Anthropic pricing page (2026-04)', () => {
  assert.equal(meter.MA_HOURLY_RATE_USD, 0.08);
});

test('MODEL_INPUT_RATE_USD_PER_MTOK has known model entries', () => {
  const rates = meter.MODEL_INPUT_RATE_USD_PER_MTOK;
  assert.ok('claude-opus-4-7' in rates);
  assert.ok('claude-sonnet-4-6' in rates);
  assert.ok('unknown' in rates);
  assert.ok(rates['claude-opus-4-7'] > rates['claude-sonnet-4-6']);
  assert.ok(rates['claude-sonnet-4-6'] > rates['claude-haiku-4-5']);
});
