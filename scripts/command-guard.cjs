#!/usr/bin/env node
/**
 * command-guard.cjs — Pre-execution shim guard for destructive ops.
 *
 * Used by bin/guard-shims/{git,gh}.{sh,cmd} (slice 2+) to gate dangerous
 * commands BEFORE they reach the real binary. Closes the babysit Monitor's
 * post-hoc detection gap (mm-d752): wezterm cli get-text polling can only
 * DETECT a `gh pr merge` that already landed on GitHub seconds ago; this
 * guard blocks the call before exec.
 *
 * Two modes:
 *   1. Library:  const { evaluate } = require('./command-guard.cjs')
 *                evaluate(['git','push','origin','main'])
 *                // → { allowed: false, reason: 'git push to main/master' }
 *   2. CLI:      node command-guard.cjs git push origin main
 *                # exits 0 if allowed, 1 if blocked (reason on stderr)
 *
 * Override: set WEZBRIDGE_GUARD_OVERRIDE=1 to bypass once. The shim
 * (slice 2) is responsible for unsetting it after consumption so the
 * bypass only applies to the immediate command, not the whole shell.
 *
 * Sibling: scripts/commit-guard.js gates at git pre-commit / Claude
 * PreToolUse. This is its pre-execution counterpart for `git`/`gh` shells.
 */

const DESTRUCTIVE_PATTERNS = [
  {
    name: 'git_push_to_default_branch',
    test: (argv) =>
      argv[0] === 'git' &&
      argv[1] === 'push' &&
      argv.slice(2).some((a) =>
        ['main', 'master', 'origin/main', 'origin/master', 'HEAD:main', 'HEAD:master'].includes(a),
      ),
    reason: 'git push to main/master — protected branch',
  },
  {
    name: 'git_push_force',
    test: (argv) =>
      argv[0] === 'git' &&
      argv[1] === 'push' &&
      argv.slice(2).some((a) => a === '--force' || a === '-f' || a === '--force-with-lease' || /^-\w*f$/.test(a)),
    reason: 'git push --force / -f — rewrites remote history',
  },
  {
    name: 'git_reset_hard',
    test: (argv) =>
      argv[0] === 'git' &&
      argv[1] === 'reset' &&
      argv.slice(2).includes('--hard'),
    reason: 'git reset --hard — discards working changes',
  },
  {
    name: 'git_checkout_dot',
    test: (argv) =>
      argv[0] === 'git' &&
      argv[1] === 'checkout' &&
      argv.slice(2).includes('.'),
    reason: 'git checkout . — mass-discards local changes',
  },
  {
    name: 'git_clean_fd',
    test: (argv) =>
      argv[0] === 'git' &&
      argv[1] === 'clean' &&
      argv.slice(2).some((a) => /^-\w*f\w*d/.test(a) || /^-\w*d\w*f/.test(a)),
    reason: 'git clean -fd / -fdx — deletes untracked files',
  },
  {
    name: 'git_branch_force_delete',
    test: (argv) =>
      argv[0] === 'git' &&
      argv[1] === 'branch' &&
      argv.slice(2).includes('-D'),
    reason: 'git branch -D — force-delete branch with unmerged work',
  },
  {
    name: 'gh_pr_merge',
    test: (argv) =>
      argv[0] === 'gh' &&
      argv[1] === 'pr' &&
      argv[2] === 'merge',
    reason: 'gh pr merge — auto-merge to base branch (usually main)',
  },
];

/**
 * Evaluate an argv array against destructive patterns.
 * @param {string[]} argv - command tokens, e.g. ['git','push','origin','main']
 * @returns {{allowed: boolean, reason: string, matched?: string}}
 */
function evaluate(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { allowed: true, reason: 'empty argv' };
  }
  if (process.env.WEZBRIDGE_GUARD_OVERRIDE === '1') {
    return { allowed: true, reason: 'WEZBRIDGE_GUARD_OVERRIDE=1' };
  }
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(argv)) {
      return { allowed: false, reason: pattern.reason, matched: pattern.name };
    }
  }
  return { allowed: true, reason: 'no destructive pattern matched' };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const result = evaluate(argv);
  if (!result.allowed) {
    process.stderr.write(`command-guard: BLOCKED — ${result.reason}\n`);
    process.stderr.write(`command-guard: command was: ${argv.join(' ')}\n`);
    process.stderr.write(
      `command-guard: to bypass once, prefix with WEZBRIDGE_GUARD_OVERRIDE=1 (e.g. WEZBRIDGE_GUARD_OVERRIDE=1 ${argv.join(' ')})\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

module.exports = { evaluate, DESTRUCTIVE_PATTERNS };
