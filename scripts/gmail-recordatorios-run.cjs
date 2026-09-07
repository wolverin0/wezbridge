'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { dispatchGmailRoutine } = require('../src/gmail-routine-dispatch.cjs');

async function runGmailRoutine(options, dependencies = {}) {
  const dispatch = dependencies.dispatch || (opts => dispatchGmailRoutine(opts, dependencies));
  const runId = options.runId || randomUUID();
  if (!/^[a-zA-Z0-9._-]{1,44}$/.test(runId)) throw new Error('invalid run id');
  const dir = path.join(options.intelDir, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, `run-gmail-recordatorios-${runId}.json`);
  if (fs.existsSync(recordFile)) throw new Error('run id already exists');
  const record = { routine: 'gmail-recordatorios', repo: 'wezbridge', task: 'T-0339', run_id: runId,
    cadence_hours: 24, started_at: new Date().toISOString(), ended_at: null,
    exit_status: 1, dispatch_exit_status: null, phase: 'dispatching',
    findings_file: `gmail-recordatorios-${runId}.json` };
  writeJson(path.join(dir, record.findings_file), { verdict: 'void', void_reason: 'dispatch started; Gmail execution not yet verified' });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), { flag: 'wx' });
  let outcome;
  try { outcome = await dispatch({ ...options, runId }); }
  catch (error) { outcome = { exit_status: 1, error: String(error.message || error).slice(0, 240) }; }
  finally {
    const exit = Number.isInteger(outcome?.exit_status) ? outcome.exit_status : 1;
    outcome = { ...record, ...outcome, ended_at: new Date().toISOString(),
      exit_status: exit, dispatch_exit_status: exit, phase: exit ? 'dispatch_failed' : outcome?.queued ? 'queued' : 'dispatched' };
    writeJson(path.join(dir, record.findings_file), { verdict: 'void',
      void_reason: exit ? `dispatch exited ${exit}; Gmail execution not verified` : 'dispatch accepted; Gmail execution not yet verified' });
    writeJson(recordFile, outcome);
  }
  return outcome;
}

function writeJson(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

function completeGmailRun({ intelDir, runId, counts, failure }) {
  if (!/^[a-zA-Z0-9._-]{1,44}$/.test(runId || '')) throw new Error('invalid run id');
  if (!failure && (!counts || !['seen', 'created', 'existing', 'doubtful'].every(k =>
    Number.isInteger(counts[k]) && counts[k] >= 0)
    || counts.created + counts.existing + counts.doubtful > counts.seen)) throw new Error('valid execution counts required');
  const dir = path.join(intelDir, 'routine-findings');
  const file = path.join(dir, `run-gmail-recordatorios-${runId}.json`);
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  const findingsName = `gmail-recordatorios-${runId}.json`;
  if (prior.routine !== 'gmail-recordatorios' || prior.repo !== 'wezbridge'
    || prior.run_id !== runId || prior.findings_file !== findingsName) throw new Error('run identity mismatch');
  if (prior.phase === 'completed') {
    if (!failure && JSON.stringify(prior.counts) === JSON.stringify(counts)) return prior;
    throw new Error('completed run is immutable; create a new run');
  }
  const record = { ...prior, phase: failure ? 'execution_failed' : 'completed',
    exit_status: failure ? 1 : 0, completed_at: new Date().toISOString(), counts: counts || null };
  const findings = failure ? { verdict: 'void', void_reason: String(failure).slice(0, 240) }
    : { verdict: 'clean', counts };
  writeJson(path.join(dir, findingsName), findings);
  writeJson(file, record);
  return record;
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || 'run';
  const value = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const intelDir = value('--intel-dir') || process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
  let result;
  if (mode === 'run' || mode === 'manual') {
    const options = { intelDir, runId: value('--run'),
      promptFile: value('--file') || path.join(intelDir, 'routines/gmail-recordatorios-poke.txt') };
    result = await runGmailRoutine(options, mode === 'manual'
      ? { dispatch: () => ({ exit_status: 0, mode: 'manual', reason: 'explicit local execution; no transport claimed' }) } : {});
  } else if (mode === 'complete' || mode === 'fail') {
    const counts = Object.fromEntries(['seen', 'created', 'existing', 'doubtful'].map(k => [k, Number(value('--' + k))]));
    if (mode === 'fail' && !value('--reason')) throw new Error('fail requires --reason');
    result = completeGmailRun({ intelDir, runId: value('--run'), counts: mode === 'complete' ? counts : undefined,
      failure: mode === 'fail' ? value('--reason') : undefined });
  } else throw new Error('usage: run|manual|complete|fail');
  console.log(JSON.stringify(result));
  process.exitCode = result.exit_status;
}

module.exports = { runGmailRoutine, completeGmailRun };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
