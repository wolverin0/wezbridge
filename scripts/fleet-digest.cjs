#!/usr/bin/env node
/**
 * fleet-digest — CLI for src/fleet-digest.cjs (T-0409, S6 re-scope). Classifies
 * _intel/pane-events.jsonl into immediate/digest/drop, batches completions into a
 * 30-min digest, and keeps a durable cursor + send log.
 *
 *   node scripts/fleet-digest.cjs                          one dry-run tick (default; prints, never sends)
 *   node scripts/fleet-digest.cjs --send                   one LIVE tick (calls notify_orchestrator.py) — NOT enabled by any schedule in this card
 *   node scripts/fleet-digest.cjs --dry-run --replay --from <iso> --to <iso>
 *                                                           stateless prediction over a time range against the REAL pane-events.jsonl (AC4)
 *   node scripts/fleet-digest.cjs --count-day YYYY-MM-DD    sends recorded that UTC day (replaces the dead daemon-err.log instrument)
 *
 * --dry-run is the DEFAULT mode. --send is the only mode that calls notify_orchestrator.py,
 * and nothing in this repo schedules --send (see docs/operations.md "Fleet digest").
 * --replay never touches _intel/.fleet-digest state — it only reads pane-events.jsonl.
 *
 * Overrides (mainly for tests): --events <file>, --state-dir <dir>, --window <minutes>.
 * Env: WEZBRIDGE_INTEL_DIR overrides the default _intel dir (same convention as
 * lane-roster.cjs / orca-census.cjs).
 */
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  runOnce, runReplay, countDay, DEFAULT_WINDOW_MS, resolveIntelDir,
} = require('../src/fleet-digest.cjs');
const { loadRoster } = require('../src/lane-roster.cjs');

const INTEL_DIR = resolveIntelDir(__dirname);
const DEFAULT_EVENTS_PATH = path.join(INTEL_DIR, 'pane-events.jsonl');
const DEFAULT_STATE_DIR = path.join(INTEL_DIR, '.fleet-digest');
const NOTIFY_SCRIPT = path.join(__dirname, 'orchestration', 'notify_orchestrator.py');

function parseArgs(argv) {
  const out = {
    dryRun: true, send: false, replay: false, countDay: null,
    from: null, to: null, window: DEFAULT_WINDOW_MS, events: null, stateDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--send') { out.send = true; out.dryRun = false; }
    else if (a === '--replay') out.replay = true;
    else if (a === '--count-day') out.countDay = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--window') out.window = Number(argv[++i]) * 60 * 1000;
    else if (a === '--events') out.events = argv[++i];
    else if (a === '--state-dir') out.stateDir = argv[++i];
  }
  return out;
}

/** Reuses scripts/orchestration/notify_orchestrator.py — the durable-outbox delivery
 * path Foreman already uses. Spawned as a subprocess so a missing/broken python never
 * takes the digest process down with it. */
function sendViaNotifyOrchestrator(message) {
  const res = spawnSync('python', [NOTIFY_SCRIPT, message], { encoding: 'utf8' });
  const ok = res.status === 0 && !res.error;
  return { ok, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

function main(argv) {
  const args = parseArgs(argv);
  const eventsPath = args.events || DEFAULT_EVENTS_PATH;
  const stateDir = args.stateDir || DEFAULT_STATE_DIR;

  if (args.countDay) {
    const n = countDay(stateDir, args.countDay);
    console.log(`[fleet-digest] count-day ${args.countDay}: ${n} sends`);
    return 0;
  }

  if (args.replay) {
    if (!args.from || !args.to) {
      console.error('[fleet-digest] --replay requires --from <iso> --to <iso>');
      return 2;
    }
    const roster = loadRoster(INTEL_DIR);
    const r = runReplay({ eventsPath, from: args.from, to: args.to, windowMs: args.window, roster });
    console.log(
      `[fleet-digest] replay ${args.from}..${args.to} `
      + `raw_events=${r.rawEvents} immediate=${r.immediateCount} digest_messages=${r.digestMessageCount} `
      + `predicted_sends/day=${r.predictedSendsPerDay.toFixed(2)}`,
    );
    return 0;
  }

  const roster = loadRoster(INTEL_DIR);
  const result = runOnce({
    eventsPath, stateDir, windowMs: args.window, roster,
    sendEnabled: args.send, send: args.send ? sendViaNotifyOrchestrator : undefined,
  });
  console.log(
    `[fleet-digest] ${args.send ? 'send' : 'dry-run'} tick: `
    + `immediate=${result.immediateSent.length} digest=${result.digestSent ? 1 : 0}`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { parseArgs, main, sendViaNotifyOrchestrator, DEFAULT_EVENTS_PATH, DEFAULT_STATE_DIR };
