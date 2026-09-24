#!/usr/bin/env node
'use strict';
/**
 * fake-ledger-cli.cjs — test double for `_docs-curation/ledger.cjs`, used ONLY
 * by test/automation-router.test.cjs. Records every invocation (argv) to
 * FAKE_LEDGER_CALL_LOG (jsonl, append) and mirrors just enough of the real
 * ledger's `create --origin <key>` idempotent-import behavior (T-0598): a
 * second `create` with the same --origin returns the SAME task id instead of
 * minting a new one. State (id counter + origin->task map) persists in
 * FAKE_LEDGER_DB (a JSON file) across invocations so a test that spawns the
 * router twice still sees one card. Never touches the real fleet ledger.
 */
const fs = require('node:fs');

function parseArgs(argv) {
  const out = {};
  for (let i = 1; i < argv.length; i += 1) { // argv[0] is the subcommand
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

function loadDb(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { nextId: 1, byOrigin: {} }; }
}

function saveDb(file, db) { fs.writeFileSync(file, JSON.stringify(db, null, 2)); }

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const callLog = process.env.FAKE_LEDGER_CALL_LOG;
  const dbFile = process.env.FAKE_LEDGER_DB;
  if (callLog) fs.appendFileSync(callLog, `${JSON.stringify({ cmd, argv })}\n`);

  if (cmd !== 'create') {
    process.stderr.write(`fake-ledger-cli: unsupported command ${cmd}\n`);
    return 1;
  }
  const opts = parseArgs(argv);
  const db = loadDb(dbFile);
  const origin = opts.origin || null;
  if (origin && db.byOrigin[origin]) {
    process.stdout.write(`${JSON.stringify(db.byOrigin[origin])}\n`);
    return 0;
  }
  const id = `T-FAKE-${String(db.nextId).padStart(4, '0')}`;
  db.nextId += 1;
  const task = {
    id, origin_key: origin, repo: opts.repo || null, title: opts.title || null,
    kind: opts.kind || 'general', state: opts.state || 'queued', corr: opts.corr || null,
  };
  if (origin) db.byOrigin[origin] = task;
  saveDb(dbFile, db);
  process.stdout.write(`${JSON.stringify(task)}\n`);
  return 0;
}

if (require.main === module) { process.exitCode = main(); }

module.exports = { main };
