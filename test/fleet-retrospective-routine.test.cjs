'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {auditRegisteredRoutines}=require('../scripts/routine-registry.cjs');
test('weekly retrospective uses existing missing-run gate, not a new timer',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-retro-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  fs.mkdirSync(path.join(base,'routines'));
  const at=Date.parse('2026-09-14T14:37:30.681Z'),week=168*3600000;
  fs.writeFileSync(path.join(base,'routines/fleet-retrospective.json'),JSON.stringify({
    routine:'fleet-retrospective',repo:'wezbridge',task:'T-0469',cadence_hours:168,registered_at:new Date(at).toISOString(),enabled:true}));
  assert.equal(auditRegisteredRoutines(base,[],at+week-1).length,0);
  assert.equal(auditRegisteredRoutines(base,[],at+week+1)[0].category,'routine-void');
  const run={routine:'fleet-retrospective',repo:'wezbridge',at_ms:at+week};
  assert.equal(auditRegisteredRoutines(base,[run],at+week+1).length,0);
  assert.equal(auditRegisteredRoutines(base,[run],at+2*week+1).length,1);
});
