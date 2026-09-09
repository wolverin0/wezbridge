'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sp = require('../scripts/sp-bridge.cjs');
const BOTS = ['centinela', 'dep-scout', 'wabot-curador', 'auditor-ronda', 'skill-curator'];

function fixture(t) {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-briefs-'));
  t.after(() => { assert.equal(path.dirname(intel), os.tmpdir()); fs.rmSync(intel, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(intel, 'briefs'));
  for (const bot of BOTS) fs.writeFileSync(path.join(intel, 'briefs', `${bot}-mas-reciente.md`), `# ${bot}\nprimera revision\n`);
  const model = { tasks: [], completed: [], fault: null };
  const client = {
    getAllProjects: async () => [{ id: 'avisos', title: 'Avisos' }],
    getAllTags: async () => [{ id: 'agent', title: 'agente' }],
    getTasks: async () => model.tasks.map(t => ({ ...t })),
    addTask: async data => {
      const id = `task-${model.tasks.length + 1}`;
      model.tasks = [...model.tasks, { ...data, id, isDone: false }];
      if (model.fault === 'lost-add-response') { model.fault = null; throw Error('response lost'); }
      return id;
    },
    setTaskDone: async id => {
      if (model.fault === 'complete') throw Error('completion failed');
      model.tasks = model.tasks.map(t => t.id === id ? { ...t, isDone: true } : t);
      model.completed = [...model.completed, id];
      return true;
    },
  };
  return { intel, model, client, hub: sp.createHub(client, { intel }) };
}

test('T-0406 AC1 killer: same SHA twice creates one task per bot; new SHA creates one and completes only its predecessor', async t => {
  const e = fixture(t);
  const first = await e.hub.syncBriefs();
  assert.equal(first.created, 5);
  assert.equal(e.model.tasks.length, 5);
  const second = await sp.createHub(e.client, { intel: e.intel }).syncBriefs();
  assert.equal(second.created, 0);
  assert.equal(e.model.tasks.length, 5, 'same SHA must not create duplicates after a new hub instance');
  const previous = first.items.find(x => x.bot === 'centinela').taskId;
  fs.writeFileSync(path.join(e.intel, 'briefs/centinela-mas-reciente.md'), '# centinela\nsegunda revision\n');
  const changed = await e.hub.syncBriefs();
  assert.equal(changed.created, 1);
  assert.equal(changed.completed, 1);
  assert.equal(e.model.tasks.length, 6);
  assert.deepEqual(e.model.completed, [previous]);
  assert.equal(e.model.tasks.filter(x => !x.isDone).length, 5);
  for (const task of e.model.tasks) {
    assert.equal(task.projectId, 'avisos');
    assert.ok(task.tagIds.includes('agent'));
    assert.match(task.notes, /file:\/\//);
    assert.match(task.notes, /\[ext:brief:/);
  }
});

test('lost addTask response is recovered by the exact SHA marker, not resent', async t => {
  const e = fixture(t);
  e.model.fault = 'lost-add-response';
  await assert.rejects(e.hub.syncBriefs(), /response lost/);
  assert.equal(e.model.tasks.length, 1);
  const retry = await e.hub.syncBriefs();
  assert.equal(retry.recovered, 1);
  assert.equal(retry.created, 4);
  assert.equal(e.model.tasks.length, 5);
});

test('completion failure retains the predecessor and retries without a second new task', async t => {
  const e = fixture(t);
  await e.hub.syncBriefs();
  const previous = e.model.tasks[2].id;
  fs.appendFileSync(path.join(e.intel, 'briefs/wabot-curador-mas-reciente.md'), 'revision nueva\n');
  e.model.fault = 'complete';
  await assert.rejects(e.hub.syncBriefs(), /completion failed/);
  assert.equal(e.model.tasks.length, 6);
  assert.equal(e.model.tasks.find(x => x.id === previous).isDone, false);
  e.model.fault = null;
  const retry = await e.hub.syncBriefs();
  assert.equal(retry.created, 0);
  assert.equal(retry.completed, 1);
  assert.equal(e.model.tasks.length, 6);
  assert.deepEqual(e.model.completed, [previous]);
});

test('lost state recovers owned tasks from SP, without touching an unrelated Avisos task', async t => {
  const e = fixture(t);
  await e.hub.syncBriefs();
  e.model.tasks = [...e.model.tasks, { id: 'operator', title: 'operator task', projectId: 'avisos', notes: 'unrelated', isDone: false }];
  fs.unlinkSync(path.join(e.intel, '.sp-bridge/briefs.json'));
  const result = await e.hub.syncBriefs();
  assert.equal(result.created, 0);
  assert.equal(result.recovered, 5);
  assert.equal(e.model.tasks.length, 6);
  assert.deepEqual(e.model.completed, []);
});

test('an ambiguous pending add with no remote marker never auto-resends; changed source also stops', async t => {
  const e = fixture(t);
  let calls = 0;
  e.client.addTask = async () => { calls++; throw Error('unknown transport outcome'); };
  await assert.rejects(e.hub.syncBriefs(), /unknown transport outcome/);
  await assert.rejects(e.hub.syncBriefs(), /manual reconciliation required/);
  assert.equal(calls, 1);
  fs.appendFileSync(path.join(e.intel, 'briefs/centinela-mas-reciente.md'), 'changed');
  await assert.rejects(e.hub.syncBriefs(), /source changed/);
  assert.equal(calls, 1);
});

test('exclusive lock prevents concurrent runs from racing addTask', async t => {
  const e = fixture(t);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  e.client.getTasks = async () => { await wait; return []; };
  const first = e.hub.syncBriefs();
  await assert.rejects(e.hub.syncBriefs(), /EEXIST/);
  release();
  assert.equal((await first).created, 5);
  assert.equal(e.model.tasks.length, 5);
});

test('missing or empty brief fails before task creation and releases the lock', async t => {
  const e = fixture(t);
  const file = path.join(e.intel, 'briefs/dep-scout-mas-reciente.md');
  fs.unlinkSync(file);
  await assert.rejects(e.hub.syncBriefs(), /ENOENT/);
  assert.equal(e.model.tasks.length, 0);
  fs.writeFileSync(file, '');
  await assert.rejects(e.hub.syncBriefs(), /empty/);
  fs.writeFileSync(file, 'repaired');
  assert.equal((await e.hub.syncBriefs()).created, 5);
});

test('corrupt state or duplicate remote SHA markers refuse new writes', async t => {
  const e = fixture(t);
  await e.hub.syncBriefs();
  const file = path.join(e.intel, '.sp-bridge/briefs.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{broken');
  await assert.rejects(e.hub.syncBriefs(), SyntaxError);
  fs.writeFileSync(file, '{}');
  await assert.rejects(e.hub.syncBriefs(), /invalid briefs state/);
  fs.writeFileSync(file, original);
  fs.unlinkSync(file);
  e.model.tasks = [...e.model.tasks, { ...e.model.tasks[0], id: 'duplicate' }];
  await assert.rejects(e.hub.syncBriefs(), /ambiguous SP tasks/);
  assert.equal(e.model.tasks.length, 6);
  assert.deepEqual(e.model.completed, []);
});

test('scheduled sync records briefs and never advances last-success when a brief is missing', async t => {
  const e = fixture(t);
  const hub = { syncDecisions: async () => ({}), syncIntake: async () => ({}),
    syncOutcomes: async () => ({}), syncBriefs: () => e.hub.syncBriefs() };
  const opts = { hub, intelDir: e.intel, logDir: path.join(e.intel, 'logs') };
  const good = await sp.syncOnce(opts);
  assert.equal(good.ok, true);
  assert.equal(good.record.briefs.created, 5);
  const file = path.join(e.intel, '.sp-bridge/last-success.json');
  const old = fs.readFileSync(file, 'utf8');
  fs.unlinkSync(path.join(e.intel, 'briefs/centinela-mas-reciente.md'));
  const bad = await sp.syncOnce(opts);
  assert.equal(bad.ok, false);
  assert.equal(bad.record.stage, 'briefs');
  assert.equal(fs.readFileSync(file, 'utf8'), old);
});

test('a corrupted predecessor id cannot complete an operator task', async t => {
  const e = fixture(t);
  await e.hub.syncBriefs();
  e.model.tasks = [...e.model.tasks, { id: 'operator', projectId: 'avisos', notes: 'not owned by the bridge', isDone: false }];
  const file = path.join(e.intel, '.sp-bridge/briefs.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.active.centinela.taskId = 'operator';
  fs.writeFileSync(file, JSON.stringify(state));
  fs.appendFileSync(path.join(e.intel, 'briefs/centinela-mas-reciente.md'), 'new revision');
  await assert.rejects(e.hub.syncBriefs(), /predecessor ownership/);
  assert.deepEqual(e.model.completed, []);
  assert.equal(e.model.tasks.find(x => x.id === 'operator').isDone, false);
});
