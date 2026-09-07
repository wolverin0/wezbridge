'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runGmailRoutine } = require('../scripts/gmail-recordatorios-run.cjs');
const identity = require('../src/pane-identity.cjs');
const queue = require('../src/project-queue.cjs');

function fixture(t, panes) {
  const intelDir = fs.mkdtempSync(path.join(os.tmpdir(), 't0339-target-'));
  t.after(() => { assert.equal(path.dirname(intelDir), os.tmpdir()); fs.rmSync(intelDir, { recursive: true, force: true }); });
  const promptFile = path.join(intelDir, 'prompt.txt');
  fs.writeFileSync(promptFile, '[rutina gmail-recordatorios] fixture; read the existing spec');
  const setup = path.join(intelDir, 'fake-cli.cjs');
  const cliRows = panes.map(p => ({ pane_id: p.paneId, cwd: p.project, title: p.tabTitle, tab_title: p.tabTitle }));
  fs.writeFileSync(setup, `const cp=require('node:child_process'); const original=cp.execFileSync;
    cp.execFileSync=function(file,args,opts){if(file==='t0339-fake-cli')return ${JSON.stringify(JSON.stringify(cliRows))};return original.apply(this,arguments)};`);
  const calls = [], resolutions = [];
  const deps = { env: { ...process.env, WEZTERM_BIN: 't0339-fake-cli', NODE_OPTIONS: `--require=${setup.replaceAll('\\', '/')}` },
    discover: () => panes, resolve: (...args) => { resolutions.push(args[0]); return identity.resolve(...args); },
    enqueue: queue.enqueue,
    send: { paneComposerHoldsForeignText: () => false,
      sendPromptDeferredEnter: async (pane, text) => { calls.push({ pane, text }); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted' } };
  return { intelDir, promptFile, runId: 'fixture-' + Date.now(), deps, calls, resolutions };
}

const pane = (paneId, project, tabTitle, status = 'idle') => ({ paneId, project, tabTitle, status, agent: 'codex' });

test('T-0339 refusal race never submits operator text and preserves the retry', async t => {
  const f = fixture(t, [pane(91, 'G:/apps/wezbridge', '')]);
  f.deps.send.sendPromptDeferredEnter = async () => ({ refused: 'composer-foreign-text' });
  let enters = 0;
  f.deps.send.verifyPromptSubmission = async () => { enters++; return 'submitted'; };
  const result = await runGmailRoutine(f, f.deps);
  assert.equal(enters, 0, 'a refused write must never trigger Enter');
  assert.equal(result.queued, true);
  assert.notEqual(result.exit_status, 0);
});

for (const broken of [false, true]) {
  test(`T-0339 composer ${broken ? 'inspection error' : 'occupied'} keeps a durable retry`, async t => {
    const f = fixture(t, [pane(91, 'G:/apps/wezbridge', '')]);
    f.deps.send.paneComposerHoldsForeignText = () => { if (broken) throw new Error('unavailable'); return true; };
    const result = await runGmailRoutine(f, f.deps);
    assert.equal(f.calls.length, 0);
    assert.equal(result.queued, true);
  });
}

test('T-0339 AC1 killer: renamed and renumbered hub resolves by cwd through the existing A2A resolver', async t => {
  const f = fixture(t, [pane(91, 'file:///G:/apps/wezbridge/', ''), pane(8, 'G:/apps/other', 'wezbridge')]);
  const result = await runGmailRoutine(f, f.deps);
  assert.equal(result.exit_status, 0, 'empty mutable tab label must not lose the real hub');
  assert.deepEqual(f.resolutions, ['wezbridge']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].pane, 91);
  const queued = JSON.parse(fs.readFileSync(queue.queueFile('wezbridge', f.intelDir), 'utf8').trim());
  assert.equal(queued.ok, true);
  assert.equal(queued.resolved_pane, 91);
  assert.equal(queued.from_project, 'gmail-recordatorios');
});

for (const [name, panes] of [
  ['missing hub', []],
  ['misleading foreign title', [pane(8, 'G:/apps/other', 'wezbridge')]],
  ['ambiguous hubs', [pane(90, 'G:/apps/wezbridge', ''), pane(91, 'G:/apps/wezbridge', 'renamed')]],
  ['busy hub', [pane(91, 'G:/apps/wezbridge', '', 'working')]],
]) {
  test(`T-0339 AC1 control: ${name} leaves a durable queue entry without typing into a pane`, async t => {
    const f = fixture(t, panes);
    const result = await runGmailRoutine(f, f.deps);
    assert.equal(f.calls.length, 0);
    assert.equal(result.queued, true);
    assert.ok(fs.existsSync(queue.queueFile('wezbridge', f.intelDir)));
    assert.notEqual(result.phase, 'completed');
  });
}
