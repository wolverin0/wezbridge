'use strict';
// R.4 exit criteria. Hermetic on purpose: an earlier steward test coupled to
// live fleet state failed the moment an unrelated log was appended. Each drift
// direction gets a synthetic repo whose git history we control completely.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lintRepo } = require('../../_docs-curation/roadmap-lint.cjs');

let dir;
const g = (...args) => execFileSync('git', ['-C', dir, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function commit(msg) {
  fs.appendFileSync(path.join(dir, 'work.txt'), msg + '\n');
  g('add', '-A'); g('commit', '-m', msg);
  return g('rev-parse', '--short', 'HEAD');
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-lint-'));
  g('init', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  commit('init');
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function lint(roadmap) {
  const p = path.join(dir, 'ROADMAP.md');
  fs.writeFileSync(p, roadmap);
  return lintRepo('fixture', dir, p).findings;
}

test('done-no-trace: [x] with no commit in main mentioning the id fails (KB-12 shape)', () => {
  const f = lint('- [x] KB-98 | fix the thing nobody shipped\n');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].check, 'done-no-trace');
  assert.strictEqual(f[0].severity, 'FAIL');
});

test('shipped-open: [ ] whose id appears in main history fails (reverse drift)', () => {
  commit('fix: resolve KB-97 ordering bug');
  const f = lint('- [ ] KB-97 | resolve ordering bug\n');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].check, 'shipped-open');
});

test('a done item whose id IS in main history is clean', () => {
  commit('feat: implement KB-96 exporter');
  assert.deepStrictEqual(lint('- [x] KB-96 | implement exporter\n'), []);
});

test('branch-only work on an open item is NOT drift — WIP is the state the file describes', () => {
  g('checkout', '-b', 'feature/kb-95');
  commit('wip: KB-95 half done');
  g('checkout', 'main');
  assert.deepStrictEqual(lint('- [ ] KB-95 | in progress on a branch\n'), []);
});

test('sha-not-landed: [x] citing a SHA that is not an ancestor of main fails', () => {
  g('checkout', '-b', 'stranded');
  const sha = commit('stranded: KB-94 work');
  g('checkout', 'main');
  const f = lint(`- [x] KB-94 | done — ${sha}\n`);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].check, 'sha-not-landed');
});

test('[x] citing a SHA that IS in main is clean even if the message never names the id', () => {
  const sha = commit('refactor with no id in the message');
  assert.deepStrictEqual(lint(`- [x] KB-93 | landed as ${sha}\n`), []);
});

test('untagged items are invisible to the linter — no id, no checkable claim', () => {
  assert.deepStrictEqual(lint('- [x] some legacy line\n- [ ] another one\n'), []);
});

test('open T-id with no ledger row is WARN not FAIL until the importer exists', () => {
  const f = lint('- [ ] T-9999 | future imported item\n');
  const warn = f.find((x) => x.check === 'no-ledger-row');
  assert.ok(warn, 'expected a no-ledger-row finding');
  assert.strictEqual(warn.severity, 'WARN');
  assert.ok(!f.some((x) => x.severity === 'FAIL' && x.check === 'no-ledger-row'));
});

test('blind-clean guard: ids in tables/prose with zero checkbox lines must WARN, never read clean', () => {
  // The linter's own first live run produced a vacuous "clean" on whatsappbot,
  // whose 57 id mentions all live in markdown tables. This is the fixture.
  const f = lint('| KB-1 | something | status |\n| B-11 | other | open |\n');
  const blind = f.find((x) => x.check === 'format-blind');
  assert.ok(blind, 'expected a format-blind warning');
  assert.match(blind.why, /vacuous/);
});

test('counts are reported so a clean verdict states its scope', () => {
  const p = path.join(dir, 'ROADMAP.md');
  fs.writeFileSync(p, '- [x] KB-96 | implement exporter\n- [ ] untagged thing\n');
  const res = lintRepo('fixture', dir, p);
  assert.strictEqual(res.checked.items, 2);
  assert.strictEqual(res.checked.items_with_ids, 1);
});

test('live smoke: linting the real whatsappbot ROADMAP produces findings without throwing', () => {
  // Not an assertion about counts — the file is being actively corrected today.
  // This proves the linter runs against the real repo that motivated it.
  const base = path.join(__dirname, '..', '..');
  const repo = path.join(base, 'whatsappbot-prod - Copy - Copy', 'whatsappbot-final');
  const rm = path.join(repo, 'ROADMAP.md');
  if (!fs.existsSync(rm)) return; // environment without the repo: skip silently
  const res = lintRepo('whatsappbot-final', repo, rm);
  assert.ok(Array.isArray(res.findings));
});
