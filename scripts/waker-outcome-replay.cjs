#!/usr/bin/env node
'use strict';
// Finite, model-free replay. Reads live input, copies it, and records would-send
// messages locally. Never opens WezTerm or changes the source ledger/daemon.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const assert = require('node:assert/strict');

function snapshot(intel, root, events) {
  const copy = path.join(root, '_intel');
  fs.mkdirSync(path.join(copy, 'tasks'), { recursive: true });
  for (const name of fs.readdirSync(path.join(intel, 'tasks')).filter(n => n.endsWith('.json')))
    fs.copyFileSync(path.join(intel, 'tasks', name), path.join(copy, 'tasks', name));
  if (fs.existsSync(path.join(intel, 'rulings.jsonl')))
    fs.copyFileSync(path.join(intel, 'rulings.jsonl'), path.join(copy, 'rulings.jsonl'));
  for (const repo of new Set(events.map(e => e.repo))) {
    const dir = path.join(path.dirname(intel), repo, '.orchestrator');
    if (!fs.existsSync(dir)) continue;
    const target = path.join(root, repo, '.orchestrator');
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(dir).filter(n => /^graph.*\.json$/i.test(n)))
      fs.copyFileSync(path.join(dir, name), path.join(target, name));
  }
  return copy;
}

function sourceVersion(ref) {
  const file = path.resolve(__dirname, '../src/orchestrator-waker.cjs');
  if (!ref) return { createWaker: require(file).createWaker,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  const result = spawnSync('git', ['show', `${ref}:src/orchestrator-waker.cjs`],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const compiled = new Module(file, module);
  compiled.filename = file; compiled.paths = module.paths;
  compiled._compile(result.stdout, file);
  return { createWaker: compiled.exports.createWaker,
    sha256: crypto.createHash('sha256').update(result.stdout).digest('hex') };
}

async function replay(version, root, intel, events, label) {
  const source = sourceVersion(version);
  const eventsPath = path.join(intel, label + '-events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const messages = [], logs = [];
  const options = { eventsPath, stateDir: path.join(intel, label + '-state'), intelDir: intel,
    reposRoot: root, watchRepos: [...new Set(events.map(e => e.repo))], settleTicks: 1,
    debounceMs: 0, cooldownMs: 0, now: () => Math.max(...events.map(e => Date.parse(e.time))) + 1000,
    discoverPanes: () => [{ paneId: 8, status: 'idle' }], resolveTarget: () => 8,
    log: line => logs.push(line), send: {
      sendPromptDeferredEnter: async (_pane, text) => { messages.push(text); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted' } };
  const waker = source.createWaker(options);
  fs.appendFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await waker.tick();
  const afterFirst = messages.length;
  const restarted = source.createWaker(options);
  await restarted.tick();
  const afterRestart = messages.length;
  fs.appendFileSync(eventsPath, events.map(e => JSON.stringify({ ...e,
    session: e.session + '-simulated-next-turn' })).join('\n') + '\n');
  await restarted.tick();
  return { label, sourceSha256: source.sha256, messages, logs, afterFirst,
    afterRestart, afterSimulatedNextTurns: messages.length, status: restarted.status() };
}

async function main() {
  const [intelArg, outputArg, baseline, ...times] = process.argv.slice(2);
  assert.ok(intelArg && outputArg && baseline && times.length,
    'usage: node scripts/waker-outcome-replay.cjs <intel> <new-report.json> <baseline-ref> <event-time>...');
  const intel = path.resolve(intelArg), output = path.resolve(outputArg);
  const outputRelative = path.relative(intel, output);
  assert.ok(outputRelative.startsWith('..' + path.sep) || path.isAbsolute(outputRelative),
    'report must be outside the source intel directory');
  assert.ok(!fs.existsSync(output), 'report already exists; choose a new output');
  const events = fs.readFileSync(path.join(intel, 'pane-events.jsonl'), 'utf8').split('\n')
    .filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter(event => times.includes(event.time));
  assert.equal(events.length, times.length, 'each requested event must exist exactly once');
  for (const event of events) {
    assert.ok(typeof event.repo === 'string' && event.repo.trim() && !path.isAbsolute(event.repo)
      && !event.repo.replace(/\\/g, '/').split('/').includes('..'), 'unsafe event repo');
    assert.ok(Number.isFinite(Date.parse(event.time)), 'invalid event time');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-real-replay-'));
  try {
    const copied = snapshot(intel, root, events);
    const before = await replay(baseline, root, copied, events, 'baseline');
    const after = await replay(null, root, copied, events, 'candidate');
    const report = { mode: 'read-only-input/local-recording-sink', baseline, events,
      snapshotAt: new Date().toISOString(), before, after, actualMessagesSent: 0,
      limitation: 'Current copied ledger/graphs; source panes omitted. Not historical state or live daemon activation.' };
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ report: output, before: before.afterFirst, after: after.afterFirst,
      afterRestart: after.afterRestart, beforeNextTurns: before.afterSimulatedNextTurns,
      afterNextTurns: after.afterSimulatedNextTurns, actualMessagesSent: 0 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
