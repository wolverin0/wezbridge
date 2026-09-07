'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { audit } = require('../scripts/fleet-steward.cjs');
const NOW = Date.parse('2026-09-06T20:00:00Z');

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0327-cross-repo-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  const repo = path.join(dir, 'wezbridge'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--initial-branch=main']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=' + path.join(dir, 'no-hooks'), 'commit', '--allow-empty', '-m', 'fixture']);
  git(['switch', '-c', 'fix/foreign-work']);
  assert.equal(git(['branch', '--show-current']).trim(), 'fix/foreign-work');
  const action = { ts: new Date(NOW - 2 * 3600000).toISOString(), actor: 'finalorchestra',
    action: 'branch_work', project: 'wezbridge', corr: 'T-0327-fixture',
    extra: { source_project: 'finalorchestra', branch: 'fix/foreign-work', worktree: repo }, ...overrides };
  fs.writeFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify(action) + '\n');
  return { dir, repo, action };
}

const findings = (dir, tasks = []) => audit(tasks, NOW, dir).findings.filter(f => f.category === 'cross-repo-unticketed');
const card = overrides => ({ id: 'T-9000', repo: 'wezbridge', corr: 'T-0327-fixture', state: 'done', ...overrides });

test('T-0327 review killer: invalid action rows cannot hide the following unticketed branch', t => {
  const { dir, action } = fixture(t);
  fs.writeFileSync(path.join(dir, 'actions.jsonl'),
    ['null', '42', '[]', '"text"', '{broken', JSON.stringify(action)].join('\n') + '\n');
  assert.equal(findings(dir).length, 1);
  assert.deepEqual(findings(dir, [card()]), []);
});

test('T-0327 AC3 killer: FinalOrchestra fix branch in Wezbridge without a correlated card reaches steward', t => {
  const { dir } = fixture(t);
  const result = findings(dir);
  assert.equal(result.length, 1);
  assert.match(result[0].why, /finalorchestra/);
  assert.match(result[0].why, /fix\/foreign-work/);
});

test('T-0327 AC3 control: same repo and exact corr on a card suppress the finding', t => {
  const { dir } = fixture(t);
  assert.deepEqual(findings(dir, [card()]), []);
});

test('T-0327 AC3: wrong repo or different correlation does not grant coverage', t => {
  const { dir } = fixture(t);
  assert.equal(findings(dir, [card({ repo: 'other' }), card({ corr: 'another-corr' })]).length, 1);
});

test('T-0327 AC3: missing correlation cannot match a card with no correlation', t => {
  const { dir } = fixture(t, { corr: null });
  assert.equal(findings(dir, [card({ corr: null })]).length, 1);
});

test('T-0327 AC3 controls: same-project work and repeated provenance do not create noise', t => {
  const { dir, action } = fixture(t);
  fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify(action) + '\n');
  assert.equal(findings(dir).length, 1);
  fs.writeFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify({ ...action,
    extra: { ...action.extra, source_project: 'wezbridge' } }) + '\n');
  assert.deepEqual(findings(dir), []);
});

test('T-0327 AC3: real branch recorder writes provenance consumed by steward', t => {
  const { dir, repo } = fixture(t);
  fs.writeFileSync(path.join(dir, 'actions.jsonl'), '');
  const command = path.resolve(__dirname, '../scripts/cross-repo-audit.cjs');
  const result = execFileSync(process.execPath, [command, 'record', '--from', 'finalorchestra',
    '--repo', 'wezbridge', '--cwd', repo], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir } });
  assert.equal(JSON.parse(result).recorded, true);
  assert.equal(findings(dir).length, 1);
});

test('T-0327 AC3: failed provenance write cannot report success', t => {
  const { repo } = fixture(t);
  assert.throws(() => require('../scripts/cross-repo-audit.cjs').recordBranchWork({
    sourceProject: 'finalorchestra', repo: 'wezbridge', cwd: repo, logAction: () => false,
  }), /not durably recorded/);
});

test('T-0327 review killer: repeating unticketed activity never resets a RED gate to GREEN', t => {
  const { dir, action } = fixture(t, { ts: new Date(NOW - 72 * 3600000).toISOString() });
  const { evaluate } = require('../scripts/steward-gate.cjs');
  const before = findings(dir);
  assert.equal(evaluate({ findings: before, rulings: [], now: NOW }).verdict, 'RED');
  fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify({ ...action,
    ts: new Date(NOW - 3600000).toISOString() }) + '\n');
  const after = findings(dir);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].age_hours, 72);
  assert.equal(evaluate({ findings: after, rulings: [], now: NOW }).verdict, 'RED');
});

test('T-0327 review control: a later different correlated activity cannot hide earlier unticketed work', t => {
  const { dir, action } = fixture(t, { corr: null });
  fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify({ ...action, corr: 'T-0327-fixture' }) + '\n');
  assert.equal(findings(dir, [card()]).length, 1);
});
