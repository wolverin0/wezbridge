'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dr = require('../src/deploy-recipe.cjs');

// Fake repo factory: a graph.json + optional migration files, driven by an
// injected exec that scripts every command outcome — no git, no network.
function mkRepo(recipeOverrides = {}, { repoName = 'whatsappbot-final' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-recipe-'));
  fs.mkdirSync(path.join(dir, '.agent-workflow'), { recursive: true });
  const recipe = {
    gates_cmd: 'GATES', migration_glob: 'migrations',
    deploy_steps: ['DEPLOY1 {{SHA}}', 'DEPLOY2'],
    smoke_check: 'SMOKE', rollback_steps: ['ROLLBACK {{PREV_SHA}}'],
    ...recipeOverrides,
  };
  fs.writeFileSync(path.join(dir, '.agent-workflow', 'graph.json'), JSON.stringify({
    version: 1, repo: repoName, kinds: { deploy: { mode: 'none', gate: 'operator', deploy_recipe: recipe } },
  }));
  return dir;
}

// Scripted exec: map of matcher → result; default ok. Records calls.
function mkExec(script = {}) {
  const calls = [];
  const fn = async (cmd) => {
    calls.push(cmd);
    for (const [needle, res] of Object.entries(script)) {
      if (cmd.includes(needle)) return { ok: res.ok !== false, code: res.ok === false ? 1 : 0, stdout: res.stdout || '', stderr: res.stderr || '' };
    }
    if (cmd.includes('rev-parse HEAD~1')) return { ok: true, stdout: 'prevsha1111\n', stderr: '' };
    if (cmd.includes('rev-parse HEAD')) return { ok: true, stdout: 'testedsha2222\n', stderr: '' };
    if (cmd.includes('git diff')) return { ok: true, stdout: '', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

test('no recipe → refuse (deploys stay operator-manual)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-norecipe-'));
  fs.mkdirSync(path.join(dir, '.agent-workflow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent-workflow', 'graph.json'), JSON.stringify({ repo: 'whatsappbot-final', kinds: { deploy: { gate: 'operator' } } }));
  const r = await dr.runDeploy(dir, { exec: mkExec() });
  assert.strictEqual(r.outcome, 'refused');
  assert.match(r.phases[0].detail, /no deploy_recipe/);
});

test('canary guard: non-ratified repo refused even with a valid recipe', async () => {
  const dir = mkRepo({}, { repoName: 'venezia' });
  const r = await dr.runDeploy(dir, { exec: mkExec() });
  assert.strictEqual(r.outcome, 'refused');
  assert.match(r.phases.find((p) => p.name === 'canary-guard').detail, /not a ratified canary/);
});

test('gates failure stops the pipeline before any deploy step', async () => {
  const exec = mkExec({ GATES: { ok: false, stderr: '3 tests failed' } });
  const r = await dr.runDeploy(mkRepo(), { exec });
  assert.strictEqual(r.outcome, 'gates-failed');
  assert.ok(!exec.calls.some((c) => c.includes('DEPLOY1')));
});

test('destructive migration → operator gate, nothing ships (additive passes)', async () => {
  const dir = mkRepo();
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'migrations', 'a_add.js'), 'addColumn("users","x")');
  fs.writeFileSync(path.join(dir, 'migrations', 'b_drop.js'), 'queryInterface.dropTable("legacy")');
  const exec = mkExec({ 'git diff': { ok: true, stdout: 'migrations/a_add.js\nmigrations/b_drop.js\n' } });
  const r = await dr.runDeploy(dir, { exec });
  assert.strictEqual(r.outcome, 'operator-gate');
  assert.strictEqual(r.gate.kind, 'deploy');
  assert.strictEqual(r.gate.state, 'waiting');
  assert.match(r.gate.reason, /b_drop\.js/);
  assert.ok(!exec.calls.some((c) => c.includes('DEPLOY1'))); // nothing shipped
  // Additive-only run passes the classifier.
  const exec2 = mkExec({ 'git diff': { ok: true, stdout: 'migrations/a_add.js\n' } });
  const r2 = await dr.runDeploy(dir, { exec: exec2, dryRun: true });
  assert.strictEqual(r2.outcome, 'dry-run-ok');
});

test('SHA pin: HEAD moving between gates and deploy refuses the ship', async () => {
  let headCalls = 0;
  const exec = async (cmd) => {
    if (cmd.includes('rev-parse HEAD~1')) return { ok: true, stdout: 'prevsha\n', stderr: '' };
    if (cmd.includes('rev-parse HEAD')) { headCalls += 1; return { ok: true, stdout: headCalls === 1 ? 'sha-tested\n' : 'sha-DRIFTED\n', stderr: '' }; }
    if (cmd.includes('git diff')) return { ok: true, stdout: '', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const r = await dr.runDeploy(mkRepo(), { exec });
  assert.strictEqual(r.outcome, 'refused');
  assert.match(r.phases.find((p) => p.name === 'sha-pin').detail, /HEAD moved after gates/);
});

test('smoke failure → automatic rollback with PREV_SHA, outcome never success', async () => {
  const exec = mkExec({ SMOKE: { ok: false, stderr: 'HTTP 500' } });
  const r = await dr.runDeploy(mkRepo(), { exec });
  assert.strictEqual(r.outcome, 'rolled-back');
  const rb = exec.calls.find((c) => c.startsWith('ROLLBACK'));
  assert.ok(rb.includes('prevsha1111')); // template filled with the previous revision pointer
});

test('happy path: gates → sha-pin → deploy steps in order (SHA templated) → smoke → deployed', async () => {
  const exec = mkExec();
  const r = await dr.runDeploy(mkRepo(), { exec });
  assert.strictEqual(r.outcome, 'deployed');
  const d1 = exec.calls.findIndex((c) => c.startsWith('DEPLOY1'));
  const d2 = exec.calls.findIndex((c) => c.startsWith('DEPLOY2'));
  const smoke = exec.calls.findIndex((c) => c.startsWith('SMOKE'));
  assert.ok(d1 > -1 && d2 > d1 && smoke > d2);
  assert.ok(exec.calls[d1].includes('testedsha2222')); // {{SHA}} filled with the pinned revision
  assert.ok(!exec.calls.some((c) => c.startsWith('ROLLBACK')));
});

test('rollback step failure surfaces as rollback-failed (worst state is loud, not hidden)', async () => {
  const exec = mkExec({ SMOKE: { ok: false, stderr: 'dead' }, ROLLBACK: { ok: false, stderr: 'scp refused' } });
  const r = await dr.runDeploy(mkRepo(), { exec });
  assert.strictEqual(r.outcome, 'rollback-failed');
});
