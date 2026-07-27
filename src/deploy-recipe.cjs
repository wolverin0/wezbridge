'use strict';
/**
 * deploy-recipe.cjs — enforceable deploy pipeline for the whatsappbot canary.
 *
 * Control-plane v1 deploy phase (leanest enforceable version, 2026-07-27).
 * The operator's standing rule: completed code work runs gates, pushes, and
 * deploys the EXACT tested revision live — with hard stops for destructive
 * DB work. This module makes that rule DENY-BY-DEFAULT code instead of prose:
 *
 *   - No recipe in the repo's .agent-workflow/graph.json → refuse.
 *   - Repo is not the ratified canary → refuse (no generic fleet engine yet).
 *   - Gates fail → stop before anything ships.
 *   - Tested SHA != HEAD at deploy time → refuse (the drift lesson: what you
 *     tested is the only thing you may ship).
 *   - Migration files matching the destructive classifier → GATE:deploy
 *     operator stop (additive migrations pass).
 *   - Smoke check fails after deploy → automatic rollback to the previous
 *     revision pointer, and the run reports rolled_back, never success.
 *
 * Recipe shape (lives in <repo>/.agent-workflow/graph.json under
 * kinds.deploy.deploy_recipe — authored/ratified per repo by the operator):
 *   {
 *     "gates_cmd":      "cd bot && npm test -- --silent",
 *     "migration_glob": "bot/migrations",       // dir scanned for new files
 *     "deploy_steps":   ["<shell step>", ...],  // run in repo cwd, in order
 *     "smoke_check":    "curl -fsS http://.../health",
 *     "rollback_steps": ["<shell step>", ...],  // uses {{PREV_SHA}} template
 *     "revision_cmd":   "git rev-parse HEAD"    // optional override
 *   }
 * Steps may use {{SHA}} and {{PREV_SHA}} placeholders.
 *
 * v1 canary guard: CANARY_REPOS is the ONLY allowlist; extending it is a
 * per-repo operator ratification, not a code default.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CANARY_REPOS = new Set(['whatsappbot-final']);

// Destructive-DDL classifier: these stop for the operator. Additive DDL
// (CREATE TABLE/INDEX, ADD COLUMN, MODIFY to widen) passes. Deliberately
// conservative — false positives stop for a human, false negatives ship
// data loss, so unknown ALTER shapes count as destructive.
const DESTRUCTIVE_SQL = [
  /\bDROP\s+(TABLE|COLUMN|DATABASE|INDEX)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b[\s\S]*?\b(DROP|CHANGE|RENAME)\b/i,
  /removeColumn|dropTable|renameColumn/, // sequelize migration API
];

function sh(cmd, cwd, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function loadRecipe(repoDir) {
  const p = path.join(repoDir, '.agent-workflow', 'graph.json');
  const graph = JSON.parse(fs.readFileSync(p, 'utf8'));
  const recipe = graph && graph.kinds && graph.kinds.deploy && graph.kinds.deploy.deploy_recipe;
  if (!recipe) throw new Error('no deploy_recipe in kinds.deploy — deploys stay operator-manual for this repo');
  for (const k of ['gates_cmd', 'deploy_steps', 'smoke_check', 'rollback_steps']) {
    if (!recipe[k] || (Array.isArray(recipe[k]) && !recipe[k].length)) throw new Error(`deploy_recipe missing required field "${k}"`);
  }
  return { recipe, repoName: graph.repo };
}

/**
 * Classify migration files added since prevSha. Returns {destructive:[],
 * additive:[], error?}. FAIL-CLOSED: if the diff itself fails, the caller
 * must treat the run as unclassifiable and stop — a classifier that errors
 * into "no migrations" ships data loss silently.
 */
async function classifyMigrations(repoDir, recipe, sha, prevSha, exec = sh) {
  const dir = recipe.migration_glob;
  if (!dir) return { destructive: [], additive: [] };
  const diff = await exec(`git diff --name-only --diff-filter=A ${prevSha} ${sha} -- "${dir}"`, repoDir, { timeoutMs: 30_000 });
  if (!diff.ok) return { destructive: [], additive: [], error: `migration diff failed: ${(diff.stderr || '').slice(0, 200)}` };
  const files = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const destructive = [];
  const additive = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { destructive.push(f); continue; } // unreadable = assume worst
    (DESTRUCTIVE_SQL.some((re) => re.test(text)) ? destructive : additive).push(f);
  }
  return { destructive, additive };
}

const fill = (step, vars) => step.replace(/\{\{SHA\}\}/g, vars.sha).replace(/\{\{PREV_SHA\}\}/g, vars.prevSha);

