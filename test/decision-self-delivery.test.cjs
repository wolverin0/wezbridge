'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendRuling } = require('../src/rulings.cjs');
// T-0599: this file exercises the WezTerm-pane busy/idle census gating
// (gateDelivery's pane-busy/wrong-pane/wrong-cwd deferrals), which only
// exists on the legacy WezTerm path now that Orca is the default transport
// (see src/decision-relay.cjs). Without this, the default Orca path would
// try to resolve a REAL Orca terminal in tests (no busy-pane concept there).
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const { createRelay } = require('../src/decision-relay.cjs');
const { auditDecisions } = require('../scripts/fleet-steward.cjs');
const discovery = require('../src/pane-discovery.cjs');
const at = '2026-09-12T21:25:39.612Z';
const now = Date.parse(at);

async function scenario(t, source, {pane = 10, cwdMatches = true, eve = false, receiptFails = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't0460-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const intel = path.join(root, '_intel'), repo = path.join(root, 'whatsappbot-final');
  fs.mkdirSync(path.join(intel, 'tasks'), {recursive: true});
  fs.mkdirSync(repo);
  if (receiptFails) fs.mkdirSync(path.join(intel,'events.jsonl'));
  fs.writeFileSync(path.join(intel, 'tasks/T-0457.json'), JSON.stringify({id:'T-0457',
    repo:'whatsappbot-final',state:'ready',lease:eve ? {owner:'eve:job'} : null}));
  const panes = [{paneId:10,project:repo,agent:'claude',verified:true,status:'working',lastLines:'busy'}];
  t.mock.method(process, 'cwd', () => cwdMatches ? repo : root);
  const before = process.env.WEZTERM_PANE;
  process.env.WEZTERM_PANE = String(pane);
  t.after(() => { if(before === undefined) delete process.env.WEZTERM_PANE; else process.env.WEZTERM_PANE=before; });
  t.mock.method(discovery, 'discoverRoutingPanes', () => panes);
  appendRuling(intel, {task:'T-0457',category:null,ruling:'approved',source,
    why:'Operator approved scheduler from owning pane',at}, {now});
  let sends=0;
  const relay = createRelay({intelDir:intel,discoverPanes:()=>panes,now:()=>now+60000,
    send:{sendPromptDeferredEnter:async()=>{sends++;throw Error('unexpected send');}}});
  const result = await relay.relayOnce();
  return {intel,result,sends,relay};
}

test('T0457 writer in owning busy pane is heard at +7h without self queue', async t => {
  const s = await scenario(t,'orchestrator-pane');
  assert.equal(auditDecisions(s.intel,now+7*3600000).length,0);
  assert.equal(s.result.delivered.length,1);
  assert.equal(s.result.queued.length,0);
  assert.equal(s.sends,0);
  assert.equal(fs.existsSync(path.join(s.intel,'queues/whatsappbot-final.jsonl')),false);
  assert.equal((await s.relay.relayOnce()).delivered.length,0);
});
for(const [name,source,opts] of [
  ['board busy','board-app',{}], ['wrong pane','orchestrator-pane',{pane:99}],
  ['wrong cwd','orchestrator-pane',{cwdMatches:false}], ['Eve owns work','orchestrator-pane',{eve:true}],
  ['receipt write fails','orchestrator-pane',{receiptFails:true}],
]) test(name+' still needs delivery',async t=>{
  const s=await scenario(t,source,opts);
  assert.equal(auditDecisions(s.intel,now+7*3600000).length,1);
  assert.equal(s.result.delivered.length,0);
});

test('self receipt never covers a newer decision', async t => {
  const s = await scenario(t,'orchestrator-pane');
  const {hasSelfDelivery} = require('../src/decision-self-delivery.cjs');
  const entry={task:'T-0457',ruling:'approved',source:'orchestrator-pane',at};
  assert.equal(hasSelfDelivery(s.intel,entry,'whatsappbot-final'),true);
  for (const change of [{at:'2026-09-12T21:26:00Z'},{ruling:'cancelled'},{source:'board-app'},{task:'T-0446'}]) {
    assert.equal(hasSelfDelivery(s.intel,{...entry,...change},'whatsappbot-final'),false);
  }
  assert.equal(hasSelfDelivery(s.intel,entry,'reparto'),false);
});

for (const source of ['orchestrator-pane', 'ledger-cli']) {
  test('AC3 prospective: repeated new decisions from ' + source + ' remain heard', async t => {
    const s = await scenario(t, source);
    for (let index = 1; index <= 12; index++) {
      const time = now + index * 1000;
      appendRuling(s.intel, {task:'T-0457', ruling:index % 2 ? 'cancelled' : 'approved',
        source, why:'Isolated prospective regression', at:new Date(time).toISOString()}, {now:time});
      const result = await s.relay.relayOnce();
      assert.equal(result.queued.length, 0);
      assert.equal(result.delivered.length, 1);
      assert.equal(auditDecisions(s.intel, time + 7 * 3600000).length, 0);
    }
    const events = fs.readFileSync(path.join(s.intel, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse).filter(e => e.delivery === 'self');
    assert.equal(events.length, 13);
    assert.equal(s.sends, 0);
  });
}
