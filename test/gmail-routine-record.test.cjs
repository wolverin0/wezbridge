'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runGmailRoutine, completeGmailRun } = require('../scripts/gmail-recordatorios-run.cjs');

function fixture(t) {
  const intelDir = fs.mkdtempSync(path.join(os.tmpdir(), 't0339-run-'));
  t.after(() => { assert.equal(path.dirname(intelDir), os.tmpdir()); fs.rmSync(intelDir, { recursive: true, force: true }); });
  const promptFile = path.join(intelDir, 'prompt.txt');
  fs.writeFileSync(promptFile, '[rutina gmail-recordatorios] fixture: no email access');
  const runId = 'fixture-' + Date.now();
  return { intelDir, promptFile, runId,
    record: path.join(intelDir, 'routine-findings', `run-gmail-recordatorios-${runId}.json`) };
}

test('T-0339 AC4 killer: a real failing poke leaves its nonzero exit and dated run record', async t => {
  const f = fixture(t);
  const result = await runGmailRoutine(f, { dispatch: () => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/poke-pane.cjs'),
      '--tab-title', 'wezbridge', '--project', 'wezbridge', '--file', f.promptFile], {
      windowsHide: true, encoding: 'utf8', env: { ...process.env,
        WEZTERM_BIN: path.join(f.intelDir, 'unavailable-wezterm.exe') },
    });
    return { exit_status: child.status };
  } });
  assert.notEqual(result.exit_status, 0, 'the legacy poke really failed');
  assert.ok(fs.existsSync(f.record), 'a failed scheduled poke must leave run-gmail-recordatorios-*.json');
  const record = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  assert.equal(record.exit_status, result.exit_status);
  assert.equal(record.dispatch_exit_status, result.exit_status);
  assert.equal(record.routine, 'gmail-recordatorios');
  assert.equal(record.repo, 'wezbridge');
  assert.ok(Number.isFinite(Date.parse(record.started_at)));
  assert.ok(Number.isFinite(Date.parse(record.ended_at)));
});

test('T-0339 AC4: a thrown dispatcher still leaves a failed run', async t => {
  const f = fixture(t);
  const result = await runGmailRoutine(f, { dispatch: () => { throw new Error('fixture transport failure'); } });
  assert.equal(result.exit_status, 1);
  assert.ok(fs.existsSync(f.record));
});

test('T-0339 AC4 control: submitted poke is not a completed Gmail routine', async t => {
  const f = fixture(t);
  await runGmailRoutine(f, { dispatch: () => ({ exit_status: 0, submitted: 'submitted', delivered: 'ok' }) });
  assert.ok(fs.existsSync(f.record));
  const record = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  const findings = JSON.parse(fs.readFileSync(path.join(path.dirname(f.record), record.findings_file), 'utf8'));
  assert.equal(record.exit_status, 0);
  assert.notEqual(record.phase, 'completed');
  assert.equal(findings.verdict, 'void', 'delivery alone cannot clear the routine audit');
});

test('T-0339: verified execution counts complete a run while preserving its failed dispatch exit', async t => {
  const f = fixture(t);
  await runGmailRoutine(f, { dispatch: () => ({ exit_status: 4, queued: true }) });
  assert.throws(() => completeGmailRun(f), /execution counts/);
  const counts = { seen: 4, created: 1, existing: 2, doubtful: 1 };
  const result = completeGmailRun({ ...f, counts });
  assert.equal(result.phase, 'completed');
  assert.equal(result.exit_status, 0);
  assert.equal(result.dispatch_exit_status, 4, 'the original dispatch failure stays visible');
  const bytes = fs.readFileSync(f.record);
  completeGmailRun({ ...f, counts });
  assert.deepEqual(fs.readFileSync(f.record), bytes, 'duplicate completion has no write effect');
  assert.throws(() => completeGmailRun({ ...f, failure: 'later error' }), /immutable/);
});

test('T-0339: an execution error stays void and run identifiers cannot escape the artifact directory', async t => {
  const f = fixture(t);
  await runGmailRoutine(f, { dispatch: () => ({ exit_status: 0 }) });
  const result = completeGmailRun({ ...f, failure: 'Gmail unavailable' });
  assert.equal(result.exit_status, 1);
  assert.equal(result.phase, 'execution_failed');
  const findings = JSON.parse(fs.readFileSync(path.join(path.dirname(f.record), result.findings_file), 'utf8'));
  assert.equal(findings.verdict, 'void');
  await assert.rejects(runGmailRoutine({ ...f, runId: '../escape' }), /invalid run/);
  assert.throws(() => completeGmailRun({ ...f, runId: '../escape', failure: 'x' }), /invalid run/);
});

test('T-0339 P1 killer: a run completed DURING dispatch is not clobbered back to dispatched/void', async t => {
  const f = fixture(t);
  const counts = { seen: 3, created: 1, existing: 1, doubtful: 0 };
  const result = await runGmailRoutine(f, { dispatch: () => {
    completeGmailRun({ intelDir: f.intelDir, runId: f.runId, counts });
    return { exit_status: 0, transport: 'fixture' };
  } });
  const record = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  const findings = JSON.parse(fs.readFileSync(path.join(path.dirname(f.record), record.findings_file), 'utf8'));
  assert.equal(record.phase, 'completed', 'completion written during dispatch must survive the finally block');
  assert.equal(findings.verdict, 'clean');
  assert.deepEqual(findings.counts, counts);
  assert.deepEqual(record.counts, counts);
  assert.equal(record.exit_status, 0);
  assert.equal(record.dispatch_exit_status, 0);
  assert.equal(record.transport, 'fixture', 'dispatch transport fields are still merged');
  assert.ok(Number.isFinite(Date.parse(record.ended_at)));
  assert.equal(result.phase, 'completed');
});

test('T-0339 P1 control: an execution_failed written during a failing dispatch keeps its failure and the dispatch exit', async t => {
  const f = fixture(t);
  await runGmailRoutine(f, { dispatch: () => {
    completeGmailRun({ intelDir: f.intelDir, runId: f.runId, failure: 'Gmail unavailable' });
    return { exit_status: 4 };
  } });
  const record = JSON.parse(fs.readFileSync(f.record, 'utf8'));
  const findings = JSON.parse(fs.readFileSync(path.join(path.dirname(f.record), record.findings_file), 'utf8'));
  assert.equal(record.phase, 'execution_failed');
  assert.equal(record.exit_status, 1);
  assert.equal(record.dispatch_exit_status, 4);
  assert.equal(findings.void_reason, 'Gmail unavailable', 'the execution reason is not replaced by a dispatch reason');
});