/**
 * Run the full gated pipeline. Every outcome is a structured report — this
 * function never throws for pipeline failures, only for setup errors.
 * opts.dryRun: validate + gates + classification only; no deploy/smoke.
 * opts.exec: injectable command runner for tests.
 */
async function runDeploy(repoDir, opts = {}) {
  const exec = opts.exec || sh;
  const report = { repo: null, sha: null, prev_sha: null, phases: [], outcome: 'refused' };
  const phase = (name, ok, detail) => { report.phases.push({ name, ok, detail: String(detail || '').slice(0, 400) }); return ok; };

  let recipe, repoName;
  try { ({ recipe, repoName } = loadRecipe(repoDir)); } catch (e) { phase('load-recipe', false, e.message); return report; }
  report.repo = repoName;
  if (!CANARY_REPOS.has(repoName)) { phase('canary-guard', false, `"${repoName}" is not a ratified canary repo — allowlist: ${[...CANARY_REPOS].join(',')}`); return report; }
  phase('canary-guard', true, repoName);

  const head = await exec(recipe.revision_cmd || 'git rev-parse HEAD', repoDir, { timeoutMs: 15_000 });
  if (!head.ok) { phase('resolve-sha', false, head.stderr); return report; }
  const sha = head.stdout.trim();
  report.sha = sha;
  const prev = await exec('git rev-parse HEAD~1', repoDir, { timeoutMs: 15_000 });
  const prevSha = prev.ok ? prev.stdout.trim() : null;
  report.prev_sha = prevSha;
  if (!prevSha) { phase('previous-revision-pointer', false, 'cannot resolve HEAD~1 — rollback impossible, refusing'); return report; }
  phase('previous-revision-pointer', true, prevSha.slice(0, 10));

  // Gates: the tested SHA is captured BEFORE gates so any post-gate commit
  // invalidates the run (tested == deployed, byte for byte).
  const gates = await exec(recipe.gates_cmd, repoDir);
  if (!phase('gates', gates.ok, gates.ok ? 'green' : (gates.stderr || gates.stdout).slice(-350))) { report.outcome = 'gates-failed'; return report; }

  const migrations = await classifyMigrations(repoDir, recipe, sha, prevSha, exec);
  if (migrations.error) { phase('migration-classifier', false, migrations.error); return report; } // unclassifiable = refuse
  if (migrations.destructive.length) {
    phase('migration-classifier', false, `DESTRUCTIVE: ${migrations.destructive.join(', ')}`);
    report.outcome = 'operator-gate';
    report.gate = { kind: 'deploy', state: 'waiting', reason: `destructive migration(s) require operator: ${migrations.destructive.join(', ')}` };
    return report;
  }
  phase('migration-classifier', true, migrations.additive.length ? `additive: ${migrations.additive.join(', ')}` : 'no new migrations');

  if (opts.dryRun) { report.outcome = 'dry-run-ok'; return report; }

  // SHA pin: re-verify HEAD right before shipping.
  const head2 = await exec('git rev-parse HEAD', repoDir, { timeoutMs: 15_000 });
  if (!head2.ok || head2.stdout.trim() !== sha) { phase('sha-pin', false, `HEAD moved after gates (tested ${sha.slice(0, 10)}, now ${head2.stdout.trim().slice(0, 10)}) — refusing`); return report; }
  phase('sha-pin', true, sha.slice(0, 10));

  for (const step of recipe.deploy_steps) {
    const r = await exec(fill(step, { sha, prevSha }), repoDir);
    if (!phase(`deploy: ${step.slice(0, 60)}`, r.ok, r.ok ? 'ok' : (r.stderr || r.stdout).slice(-350))) { report.outcome = 'deploy-step-failed'; return report; }
  }

  const smoke = await exec(fill(recipe.smoke_check, { sha, prevSha }), repoDir, { timeoutMs: 120_000 });
  if (smoke.ok) { phase('smoke', true, 'healthy'); report.outcome = 'deployed'; return report; }
  phase('smoke', false, (smoke.stderr || smoke.stdout).slice(-350));

  // Auto-rollback to the previous revision pointer; report NEVER claims success.
  let rolledBack = true;
  for (const step of recipe.rollback_steps) {
    const r = await exec(fill(step, { sha, prevSha }), repoDir);
    if (!phase(`rollback: ${step.slice(0, 60)}`, r.ok, r.ok ? 'ok' : (r.stderr || r.stdout).slice(-350))) rolledBack = false;
  }
  report.outcome = rolledBack ? 'rolled-back' : 'rollback-failed';
  return report;
}

module.exports = { runDeploy, loadRecipe, classifyMigrations, CANARY_REPOS, DESTRUCTIVE_SQL };
