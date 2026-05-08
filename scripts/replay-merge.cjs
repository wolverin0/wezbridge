#!/usr/bin/env node
'use strict';
/**
 * replay-merge.cjs — Simulate a merge in an isolated git worktree to
 * preview the diff and any conflicts BEFORE landing on the real branch.
 *
 * Use case (Task #11): when safety-policy blocks `gh pr merge`, instead
 * of just denying, run the merge in a throwaway worktree and present a
 * preview. The user decides allow/deny with concrete evidence.
 *
 * Library API:
 *   previewMerge({ baseBranch, headBranch, baseCwd, worktreeDir? })
 *     → {
 *         ok: boolean,
 *         conflicts: string[],
 *         diffStat: string,
 *         summary: string,
 *         worktreePath: string | null,
 *         error?: string,
 *       }
 *
 * Cleanup is automatic on success or thrown error. The worktree always
 * branches from baseBranch HEAD; nothing the simulation does can touch
 * the real working copy or branches.
 *
 * CLI: node scripts/replay-merge.cjs <baseBranch> <headBranch>
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function _git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
}

function _quietGit(args, cwd) {
  try { return _git(args, cwd); }
  catch (e) { return e.stdout || e.stderr || ''; }
}

/**
 * Parse `git diff --stat` output into a normalized summary string.
 * Returns the raw stat — already human-readable, but trimmed.
 */
function summarizeDiffStat(rawStat) {
  if (!rawStat) return '(no diff)';
  return rawStat.trim().split('\n').filter(Boolean).join('\n');
}

/**
 * Extract conflict file paths from `git status --porcelain` output run
 * inside a merge-conflict state. Returns [] if no conflicts.
 */
function extractConflicts(porcelainOutput) {
  if (!porcelainOutput) return [];
  return porcelainOutput
    .split('\n')
    .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
    .map((line) => line.replace(/^\S+\s+/, '').trim())
    .filter(Boolean);
}

function previewMerge(opts = {}) {
  const baseBranch = opts.baseBranch || 'main';
  const headBranch = opts.headBranch;
  const baseCwd = opts.baseCwd || process.cwd();

  if (!headBranch) {
    return { ok: false, error: 'headBranch required', conflicts: [], diffStat: '', summary: '', worktreePath: null };
  }

  const tag = crypto.randomBytes(4).toString('hex');
  const worktreePath = opts.worktreeDir
    ? path.resolve(opts.worktreeDir)
    : path.join(os.tmpdir(), `wezbridge-replay-${tag}`);
  let worktreeAdded = false;

  try {
    // Add worktree at baseBranch
    _git(`worktree add --detach "${worktreePath}" "${baseBranch}"`, baseCwd);
    worktreeAdded = true;

    // Try the merge (no commit, no fast-forward — capture the merge artifact)
    let mergedClean = true;
    let mergeOutput = '';
    try {
      mergeOutput = _git(`merge --no-commit --no-ff "${headBranch}"`, worktreePath);
    } catch (mergeErr) {
      mergedClean = false;
      mergeOutput = String(mergeErr.stdout || '') + String(mergeErr.stderr || '');
    }

    const porcelain = _quietGit('status --porcelain', worktreePath);
    const conflicts = extractConflicts(porcelain);

    // Diff stat: what would actually land
    const diffStat = _quietGit(`diff --stat "${baseBranch}"...HEAD`, worktreePath);
    const summary = summarizeDiffStat(diffStat);

    return {
      ok: mergedClean && conflicts.length === 0,
      conflicts,
      diffStat,
      summary,
      worktreePath,
      mergeOutput: mergeOutput.trim(),
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      conflicts: [],
      diffStat: '',
      summary: '',
      worktreePath: worktreeAdded ? worktreePath : null,
    };
  } finally {
    // Always clean up the worktree
    if (worktreeAdded) {
      try { _git(`worktree remove --force "${worktreePath}"`, baseCwd); }
      catch { /* best-effort */ }
    }
  }
}

if (require.main === module) {
  const [baseBranch, headBranch] = process.argv.slice(2);
  if (!headBranch) {
    process.stderr.write('usage: replay-merge.cjs <baseBranch> <headBranch>\n');
    process.exit(2);
  }
  const result = previewMerge({ baseBranch, headBranch });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

module.exports = { previewMerge, summarizeDiffStat, extractConflicts };
