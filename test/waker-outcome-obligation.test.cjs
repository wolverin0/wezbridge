'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createWaker } = require('../src/orchestrator-waker.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-outcome-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const intel = path.join(root, '_intel');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  const eventsPath = path.join(intel, 'pane-events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const sent = [], logs = [];
  const build = (extra = {}) => createWaker({ eventsPath, stateDir: path.join(intel, 'state'),
    intelDir: intel, reposRoot: root, watchRepos: ['fixture'], settleTicks: 1,
    debounceMs: 0, cooldownMs: 0, now: () => Date.parse('2026-09-08T13:00:00Z'),
    discoverPanes: () => [{ paneId: 8, isClaude: true, project: '/x/wezbridge', status: 'idle' }],
    resolveTarget: () => 8, log: line => logs.push(line),
    send: { sendPromptDeferredEnter: async (_pane, text) => { sent.push(text); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted' }, ...options, ...extra });
  const event = (kind = 'turn-end', session = 'one') => fs.appendFileSync(eventsPath,
    JSON.stringify({ repo: 'fixture', session, time: '2026-09-08T12:59:00Z', event: kind }) + '\n');
  const card = value => fs.writeFileSync(path.join(intel, 'tasks', 'T-0001.json'), JSON.stringify(value));
  return { root, intel, eventsPath, sent, logs, build, event, card };
}

test('operator correction: an untracked turn-end does not manufacture an outcome or a wake', async t => {
  const f = fixture(t), w = f.build();
  f.event(); await w.tick();
  assert.equal(f.sent.length, 0, 'a conversation boundary is not a useful coordination request');
  assert.equal(w.status().pending, 0, 'noise must not become an aging delivery obligation');
  assert.ok(f.logs.some(line => /turn-end.*noise|noise.*turn-end/i.test(line)), 'silence has an auditable reason');
  const restarted = f.build(); await restarted.tick();
  f.event(); await restarted.tick();
  assert.equal(f.sent.length, 0, 'restart and duplicate input must not resurrect noise');
});

test('operator correction: a result delivery survives interruption without closing its task', async t => {
  const f = fixture(t);
  const card = { id: 'T-0001', repo: 'fixture', state: 'review', corr: 'one-result',
    next_action: 'Independently verify artifact and request repair on failure' };
  f.card(card);
  const w = f.build({ discoverPanes: () => [] });
  await w.tick(); // seed the empty result directory before the first real result
  const dir = path.join(f.root, 'fixture', '.orchestrator', 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node-one.json'), JSON.stringify({ status: 'claimed', evidence: [] }));
  f.event(); await w.tick();
  assert.equal(w.status().pending, 2);
  const restarted = f.build(); await restarted.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /RESULT FILE/);
  assert.doesNotMatch(f.sent[0], /finished work|node completed/i, 'receipt cannot assert acceptance');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), 'utf8')), card);
  await f.build().tick();
  assert.equal(f.sent.length, 1, 'one verified delivery across restarts');
});

test('a graphless review obligation is named and remains actionable', async t => {
  const f = fixture(t);
  const card = { id: 'T-0001', repo: 'fixture', state: 'review', next_action: 'Review exact revision' };
  f.card(card);
  const w = f.build(); f.event(); await w.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /T-0001/);
  assert.doesNotMatch(f.sent[0], /finished work|node completed/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), 'utf8')), card);
});

test('a corrupt ledger cannot establish that no obligation exists', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), '{broken');
  const w = f.build(); f.event(); await w.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /unavailable|unreadable|unknown/i);
  assert.doesNotMatch(f.sent[0], /finished work/i);
});

test('permission and directed A2A signals still wake without a graph', async t => {
  for (const kind of ['permission-wait', 'a2a']) {
    const f = fixture(t), w = f.build(); f.event(kind); await w.tick();
    assert.equal(f.sent.length, 1, kind);
    assert.doesNotMatch(f.sent[0], /finished work/i);
  }
});

test('integration: an operator menu survives turn-end noise suppression', async t => {
  const f = fixture(t);
  const menu = fs.readFileSync(path.join(__dirname, 'fixtures/wabot-askuserquestion-20260909.txt'), 'utf8');
  const w = f.build({ discoverPanes: () => [
    { paneId: 8, project: '/x/wezbridge', status: 'idle' },
    { paneId: 9, project: '/x/fixture', status: 'idle', lastLines: menu },
  ] });
  f.event(); await w.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /operator-question/);
});

