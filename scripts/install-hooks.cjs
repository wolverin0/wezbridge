#!/usr/bin/env node
'use strict';
/**
 * install-hooks.cjs — copy wezbridge git hooks into the current repo's
 * .git/hooks/ directory.
 *
 * Per-repo opt-in: cd into a repo, run `node /path/to/wezbridge/scripts/install-hooks.cjs`
 * (or via npm: `npm run wezbridge:install-hooks` if the script is wired
 * into the target repo's package.json).
 *
 * Currently installs:
 *   bin/git-hooks/pre-push → .git/hooks/pre-push
 *
 * Task #10 from docs/PLAN-managed-agents-backfill.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_SRC_DIR = path.join(REPO_ROOT, 'bin', 'git-hooks');

function gitRoot(cwd = process.cwd()) {
  try {
    return execSync('git rev-parse --git-dir', {
      cwd, encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch (e) {
    throw new Error(`not in a git repo: ${cwd}`);
  }
}

function installHook(hookName, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;

  const src = path.join(HOOKS_SRC_DIR, hookName);
  if (!fs.existsSync(src)) {
    throw new Error(`source hook not found: ${src}`);
  }

  const gitDir = gitRoot(cwd);
  const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);
  const hooksDir = path.join(absGitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const dst = path.join(hooksDir, hookName);

  // Skip if a hook already exists and isn't ours
  if (fs.existsSync(dst) && !force) {
    const existing = fs.readFileSync(dst, 'utf8');
    if (!/wezbridge[- ]pre-push|wezbridge\/bin\/git-hooks/.test(existing)) {
      return { ok: false, reason: `existing non-wezbridge hook at ${dst}; pass force=true to overwrite`, dst };
    }
  }

  if (dryRun) return { ok: true, dryRun: true, src, dst };

  // Copy + chmod 0o755
  const content = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dst, content, { mode: 0o755 });
  try { fs.chmodSync(dst, 0o755); } catch { /* Windows */ }

  return { ok: true, src, dst };
}

function installAll(opts = {}) {
  const results = [];
  for (const hook of fs.readdirSync(HOOKS_SRC_DIR)) {
    const r = installHook(hook, opts);
    results.push({ hook, ...r });
  }
  return results;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  try {
    const results = installAll({ dryRun, force });
    for (const r of results) {
      if (r.ok) {
        process.stdout.write(`installed: ${r.hook} → ${r.dst}${r.dryRun ? ' (dry-run)' : ''}\n`);
      } else {
        process.stderr.write(`SKIPPED: ${r.hook} — ${r.reason}\n`);
      }
    }
    const anyFail = results.some((r) => !r.ok);
    process.exit(anyFail ? 1 : 0);
  } catch (e) {
    process.stderr.write(`install-hooks: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { installHook, installAll, HOOKS_SRC_DIR };
