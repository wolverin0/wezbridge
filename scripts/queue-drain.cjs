#!/usr/bin/env node
'use strict';
/**
 * queue-drain.cjs — deterministic ONE-PASS drain of the per-project A2A queues
 * (_intel/queues/*.jsonl, written by a2a_send {to_project}). Cron-able by
 * design: runs once and exits — deliberately NOT a new always-on loop in src/
 * (see src/COORDINATORS.json history for why that shape is forbidden-by-default).
 *
 * Per project: ingest undelivered entries (sha1 dedupe, attempt cap 3 ->
 * flag-and-stop, 24h age expiry), re-resolve the project's pane via
 * pane-identity NOW, deliver with verified submission only when the pane is
 * idle. Verified type=result redeliveries also auto-ack the bookkeeping acuse.
 *
 * Usage: node scripts/queue-drain.cjs [--dry-run] [--project <name>]
 * Exit codes: 0 = clean pass; 1 = one or more entries hit the attempt cap
 * THIS RUN (new flags need a human look — pre-existing flags do not re-alarm).
 */

const projectQueue = require('../src/project-queue.cjs');
const discovery = require('../src/pane-discovery.cjs');
const send = require('../src/verified-send.cjs');

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const projArgIdx = argv.indexOf('--project');
  const only = projArgIdx !== -1 ? argv[projArgIdx + 1] : null;

  const projects = only ? [only] : projectQueue.listQueues();
  if (!projects.length) {
    console.log('queue-drain: no project queues found — nothing to do');
    return 0;
  }

  let newFlags = 0;
  for (const project of projects) {
    const consumer = projectQueue.createConsumer({
      project,
      discoverPanes: discovery.discoverPanes,
      send,
      log: (msg) => console.log(msg),
    });
    const out = await consumer.drain({ dryRun });
    const st = consumer.status();
    newFlags += out.flagged || 0;
    console.log(`queue-drain[${project}]${dryRun ? ' (dry-run)' : ''}: ` +
      `ingested=${out.added || 0} delivered=${out.delivered || 0} flagged=${out.flagged || 0} ` +
      `pending=${st.pending} oldest=${st.pendingOldestMinutes}min totalFlagged=${st.flagged}`);
  }
  return newFlags > 0 ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`queue-drain: fatal: ${err.message}`);
  process.exitCode = 1;
});
