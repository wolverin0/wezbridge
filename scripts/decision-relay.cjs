#!/usr/bin/env node
'use strict';
/**
 * decision-relay.cjs — pasada UNICA del relay de decisiones (W3): lee las
 * lineas nuevas de `_intel/rulings.jsonl`, resuelve a quien le importa cada
 * `approved|cancelled` (pane del repo, o `finalorchestra` si la lease es de
 * Eve), entrega solo con send verificado y SIEMPRE encola durable.
 * Cron-able por diseno: corre una vez y sale — no es un loop always-on nuevo
 * (ver src/COORDINATORS.json). Motor: src/decision-relay.cjs.
 *
 * Uso: node scripts/decision-relay.cjs [--once] [--json]
 * Exit: 0 = pasada limpia; 1 = alguna decision llego al cap de intentos EN
 * ESTA CORRIDA (flags nuevos necesitan ojo humano; los viejos no re-alarman).
 * Fatal errors also exit 1. Every CLI run persists its JSON through
 * routine-findings; failed runs survive later clean runs for steward/board review.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createRelay } = require('../src/decision-relay.cjs');
const { intelDir } = require('../src/a2a-intel.cjs');
const discovery = require('../src/pane-discovery.cjs');
const send = require('../src/verified-send.cjs');
const { recordRun } = require('../src/decision-relay-report.cjs');
const startedAt = new Date().toISOString();

/** Mismo criterio que a2a-intel.takeDispatchLease, con el override del drill. */
function ledgerBin() {
  const dir = process.env.WEZBRIDGE_LEDGER_DIR || path.join(intelDir(), '..', '_docs-curation');
  return path.join(dir, 'ledger.cjs');
}

function runLedger(args) {
  const out = execFileSync(process.execPath, [ledgerBin(), ...args], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  try { return JSON.parse(out); } catch { return out; }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');

  const relay = createRelay({
    intelDir: intelDir(),
    discoverPanes: discovery.discoverPanes,
    send,
    runLedger,
    log: (msg) => { if (!asJson) console.log(msg); },
  });

  const out = await relay.relayOnce();
  const st = relay.status();
  const code = out.flagged.length > 0 ? 1 : 0;
  const report = recordRun(intelDir(), { ...out, status: st, started_at: startedAt,
    completed_at: new Date().toISOString(), pid: process.pid }, code);
  if (asJson) {
    console.log(JSON.stringify(report));
  } else {
    const names = (list) => (list.length ? list.map((e) => e.task).join(',') : '-');
    console.log(`decision-relay: ingested=${out.ingested} delivered=${out.delivered.length} (${names(out.delivered)}) `
      + `queued=${out.queued.length} (${names(out.queued)}) undeliverable=${out.undeliverable.length} (${names(out.undeliverable)}) `
      + `flagged=${out.flagged.length} pending=${st.pending} totalFlagged=${st.flagged}`);
    for (const f of out.flagged) console.log(`decision-relay: FLAG ${f.task} (${f.project}) — ${f.reason}`);
  }
  return code;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`decision-relay: fatal: ${err.message}`);
  try {
    const report = recordRun(intelDir(), { error: err.message, started_at: startedAt,
      completed_at: new Date().toISOString(), pid: process.pid }, 1);
    if (process.argv.includes('--json')) console.log(JSON.stringify(report));
  } catch (reportError) { console.error(`decision-relay: report failed: ${reportError.message}`); }
  process.exitCode = 1;
});
