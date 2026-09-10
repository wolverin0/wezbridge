'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { companionsRoot } = require('./helpers/companions.cjs');
const linker = require('../src/result-linker.cjs');

const LINE = Object.freeze({ time: '2026-09-06T22:00:00Z', event: 'a2a.result',
  corr: 'r8-receipt-fixture', from_pane: 7, v2: 'ok',
  body: 'FinalOrchestra JOB-fixture: COMPLETED\ncriteria:\n- AC1: pass — fixture evidence' });
const initialCard = () => ({ id: 'T-9998', title: 'isolated R8 fixture', goal: 'recover receipt',
  repo: 'wezbridge', kind: 'tooling-fix', state: 'running', blocked_by: 'agent',
  corr: LINE.corr, acceptance_criteria: ['one effect and released lease'],
  lease: { owner: 'eve:JOB-fixture', expires_at: '2099-01-01T00:00:00Z' } });

function memoryFixture(overrides = {}) {
  let card = { ...initialCard(), ...overrides };
  const calls = [];
  const events = [];
  const runLedger = args => {
    calls.push(args[0]);
    card = args[0] === 'release' ? { ...card, lease: null } : { ...card,
      state: args[args.indexOf('--state') + 1],
      evaluator_evidence: args[args.indexOf('--evidence') + 1] };
  };
  return { calls, events, card: () => card,
    deps: { readTasks: () => [card], runLedger, recordEvent: e => events.push(e) } };
}

test('R8 killer: replay completes the lease release after a durable update lost its response', () => {
  const f = memoryFixture();
  const failed = linker.link(LINE, { ...f.deps, runLedger: args => {
    f.deps.runLedger(args);
    throw new Error('interrupted after persisted update');
  } });
  assert.equal(failed.reason, 'ledger-error');
  assert.equal(f.card().state, 'review');
  assert.ok(f.card().lease);
  const replay = linker.link(LINE, f.deps);
  assert.equal(replay.reason, 'already-linked');
  assert.equal(f.card().lease, null, 'completed work cannot retain the departed executor lease');
  assert.deepEqual(f.calls, ['update', 'release'], 'receipt transition is never repeated');
  linker.link(LINE, f.deps);
  assert.deepEqual(f.calls, ['update', 'release'], 'a third delivery has no effect');
});

for (const [name, overrides] of [
  ['reopened work', { state: 'running' }],
  ['another result sharing only the timestamp', { evaluator_evidence: `a2a-results.jsonl#time=${LINE.time} corr=other from=pane-7 v2=ok` }],
  ['a different executor acquired the lease', { lease: { owner: 'eve:JOB-new' } }],
]) {
  test(`R8 control: an old receipt never releases ${name}`, () => {
    const f = memoryFixture({ state: 'review', evaluator_evidence: linker.evidencePointer(LINE), ...overrides });
    linker.link(LINE, f.deps);
    assert.ok(f.card().lease);
    assert.deepEqual(f.calls, []);
  });
}

for (const [name, result, state, owner] of [
  ['blocked job', { ...LINE, body: 'FinalOrchestra JOB-fixture: BLOCKED\ncriteria:\n- AC1: fail — fixture' }, 'blocked', 'eve:JOB-fixture'],
  ['pane result', { ...LINE, body: 'criteria:\n- AC1: pass — fixture' }, 'review', 'pane-7'],
]) {
  test(`R8 control: replay releases the matching departed executor for ${name}`, () => {
    const f = memoryFixture({ state, lease: { owner }, evaluator_evidence: linker.evidencePointer(result) });
    linker.link(result, f.deps);
    assert.equal(f.card().lease, null);
    assert.deepEqual(f.calls, ['release']);
  });
}

test('R8: a failed replay release remains visible and a later replay can finish it', () => {
  const f = memoryFixture({ state: 'review', evaluator_evidence: linker.evidencePointer(LINE) });
  linker.link(LINE, { ...f.deps, runLedger: () => { throw new Error('fixture release unavailable'); } });
  assert.ok(f.events.some(e => e.event === 'result.lease_not_released'));
  assert.ok(f.card().lease);
  linker.link(LINE, f.deps);
  assert.equal(f.card().lease, null);
});

const companions = companionsRoot();
const required = ['_docs-curation/ledger.cjs', '_docs-curation/sweeper-config.json', '_intel/kinds.json'];
const missing = required.filter(name => !fs.existsSync(path.join(companions, name)));

function diskFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r8-consumer-crash-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  for (const name of required) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(companions, name), target);
  }
  const intel = path.join(root, '_intel');
  fs.mkdirSync(path.join(intel, 'tasks'));
  fs.mkdirSync(path.join(intel, '.result-link'));
  fs.writeFileSync(path.join(intel, 'tasks/T-9998.json'), JSON.stringify(initialCard()));
  fs.writeFileSync(path.join(intel, 'a2a-results.jsonl'), JSON.stringify(LINE) + '\n');
  fs.writeFileSync(path.join(intel, '.result-link/cursor.json'), '{"bytes":0}');
  return { root, intel };
}

