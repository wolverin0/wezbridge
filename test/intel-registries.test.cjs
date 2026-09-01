'use strict';
// T30: este archivo depende de companions fuera del repo — en checkout aislado se declara y corta.
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

// R.1/R.2 exit criteria as executable checks (PLAN-control-plane Phase R).
// These registries exist so dispatch never globs for repos and the gate never
// meets an unknown kind. If this suite fails, the importer must refuse to run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BASE = path.join(__dirname, '..', '..');
const intel = (f) => path.join(BASE, '_intel', f);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const repos = readJson(intel('repos.json'));
const kinds = readJson(intel('kinds.json'));
const tasks = fs.readdirSync(intel('tasks'))
  .filter((f) => /^T-\d+\.json$/.test(f))
  .map((f) => readJson(path.join(intel('tasks'), f)));

test('R.1: every ledger repo slug resolves in the registry', () => {
  // The exit criterion verbatim: dispatch must never guess a path.
  const slugs = [...new Set(tasks.map((t) => t.repo).filter(Boolean))];
  for (const slug of slugs) {
    assert.ok(repos.repos[slug], `ledger slug "${slug}" missing from repos.json — dispatch would be guesswork`);
  }
});

test('R.1: active repo paths exist on disk; virtual repos carry null paths', () => {
  for (const [slug, r] of Object.entries(repos.repos)) {
    if (r.status === 'virtual') {
      assert.strictEqual(r.path, null, `${slug}: virtual repos must not carry a path`);
    } else {
      assert.ok(r.path, `${slug}: non-virtual entry needs a path`);
      assert.ok(fs.existsSync(path.join(BASE, r.path)), `${slug}: path "${r.path}" does not exist`);
    }
  }
});

test('R.1: no registry path is a linked git worktree, proven by git metadata not by name', () => {
  // _worktrees/ holds 45 duplicate roadmaps; a worktree in the registry means
  // the same item dispatches into every copy. Name-matching is not proof —
  // clawtrol's worktrees sit at top level. git-dir containing /worktrees/ is.
  for (const [slug, r] of Object.entries(repos.repos)) {
    if (!r.path) continue;
    assert.ok(!/^_worktrees[\\/]/.test(r.path), `${slug}: path under _worktrees/`);
    assert.ok(!/^_archive[\\/]/.test(r.path), `${slug}: path under _archive/`);
    let gitDir = '';
    try {
      gitDir = execFileSync('git', ['-C', path.join(BASE, r.path), 'rev-parse', '--git-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { continue; /* unversioned dir — not a worktree */ }
    assert.ok(!gitDir.includes('/worktrees/') && !gitDir.includes('\\worktrees\\'),
      `${slug}: "${r.path}" is a linked worktree of another repo (git-dir: ${gitDir})`);
  }
});

test('R.1: pending_operator repos are readable but marked, never silently active', () => {
  const pending = Object.entries(repos.repos).filter(([, r]) => r.status === 'pending_operator');
  assert.ok(pending.length >= 2, 'whatsappbot-final and clawtrol are pending operator rulings');
  for (const [slug, r] of pending) {
    assert.ok(r.pending && r.pending.length > 20, `${slug}: a pending entry must say what decision it awaits`);
  }
});

test('R.2: every kind used in the ledger is in the closed vocabulary', () => {
  // 26 kinds across 44 tasks with edge rules covering 2 = a decorative gate.
  const used = [...new Set(tasks.map((t) => t.kind).filter(Boolean))];
  for (const k of used) {
    assert.ok(kinds.kinds[k], `ledger kind "${k}" missing from kinds.json — it would match no rule and bypass the gate`);
  }
});

test('R.2: the default is safe — general cannot write, unknown resolves to general AND flags', () => {
  assert.strictEqual(kinds.kinds.general.fallback_mode, 'read_mostly',
    'general must be read_mostly: a scan failure degrades to ask, never to write');
  assert.strictEqual(kinds.rules.unknown_kind.resolve_to, 'general');
  assert.strictEqual(kinds.rules.unknown_kind.flag, true,
    'unknown kinds must raise a flag, never be honoured silently');
});

test('R.2: fleet-minimum gates are present and operator-gated', () => {
  // These stay gated no matter who asks — including a peer pane. The operator
  // constraint is standing: deploys, customer sends, payment/credential/data
  // changes are operator-gated always; repos may only ESCALATE.
  for (const k of ['credential-change', 'customer-send', 'data-disposition',
    'deploy', 'schema-migration', 'auth-change', 'payments']) {
    assert.ok(kinds.kinds[k], `fleet-minimum kind "${k}" missing`);
    assert.strictEqual(kinds.kinds[k].fallback_gate, 'operator', `${k} must be operator-gated at fleet minimum`);
  }
});

test('R.2: a question is by definition an operator decision', () => {
  assert.strictEqual(kinds.kinds.question.fallback_gate, 'operator');
});
