#!/usr/bin/env node
'use strict';
/**
 * waker-gate.cjs — the CONSUMER THAT CAN FAIL for the orchestrator waker.
 * RED si hay intents viejos o flaggeados; imprime el `reason` de cada flag
 * (desde W4 hay dos motivos distintos: cap de intentos, o "unverified twice:
 * composer unreadable"). Exit 0 GREEN / 1 RED / 3 UNKNOWN.
 *
 * Why this exists: the waker was disarmed on 2026-08-13 with an explicit re-arm
 * condition written into _intel/orch-waker.json — "only when something
 * downstream of the poke can FAIL". The waker itself was never broken: it
 * detected completions and delivered pokes correctly. What was broken was that
 * its consumer could not fail — pokes went to a narrator, 55 intents piled up,
 * and nothing in the system could say RED. A poker whose consumer cannot fail
 * is just a report.
 *
 * This is that consumer. Shape copied from steward-gate.cjs on purpose:
 * deterministic, no model in the path, narration cannot clear it.
 *
 *   RED if any pending intent is older than STALE_MINUTES  (pokes not consumed)
 *   RED if any intent hit the attempt cap and was flagged   (pokes undeliverable)
 *   GREEN if the queue is drained or fresh
 *   GREEN if the waker is disarmed BY RECORDED DECISION     (a decision is not a fault
 *                                                            — see T-0176)
 *   RED if config says enabled but the state dir is missing (armed on paper only)
 *
 * Exit codes:  0 GREEN · 1 RED · 3 UNKNOWN (inputs unreadable — NEVER reported as 0)
 */
const fs = require('node:fs');
const path = require('node:path');

const INTEL = process.env.WEZBRIDGE_INTEL_DIR
  || path.join(__dirname, '..', '..', '_intel');
const STATE = path.join(INTEL, '.orch-waker-state');

// Generous on purpose: the orchestrator's own wakeup loop runs ~15 min, so a
// poke older than two full cycles is stuck, not queued. A noisy gate teaches
// everyone to ignore it — which is worse than no gate.
const STALE_MINUTES = Number(process.env.WAKER_GATE_STALE_MINUTES || 30);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function main() {
  const cfg = readJson(path.join(INTEL, 'orch-waker.json'), null);
  if (cfg === null) {
    console.log('waker-gate: UNKNOWN — _intel/orch-waker.json unreadable. Refusing to report GREEN on missing inputs.');
    process.exit(3);
  }

  if (cfg.enabled !== true) {
    const disarmKey = Object.keys(cfg).find((k) => k.startsWith('_disarmed'));
    if (disarmKey) {
      console.log(`waker-gate: GREEN — waker disarmed by recorded decision (${disarmKey}). A decision is not a fault.`);
      process.exit(0);
    }
    // Off with no decision record: not this gate's call to make. The health
    // check already alerts on an unexplained disarm; double-alerting here would
    // punish the same state twice.
    console.log('waker-gate: GREEN — waker not enabled (no decision record; bridge_health owns that alert).');
    process.exit(0);
  }

  const pending = readJson(path.join(STATE, 'pending.json'), null);
  if (pending === null) {
    console.log('waker-gate: RED — config says enabled but the state dir is unreadable. Armed on paper only.');
    process.exit(1);
  }

  const flags = readJson(path.join(STATE, 'flags.json'), {});
  const flaggedIds = Object.keys(flags);
  if (flaggedIds.length > 0) {
    // T-0419: a flag now has THREE possible causes, split into two categories
    // that point at DIFFERENT places to look. "consumer not consuming" (the
    // attempt cap, or "unverified twice") means the poke WAS attempted against
    // a live target and still failed — look at delivery. "destination
    // unreachable" (reason starts with target-unreachable) means no poke was
    // ever attempted because the target itself vanished/stayed unknown — look
    // at the PANE, not the waker's delivery path. Printing them as one
    // undifferentiated "attempt cap" bucket sent the operator to the wrong
    // place for exactly this case.
    const unreachable = flaggedIds.filter((id) => /^target-unreachable/.test(String(flags[id].reason || '')));
    const consumerSide = flaggedIds.filter((id) => !unreachable.includes(id));
    const printGroup = (ids) => {
      for (const id of ids.slice(0, 5)) {
        const f = flags[id];
        console.log(`  ${id}  repo=${f.repo || '?'}  flagged_at=${f.flagged_at || '?'}`);
        // El MOTIVO, no solo el conteo: desde W4 un intent muere por dos razones
        // muy distintas — el cap de intentos fallidos, o "unverified twice"
        // (composer ilegible). Sin el motivo el operador mira el pane equivocado.
        if (f.reason) console.log(`      reason: ${f.reason}`);
      }
    };
    if (unreachable.length) {
      console.log(`waker-gate: RED — ${unreachable.length} intent(s) flagged: DESTINATION UNREACHABLE (never attempted — the target pane itself is gone/unknown, not the waker's delivery):`);
      printGroup(unreachable);
    }
    if (consumerSide.length) {
      console.log(`waker-gate: RED — ${consumerSide.length} intent(s) flagged: CONSUMER NOT CONSUMING (attempt cap reached or twice-unverified — a poke WAS attempted against a live target):`);
      printGroup(consumerSide);
    }
    console.log('These never resolve themselves. Someone must look, then clear flags.json.');
    process.exit(1);
  }

  const now = Date.now();
  const stale = Object.entries(pending).filter(([, it]) => {
    const t = Date.parse(it.time || '');
    return !Number.isNaN(t) && (now - t) > STALE_MINUTES * 60000;
  });
  if (stale.length > 0) {
    const oldest = Math.max(...stale.map(([, it]) => Math.round((now - Date.parse(it.time)) / 60000)));
    console.log(`waker-gate: RED — ${stale.length} pending intent(s) older than ${STALE_MINUTES} min (oldest ${oldest} min).`);
    console.log('Pokes are being produced but not consumed — the exact failure that disarmed the waker on 2026-08-13.');
    process.exit(1);
  }

  console.log(`waker-gate: GREEN — ${Object.keys(pending).length} pending, none older than ${STALE_MINUTES} min, no flags.`);
  process.exit(0);
}

main();
