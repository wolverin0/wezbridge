'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const file=path.resolve(__dirname,'../scripts/poke-pane.cjs');
const source=(process.env.POKE_AUDIT_BASE_REF
  ? require('node:child_process').execFileSync('git',['show',process.env.POKE_AUDIT_BASE_REF+':scripts/poke-pane.cjs'],{cwd:path.dirname(file),encoding:'utf8'})
  : fs.readFileSync(file,'utf8')).replace(/^#![^\n]*\n/,'');
const payload='[ORQUESTADOR | corr=learning-test | type=request] private-body-not-for-logs';
function run({blocked=false,auditFails=false,finalAuditFails=false}={}) {
  const records=[],writes=[],logs=[];
  const module={exports:{}};
  const real=createRequire(file);
  const req=name=>{
    if(name==='../src/action-log.cjs')return{logAction:(action,fields)=>{records.push({action,...fields});return !auditFails && !(finalAuditFails && records.length>1);}};
    if(name==='fs')return{...fs,readdirSync:()=>[]};
    if(name==='child_process')return{execFileSync:(_bin,args,opts)=>{
      if(args.includes('list'))return JSON.stringify([{pane_id:10,cwd:'/fixture/wabot',tab_title:'wabot'}]);
      if(args.includes('get-text'))return blocked ? '> operator draft' : writes.length===1 ? '> '+payload : '> ';
      if(args.includes('send-text')){writes.push(opts.input);return '';}
      throw Error('unexpected IO');
    }};
    return real(name);
  };
  req.main=module;
  const proc={platform:'linux',env:{WEZTERM_BIN:'fake'},argv:['node',file,'--project','wabot','--text',payload],
    exit:status=>{throw Object.assign(Error('exit'),{status});}};
  const fn=vm.runInNewContext(`(function(require,module,__dirname){${source}\n})`,
    {process:proc,console:{log:s=>logs.push(s)},Atomics:{wait:()=>0}});
  let status=0;
  try{fn(req,module,path.dirname(file));}catch(e){if(e.status===undefined)throw e;status=e.status;}
  return{records,writes,logs,status};
}
test('manual poke successful submission has joined durable attempt and result without body',()=>{
  const r=run();
  assert.equal(r.status,0);
  assert.equal(r.records.length,2);
  assert.equal(r.records[0].extra.attempt_id,r.records[1].extra.attempt_id);
  assert.equal(r.records[1].extra.outcome,'submitted');
  assert.equal(r.records[1].corr,'learning-test');
  assert.equal(r.records[1].target,'pane-10');
  assert.ok(!JSON.stringify(r.records).includes('private-body-not-for-logs'));
});
test('composer refusal is recorded without sending',()=>{
  const r=run({blocked:true});
  assert.equal(r.status,10);
  assert.equal(r.writes.length,0);
  assert.equal(r.records.at(-1)?.extra.exit_code,10);
  assert.equal(r.records.at(-1)?.extra.outcome,'failed');
});
test('unwritable attempt audit refuses before terminal side effects',()=>{
  const r=run({auditFails:true});
  assert.equal(r.status,12);
  assert.equal(r.writes.length,0);
  assert.match(r.logs.join('\n'),/AUDIT_FAILED/);
});
test('audit failure after a sent message is loud but does not request replay',()=>{
  const r=run({finalAuditFails:true});
  assert.equal(r.status,0);
  assert.equal(r.writes.length,2);
  assert.match(r.logs.join('\n'),/AUDIT_FAILED.*do not infer delivery or replay automatically/);
});