for (const alreadyLinked of [false, true]) {
  test(`R8 retry killer: real consumer retains cursor on release failure after ${alreadyLinked ? 'receipt replay' : 'first update'}`, {
    skip: missing.length ? `Requires canonical companions: ${missing.join(', ')}` : false,
  }, t => {
    const { root, intel } = diskFixture(t);
    if (alreadyLinked) fs.writeFileSync(path.join(intel, 'tasks/T-9998.json'), JSON.stringify({
      ...initialCard(), state: 'review', evaluator_evidence: linker.evidencePointer(LINE),
    }));
    fs.writeFileSync(path.join(intel, 'tasks/T-9997.json'), JSON.stringify({ ...initialCard(), id: 'T-9997', corr: 'r8-later' }));
    fs.appendFileSync(path.join(intel, 'a2a-results.jsonl'), JSON.stringify({ ...LINE, corr: 'r8-later' }) + '\n');
    const script = path.join(root, 'retry-consumer.cjs');
    fs.writeFileSync(script, `
      const path = require('node:path');
      const linker = require(path.join(process.env.R8_SOURCE_ROOT, 'src/result-linker.cjs'));
      const original = linker.defaultRunLedger;
      linker.defaultRunLedger = (args, dir) => {
        if (process.env.R8_RELEASE_FAIL === '1' && args[0] === 'release' && args[1] === 'T-9998') throw new Error('temporary release failure');
        return original(args, dir);
      };
      console.log(JSON.stringify(require(path.join(process.env.R8_SOURCE_ROOT, 'scripts/result-link.cjs')).runOnce(process.env.WEZBRIDGE_INTEL_DIR)));
    `);
    const run = failing => spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, R8_SOURCE_ROOT: path.resolve(__dirname, '..'), WEZBRIDGE_INTEL_DIR: intel,
        R8_RELEASE_FAIL: failing ? '1' : '0' } });
    const read = name => JSON.parse(fs.readFileSync(path.join(intel, name), 'utf8'));
    const first = run(true);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(read('tasks/T-9998.json').state, 'review');
    assert.ok(read('tasks/T-9998.json').lease);
    assert.equal(read('tasks/T-9997.json').lease, null, 'later work still completes in the failing pass');
    assert.equal(read('.result-link/cursor.json').bytes, 0, 'a retryable release must not be acknowledged');
    const second = run(false);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).seen, 2, 'the next scheduled pass retries the unacknowledged batch without manual link calls');
    assert.equal(read('tasks/T-9998.json').lease, null);
    assert.ok(read('.result-link/cursor.json').bytes > 0);
    assert.equal(JSON.parse(run(false).stdout).seen, 0);
    const events = fs.readFileSync(path.join(intel, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.event === 'task.released').length, 2, 'exactly one release per card across all passes');
    assert.equal(events.filter(e => e.event === 'task.updated').length, alreadyLinked ? 1 : 2, 'later successful transition never repeats');
  });
}

test('R8 killer: real consumer restart after ledger commit releases once without another transition', {
  skip: missing.length ? `Requires canonical companions: ${missing.join(', ')}` : false,
}, t => {
  const { root, intel } = diskFixture(t);
  const script = path.join(root, 'consumer.cjs');
  fs.writeFileSync(script, `
    const path = require('node:path');
    const linker = require(path.join(process.env.R8_SOURCE_ROOT, 'src/result-linker.cjs'));
    const ledger = linker.defaultRunLedger;
    linker.defaultRunLedger = (args, dir) => {
      const result = ledger(args, dir);
      if (process.env.R8_CRASH === '1' && args[0] === 'update') process.exit(86);
      return result;
    };
    const consumer = require(path.join(process.env.R8_SOURCE_ROOT, 'scripts/result-link.cjs'));
    console.log(JSON.stringify(consumer.runOnce(process.env.WEZBRIDGE_INTEL_DIR)));
  `);
  const run = crash => spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel, R8_SOURCE_ROOT: path.resolve(__dirname, '..'), R8_CRASH: crash ? '1' : '0' } });
  const read = name => JSON.parse(fs.readFileSync(path.join(intel, name), 'utf8'));
  assert.equal(run(true).status, 86, 'actual child exits immediately after the real ledger commit');
  assert.equal(read('tasks/T-9998.json').state, 'review');
  assert.ok(read('tasks/T-9998.json').lease);
  assert.equal(read('.result-link/cursor.json').bytes, 0, 'crashed consumer never acknowledges the line');
  const recovery = run(false);
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(read('tasks/T-9998.json').lease, null, 'real replay completes the unfinished release');
  assert.ok(read('.result-link/cursor.json').bytes > 0);
  assert.equal(run(false).status, 0);
  const events = fs.readFileSync(path.join(intel, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'task.released').length, 1);
  assert.equal(events.filter(e => e.event === 'task.updated').length, 1);
});
