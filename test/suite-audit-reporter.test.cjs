'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const {auditRoutines}=require('../scripts/routine-audit.cjs');
test('T0470 a failing real Node suite exits nonzero and surfaces in steward without result prose',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'t0470-suite-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fixture=path.join(root,'probe.test.cjs');
  fs.writeFileSync(fixture,"require('node:test')('known failure',()=>{throw Error('expected probe');});");
  const reporter=pathToFileURL(path.resolve(__dirname,'../scripts/suite-audit-reporter.cjs')).href;
  const env={...process.env,WEZBRIDGE_INTEL_DIR:root};
  delete env.NODE_TEST_CONTEXT; // This is a fresh outer runner, not another worker of our parent.
  const red=spawnSync(process.execPath,['--test','--test-reporter='+reporter,fixture],{env,encoding:'utf8',timeout:20000});
  assert.notEqual(red.status,0);
  const findings=auditRoutines(root,Date.now());
  assert.ok(findings.some(f=>f.category==='routine-void' && /suite/.test(f.title)),red.stderr);
  const reports=fs.readdirSync(path.join(root,'routine-findings')).filter(n=>n.startsWith('suite-'));
  const report=JSON.parse(fs.readFileSync(path.join(root,'routine-findings',reports[0])));
  assert.equal(report.counts.failed,1);
  fs.writeFileSync(fixture,"require('node:test')('known success',()=>{});");
  const green=spawnSync(process.execPath,['--test','--test-reporter='+reporter,fixture],{env,encoding:'utf8',timeout:20000});
  assert.equal(green.status,0,green.stderr);
  const latest=JSON.parse(fs.readFileSync(path.join(root,'routine-findings/suite-wezbridge-latest.json')));
  assert.equal(latest.counts.failed,0);
  assert.equal(latest.counts.passed,1);
  assert.ok(auditRoutines(root,Date.now()).some(f=>f.category==='routine-void'),'later success cannot erase recorded failure evidence');
});

test('T0470 fail count overrides a success label; missing aggregate cannot be green',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'t0470-summary-'));
  const oldDir=process.env.WEZBRIDGE_INTEL_DIR,oldExit=process.exitCode;
  process.env.WEZBRIDGE_INTEL_DIR=base;
  t.after(()=>{if(oldDir===undefined)delete process.env.WEZBRIDGE_INTEL_DIR;else process.env.WEZBRIDGE_INTEL_DIR=oldDir;process.exitCode=oldExit;fs.rmSync(base,{recursive:true,force:true});});
  const reporter=require('../scripts/suite-audit-reporter.cjs');
  for(const events of [[],[{type:'test:summary',data:{success:true,counts:{tests:1,passed:0,failed:1,cancelled:0,skipped:0}}}]]) {
    process.exitCode=0;
    const output=[];
    for await(const line of reporter(events))output.push(line);
    assert.equal(process.exitCode,1);
    assert.match(output.join(''),/RED/);
  }
});