test('integration: an operator menu notice cannot acknowledge an unmentioned review card', async t => {
  const f = fixture(t);
  const menu = fs.readFileSync(path.join(__dirname, 'fixtures/wabot-askuserquestion-20260909.txt'), 'utf8');
  fs.writeFileSync(path.join(f.intel, 'rulings.jsonl'), '');
  f.card({ id: 'T-0001', repo: 'fixture', state: 'review', next_action: 'Review exact revision' });
  let question = true;
  const w = f.build({ discoverPanes: () => [
    { paneId: 8, project: '/x/wezbridge', status: 'idle' },
    { paneId: 9, project: '/x/fixture', status: 'idle', lastLines: question ? menu : '' },
  ] });
  f.event(); await w.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /operator-question/);
  assert.doesNotMatch(f.sent[0], /T-0001/);
  question = false;
  f.event('turn-end', 'menu-closed'); await w.tick();
  assert.equal(f.sent.length, 2, 'review obligation was never named by the menu notice');
  assert.match(f.sent[1], /T-0001/);
});

test('each recovery rider independently retains a bare turn-end wake', async t => {
  for (const kind of ['graph', 'context', 'held']) {
    const f = fixture(t);
    const source = { paneId: 9, isClaude: true, project: '/x/fixture', status: 'idle',
      lastLines: kind === 'context' ? 'Ctx Used: 85.0%' : '──────\n❯ continue the task\n──────\n Model: Opus 5' };
    const w = f.build(kind === 'graph' ? { hasOpenGraph: () => true } : {
      discoverPanes: () => [{ paneId: 8, project: '/x/wezbridge', status: 'idle' }, source] });
    f.event(); await w.tick();
    assert.equal(f.sent.length, 1, kind);
  }
});

test('pending running work remains durable while its ordinary turn boundary stays quiet', async t => {
  const f = fixture(t);
  const task = { id: 'T-0001', repo: 'fixture', state: 'running',
    lease: { owner: 'fixture', expires_at: '2026-09-08T14:00:00Z' }, next_action: 'Finish artifact then independent review' };
  f.card(task);
  const before = fs.readFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), 'utf8');
  const w = f.build(); f.event(); await w.tick(); await f.build().tick();
  assert.equal(f.sent.length, 0);
  assert.equal(fs.readFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), 'utf8'), before);
});

test('crash between durable noise receipt and pending removal cannot replay it as a new obligation', async t => {
  const f = fixture(t);
  const w = f.build({ discoverPanes: () => [] });
  f.event(); await w.tick();
  const child = `
    const fs = require('node:fs');
    const { createWaker } = require(${JSON.stringify(require.resolve('../src/orchestrator-waker.cjs'))});
    const rename = fs.renameSync;
    fs.renameSync = function(a,b) {
      rename(a,b);
      if (String(b).endsWith('delivered.json')) process.exit(75);
    };
    const w = createWaker({ eventsPath: ${JSON.stringify(f.eventsPath)},
      stateDir: ${JSON.stringify(path.join(f.intel, 'state'))}, intelDir: ${JSON.stringify(f.intel)},
      reposRoot: ${JSON.stringify(f.root)}, watchRepos:['fixture'], settleTicks:1, debounceMs:0,
      discoverPanes:()=>[{paneId:8,status:'idle'}], resolveTarget:()=>8,
      send:{sendPromptDeferredEnter:async()=>{throw Error('unexpected wake')}} });
    w.tick().catch(()=>process.exit(76));`;
  const killed = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.status, 75, killed.stderr);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(w._files.pending, 'utf8'))).length, 1,
    'the forced interruption happened before pending removal');
  // A newly appearing task must not turn yesterday's consumed noise into a wake.
  f.card({ id: 'T-0001', repo: 'fixture', state: 'review', next_action: 'Review new artifact' });
  const restarted = f.build(); await restarted.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(restarted.status().pending, 0);
});

test('review deferrals only earn silence while valid, and unrelated cards do not wake', async t => {
  for (const scenario of ['live', 'expired', 'corrupt', 'missing', 'unrelated']) {
    const f = fixture(t);
    f.card({ id: 'T-0001', repo: scenario === 'unrelated' ? 'elsewhere' : 'fixture',
      state: 'review', next_action: 'Review exact revision' });
    const ruling = { task: 'T-0001', category: 'stale-review', ruling: 'deferred',
      until: scenario === 'expired' ? '2026-09-08T12:00:00Z' : '2026-09-08T14:00:00Z',
      at: '2026-09-08T11:00:00Z' };
    if (scenario !== 'missing') fs.writeFileSync(path.join(f.intel, 'rulings.jsonl'),
      scenario === 'corrupt' ? '{broken' : JSON.stringify(ruling) + '\n');
    const w = f.build(); f.event(); await w.tick();
    assert.equal(f.sent.length, ['live', 'unrelated'].includes(scenario) ? 0 : 1, scenario);
  }
});

