#!/usr/bin/env node
'use strict';
// T-0351: one scheduled measurement, never invokes the relay or changes rulings.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const DAY = 24 * 3600000;

function measureObservation({ registeredAt, now, findings, events, rulings }) {
  const registered = Date.parse(registeredAt);
  if (!Number.isFinite(registered)) throw new Error('invalid registration timestamp');
  if (now < registered + DAY) return { status: 'PENDING', due_at: new Date(registered + DAY).toISOString() };
  const delivered = events.filter(e => e.event === 'decision.delivered'
    && Date.parse(e.time) >= registered && Date.parse(e.time) <= now);
  const cohort = [...new Set(delivered.filter(e => rulings.some(r => r.task === e.task
    && r.ruling === e.ruling && r.source !== 'drill' && ['approved', 'cancelled'].includes(r.ruling)
    && Date.parse(r.at) <= Date.parse(e.time))).map(e => e.task))];
  const unheard = findings.filter(f => f.category === 'decision-unheard' && cohort.includes(f.id));
  return { status: !cohort.length ? 'INCOMPLETE' : unheard.length ? 'FAIL' : 'PASS',
    registered_at: registeredAt, measured_at: new Date(now).toISOString(),
    elapsed_hours: (now - registered) / 3600000, delivered_tasks: cohort,
    decision_unheard_for_delivered: unheard,
    all_decision_unheard: findings.filter(f => f.category === 'decision-unheard').map(f => f.id) };
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function runCommand(script, args, output, intel) {
  const options = { encoding: 'utf8', timeout: 150000, maxBuffer: 32 * 1024 * 1024,
    windowsHide: true, env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel } };
  try {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, script), ...args], options);
    fs.writeFileSync(output, stdout);
    return 0;
  } catch (error) {
    fs.writeFileSync(output, error.stdout || error.message);
    if (typeof error.status !== 'number') throw error;
    return error.status;
  }
}

function observe(registration, evidence, intel) {
  const now = Date.now();
  const early = measureObservation({ registeredAt: registration.registered_at, now,
    findings: [], events: [], rulings: [] });
  if (early.status === 'PENDING') return early;
  const reportFile = path.join(evidence, 'steward-24h.json');
  const stewardExit = runCommand('fleet-steward.cjs', ['--json'], reportFile, intel);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (!Array.isArray(report.findings)) throw new Error('steward report missing findings');
  const gateExit = runCommand('steward-gate.cjs', ['--from', reportFile], path.join(evidence, 'gate-24h.log'), intel);
  if (![0, 1].includes(gateExit)) throw new Error(`steward gate unknown: ${gateExit}`);
  return { ...measureObservation({ registeredAt: registration.registered_at, now,
    findings: report.findings, events: readLines(path.join(intel, 'events.jsonl')),
    rulings: readLines(path.join(intel, 'rulings.jsonl')) }), steward_exit: stewardExit, gate_exit: gateExit };
}

function main() {
  const idx = process.argv.indexOf('--registration');
  if (idx < 0 || !process.argv[idx + 1]) throw new Error('required: --registration <registration.json>');
  const file = path.resolve(process.argv[idx + 1]);
  const evidence = path.dirname(file);
  const intel = process.env.WEZBRIDGE_INTEL_DIR || path.resolve(__dirname, '../../_intel');
  const registration = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  let result;
  try { result = observe(registration, evidence, intel); }
  catch (error) { result = { status: 'INCOMPLETE', measured_at: new Date().toISOString(), error: error.message }; }
  const resultFile = path.join(evidence, 'observation-24h.json');
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (result.status !== 'PENDING') {
    const body = `T-0351 observation: ${result.status}. Evidence: ${resultFile}\ncriteria:\n`
      + `- AC3: ${result.status === 'PASS' ? 'pass' : 'fail'} — measured after 24h; delivered cohort=${result.delivered_tasks?.length ?? 'unknown'}, unheard=${result.decision_unheard_for_delivered?.length ?? 'unknown'}.\n`
      + 'files_changed: observation-24h.json, steward-24h.json, gate-24h.log\nnext_action: origin must inspect evidence and review all four AC before closing T-0351.';
    const queued = require('../src/project-queue.cjs').enqueue({ project: 'orchestrator',
      corr: 'decision-relay-cron-20260904', type: 'result', from_project: 'wezbridge',
      from_pane: null, ok: false, body }, { base: intel });
    if (!queued.ok) throw new Error(`observation delivery queue failed: ${queued.error}`);
  }
  process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 3;
}

module.exports = { measureObservation };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 3; }
}
