'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// T-0596 item 4: legacy WezTerm-pane queue delivery, gated off by default — opt in for this file.
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const queue = require('../src/project-queue.cjs');
const {auditRoutines} = require('../scripts/routine-audit.cjs');

for (const eligible of [1, 0, 2]) test('T0468 two panes with ' + eligible + ' eligible', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't0468-'));
  t.after(() => fs.rmSync(base, {recursive:true, force:true}));
  const panes = [10,220].map(paneId => ({paneId,agent:'claude',verified:true,
    status:'idle',project:'G:/x/whatsappbot-final'}));
  const sent = [];
  const entry = queue.enqueue({project:'whatsappbot-final',corr:'t0464-review-20260914',
    type:'result',body:'Review remains REQUEST_CHANGES',from_pane:94}, {base});
  const c = queue.createConsumer({base,project:'whatsappbot-final',cooldownMs:0,
    discoverPanes:()=>panes,
    readPaneText:id => (eligible === 2 || eligible === 1 && id === 220) ? '> ' : '> operator draft',
    send:{paneComposerHoldsForeignText:()=>false,
      sendPromptDeferredEnter:async id=>{sent.push(id);return 'ok';},
      verifyPromptSubmission:async()=> 'submitted'},logAction:()=>{}});
  await c.drain();
  await c.drain();
  if (eligible === 1) {
    assert.deepEqual(sent,[220]);
    assert.equal(c.status().pending,0);
  } else {
    assert.deepEqual(sent,[]);
    assert.equal(c.status().pending,1);
    const pending=JSON.parse(fs.readFileSync(path.join(base,'queues/state/whatsappbot-final/pending.json')));
    assert.equal(pending[entry.id].attempts,0);
    const findings = auditRoutines(base,Date.now());
    assert.ok(findings.some(f=>f.category==='routine-findings' && /queue.*whatsappbot-final/.test(f.title)));
  }
});

test('T0468 preflight refuses operator questions, unknown reads and foreign input; accepts placeholder animation', () => {
  const {selectAvailable} = require('../src/queue-route.cjs');
  const panes = [10,220].map(paneId=>({paneId,status:'idle',verified:true}));
  const menu = '> 1. Sync now\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel';
  assert.equal(selectAvailable(panes,id=>id===10?menu:'> Ask Codex to do anything ⠁').paneId,220);
  assert.equal(selectAvailable(panes,()=>menu).reason,'none-eligible');
  assert.equal(selectAvailable(panes,()=>{throw Error('unreadable');}).reason,'none-eligible');
  assert.equal(selectAvailable(panes,()=>'> operator draft').reason,'none-eligible');
  assert.equal(selectAvailable(panes,()=>'>\nUsage limit reached - continuing automatically tomorrow').reason,'none-eligible');
});

test('T0468 repeated blockage preserves age and later delivery clears finding', async t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'t0468-resume-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  let available=false;
  const c=queue.createConsumer({base,project:'whatsappbot-final',cooldownMs:0,
    discoverPanes:()=>[10,220].map(paneId=>({paneId,agent:'claude',status:'idle',project:'G:/x/whatsappbot-final'})),
    readPaneText:id=>available && id===220 ? '> ' : '> operator draft',
    send:{sendPromptDeferredEnter:async()=> 'ok',verifyPromptSubmission:async()=> 'submitted'},logAction:()=>{}});
  queue.enqueue({project:'whatsappbot-final',corr:'resume-test',body:'bounded review',type:'request'},{base});
  await c.drain();
  const file=path.join(base,'routine-findings/run-queue-route-whatsappbot-final.json');
  const before=fs.statSync(file).mtimeMs;
  await c.drain();
  assert.equal(fs.statSync(file).mtimeMs,before);
  available=true;
  await c.drain();
  assert.equal(c.status().pending,0);
  assert.equal(auditRoutines(base,Date.now()).length,0);
});