test('missing ledger or corrupt graph cannot authorize silence', async t => {
  for (const scenario of ['missing-ledger', 'corrupt-graph', 'malformed-graph']) {
    const f = fixture(t);
    if (scenario === 'missing-ledger') fs.rmdirSync(path.join(f.intel, 'tasks'));
    else {
      const dir = path.join(f.root, 'fixture', '.orchestrator');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'graph.json'), scenario === 'corrupt-graph' ? '{broken' : '{}');
    }
    const w = f.build(); f.event(); await w.tick();
    assert.equal(f.sent.length, 1, scenario);
    assert.match(f.sent[0], /unavailable/i);
    if (scenario !== 'missing-ledger') {
      assert.doesNotMatch(f.sent[0], /No open graph confirmed/);
      assert.match(f.sent[0], /Graph status unavailable/);
    }
  }
});

test('ungoverned or invalid active cards cannot justify suppression; historic terminal cards can', async t => {
  for (const scenario of ['ungoverned', 'unknown-state', 'missing-repo', 'historic-terminal']) {
    const f = fixture(t);
    const task = { id: 'T-0001', state: scenario === 'historic-terminal' ? 'done' : 'review' };
    if (scenario === 'unknown-state') task.state = 'invented';
    if (scenario === 'ungoverned') fs.writeFileSync(path.join(f.intel, 'tasks', 'T-LOST.json'), '{}');
    else f.card(task);
    const w = f.build(); f.event(); await w.tick();
    assert.equal(f.sent.length, scenario === 'historic-terminal' ? 0 : 1, scenario);
  }
});

test('retired nonnumeric stall card is compatible, but reactivation cannot be hidden', async t => {
  for (const state of ['cancelled', 'review', 'ready']) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.intel, 'tasks', 'T-LOOP-STALL.json'), JSON.stringify({
      id: 'T-LOOP-STALL', repo: 'fixture', state }));
    const w = f.build(); f.event(); await w.tick();
    assert.equal(f.sent.length, state === 'cancelled' ? 0 : 1, state);
  }
});

test('an unchanged review obligation wakes once across new turns; changed evidence wakes again', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.intel, 'rulings.jsonl'), '');
  const task = { id: 'T-0001', repo: 'fixture', state: 'review', next_action: 'Review artifact A',
    evaluator_evidence: 'revision A' };
  f.card(task);
  const w = f.build(); f.event(); await w.tick();
  assert.equal(f.sent.length, 1);
  const restarted = f.build(); f.event('turn-end', 'second-turn'); await restarted.tick();
  assert.equal(f.sent.length, 1, 'a second conversation boundary adds no new review obligation');
  f.card({ ...task, evaluator_evidence: 'revision B' });
  f.event('turn-end', 'third-turn'); await f.build().tick();
  assert.equal(f.sent.length, 2, 'changed evidence must bring the obligation back');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), 'utf8')).state, 'review');
});

test('a verified result receipt survives process death before pending removal with one recorded effect', async t => {
  const f = fixture(t), before = f.build({ discoverPanes: () => [] });
  await before.tick();
  f.card({ id: 'T-0001', repo: 'fixture', state: 'review', next_action: 'Verify received artifact' });
  const dir = path.join(f.root, 'fixture', '.orchestrator', 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), '{"status":"claimed"}');
  await before.tick();
  const effects = path.join(f.root, 'effects.jsonl');
  const child = `
    const fs = require('node:fs');
    const { createWaker } = require(${JSON.stringify(require.resolve('../src/orchestrator-waker.cjs'))});
    const rename = fs.renameSync;
    fs.renameSync = function(a,b) { rename(a,b); if (String(b).endsWith('delivered.json')) process.exit(75); };
    const w = createWaker({ eventsPath:${JSON.stringify(f.eventsPath)},
      stateDir:${JSON.stringify(path.join(f.intel, 'state'))}, intelDir:${JSON.stringify(f.intel)},
      reposRoot:${JSON.stringify(f.root)}, watchRepos:['fixture'], settleTicks:1, debounceMs:0,
      discoverPanes:()=>[{paneId:8,status:'idle'}], resolveTarget:()=>8,
      send:{sendPromptDeferredEnter:async(_id,text)=>{fs.appendFileSync(${JSON.stringify(effects)},JSON.stringify(text)+'\\n');return 'ok'},
        verifyPromptSubmission:async()=> 'submitted'} });
    w.tick().catch(()=>process.exit(76));`;
  const killed = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 10000 });
  assert.equal(killed.status, 75, killed.stderr);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(before._files.pending, 'utf8'))).length, 1);
  const restarted = f.build(); await restarted.tick();
  assert.equal(f.sent.length, 0, 'already verified result must not be sent again');
  assert.equal(fs.readFileSync(effects, 'utf8').trim().split('\n').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.intel, 'tasks', 'T-0001.json'), 'utf8')).next_action,
    'Verify received artifact', 'transport receipt never substitutes for the next obligation');
});
