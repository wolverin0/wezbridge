'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { dispatchGmailRoutine } = require('../src/gmail-routine-dispatch.cjs');
const headless = require('../src/gmail-routine-headless.cjs');

// Exit codes owned by the runner (dispatchers own 1-8).
const EXIT_OVERLAP = 9;              // another run is still dispatching; nothing spawned
const EXIT_COMPLETION_UNVERIFIED = 10; // headless completed without a single Gmail search

// Library default stays `pane` (the AC1 tests and any caller without a transport); the CLI `run`
// defaults to headless. See resolveVia.
function defaultDispatch(via, dependencies) {
  if (via === 'headless') return opts => headless.dispatchGmailHeadless(opts, dependencies);
  return opts => dispatchGmailRoutine(opts, dependencies);
}

function liveOverlap(dir, windowMs, now = Date.now()) {
  for (const name of fs.readdirSync(dir)) {
    if (!/^run-gmail-recordatorios-.+\.json$/.test(name)) continue;
    const other = readRecord(path.join(dir, name));
    const age = now - Date.parse(other?.started_at);
    if (other?.phase === 'dispatching' && age >= 0 && age < windowMs) return other.run_id;
  }
  return null;
}

async function runGmailRoutine(options, dependencies = {}) {
  const via = options.via || 'pane';
  if (!['pane', 'headless'].includes(via)) throw new Error('via must be pane|headless');
  const dispatch = dependencies.dispatch || defaultDispatch(via, dependencies);
  const runId = options.runId || randomUUID();
  if (!/^[a-zA-Z0-9._-]{1,44}$/.test(runId)) throw new Error('invalid run id');
  const dir = path.join(options.intelDir, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, `run-gmail-recordatorios-${runId}.json`);
  if (fs.existsSync(recordFile)) throw new Error('run id already exists');
  const overlapping = liveOverlap(dir, options.overlapWindowMs ?? headless.HEADLESS_TIMEOUT_MS + headless.HEADLESS_GRACE_MS);
  const record = { routine: 'gmail-recordatorios', repo: 'wezbridge', task: 'T-0339', run_id: runId,
    cadence_hours: 24, started_at: new Date().toISOString(), ended_at: null,
    exit_status: 1, dispatch_exit_status: null, phase: 'dispatching', via,
    findings_file: `gmail-recordatorios-${runId}.json` };
  if (overlapping) {
    // P5: a second trigger while a run is live gets its own record and spawns nothing.
    const skipped = { ...record, phase: 'skipped_overlap', exit_status: EXIT_OVERLAP,
      overlapping_run: overlapping, ended_at: new Date().toISOString() };
    writeJson(path.join(dir, record.findings_file), { verdict: 'void', void_reason: `run ${overlapping} still dispatching; not started` });
    fs.writeFileSync(recordFile, JSON.stringify(skipped, null, 2), { flag: 'wx' });
    return skipped;
  }
  writeJson(path.join(dir, record.findings_file), { verdict: 'void', void_reason: 'dispatch started; Gmail execution not yet verified' });
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), { flag: 'wx' });
  let outcome;
  try { outcome = await dispatch({ ...options, runId, recordFile }); }
  catch (error) { outcome = { exit_status: 1, error: String(error.message || error).slice(0, 240) }; }
  const exit = Number.isInteger(outcome?.exit_status) ? outcome.exit_status : 1;
  const current = readRecord(recordFile);
  if (current && FINAL_PHASES.has(current.phase)) {
    // P1: complete/fail ran DURING dispatch (headless does exactly that). The execution
    // result owns phase/exit/counts/findings; the dispatch only adds its own fields.
    const transport = Object.fromEntries(Object.entries(outcome || {}).filter(([k]) => !EXECUTION_FIELDS.has(k)));
    outcome = { ...current, ...transport, dispatch_exit_status: exit, ended_at: new Date().toISOString() };
    if (outcome.transport === 'headless' && outcome.phase === 'completed'
      && !(outcome.gmail_tool_calls?.[headless.GMAIL_SEARCH_TOOL] > 0)) {
      // P3: counts reported without a single Gmail search are not evidence of a clean run.
      outcome = { ...outcome, exit_status: EXIT_COMPLETION_UNVERIFIED, completion_verified: false };
      writeJson(path.join(dir, record.findings_file), { verdict: 'void', void_reason: 'completion sin consulta a Gmail' });
    }
    writeJson(recordFile, outcome);
    return outcome;
  }
  outcome = { ...record, ...outcome, ended_at: new Date().toISOString(),
    exit_status: exit, dispatch_exit_status: exit, phase: exit ? 'dispatch_failed' : outcome?.queued ? 'queued' : 'dispatched' };
  writeJson(path.join(dir, record.findings_file), { verdict: 'void',
    void_reason: exit ? `dispatch exited ${exit}; Gmail execution not verified` : 'dispatch accepted; Gmail execution not yet verified' });
  writeJson(recordFile, outcome);
  return outcome;
}

// Written only by completeGmailRun; a dispatch outcome never overrides them.
const FINAL_PHASES = new Set(['completed', 'execution_failed']);
const EXECUTION_FIELDS = new Set(['routine', 'repo', 'task', 'run_id', 'cadence_hours', 'started_at', 'findings_file',
  'phase', 'exit_status', 'dispatch_exit_status', 'counts', 'completed_at', 'ended_at']);

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
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
    const options = { intelDir, runId: value('--run'), via: resolveVia(argv),
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

/** CLI transport: `--via pane|headless`, else GMAIL_ROUTINE_VIA, else headless (T-0339: pane discovery is WezTerm-only). */
function resolveVia(argv, env = process.env) {
  const i = argv.indexOf('--via');
  const via = (i < 0 ? undefined : argv[i + 1]) || env.GMAIL_ROUTINE_VIA || 'headless';
  if (!['pane', 'headless'].includes(via)) throw new Error('--via must be pane|headless');
  return via;
}

module.exports = { runGmailRoutine, completeGmailRun, resolveVia, main, EXIT_OVERLAP, EXIT_COMPLETION_UNVERIFIED };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
