#!/usr/bin/env node
'use strict';
// Cross-project branch provenance is an action-log fact, never guessed from author names or pane IDs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ACTIONS = new Set(['branch_work', 'branch_create', 'worktree_create']);

function branchActivities(intelDir) {
  let text;
  try { text = fs.readFileSync(path.join(intelDir, 'actions.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const latest = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row) || !ACTIONS.has(row.action)) continue;
    const source = row.extra?.source_project;
    const branch = row.extra?.branch;
    if (typeof source !== 'string' || typeof row.project !== 'string' || typeof branch !== 'string') continue;
    if (!source || !row.project || !/^fix\//.test(branch)) continue;
    if (source.toLowerCase() === row.project.toLowerCase()) continue;
    const key = JSON.stringify([source, row.project, branch, row.extra?.worktree || '', row.corr || null, row.task || null]);
    const previous = latest.get(key);
    const times = [previous?.first_ms, Date.parse(row.ts)].filter(Number.isFinite);
    latest.set(key, { ...row, source, branch, key, first_ms: times.length ? Math.min(...times) : null });
  }
  return [...latest.values()];
}

function auditCrossRepo(tasks, intelDir, now) {
  return branchActivities(intelDir).filter(event => !tasks.some(task =>
    typeof event.corr === 'string' && event.corr.trim() && task.repo === event.project
    && task.corr === event.corr && (!event.task || event.task === task.id)))
    .map(event => ({
      id: 'X-branch-' + crypto.createHash('sha256').update(event.key).digest('hex').slice(0, 16),
      repo: event.project, state: 'hygiene', owner: event.source, category: 'cross-repo-unticketed',
      title: `${event.source} branch work in ${event.project} lacks a correlated card`,
      age_hours: Math.max(0, Math.floor((now - (event.first_ms ?? now)) / 3600000)),
      why: `${event.source} recorded ${event.branch} in ${event.project}; no card matches repo and corr ${event.corr || '(missing)'}`,
    }));
}

function recordBranchWork({ sourceProject, repo, cwd, corr, task, logAction }) {
  if (![sourceProject, repo, cwd].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('record requires --from, --repo and --cwd');
  }
  const branch = execFileSync('git', ['-C', cwd, 'branch', '--show-current'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  if (!/^fix\//.test(branch)) throw new Error('record requires a checked-out fix/* branch');
  const write = logAction || require('../src/action-log.cjs').logAction;
  const recorded = write('branch_work', { project: repo, corr, task, target: cwd,
    why: 'T-0327 branch provenance; a card/correlation does not grant merge authority',
    extra: { source_project: sourceProject, branch, worktree: path.resolve(cwd) } });
  if (recorded !== true) throw new Error('branch provenance was not durably recorded');
  return { recorded: true, source_project: sourceProject, repo, branch, corr: corr || null };
}

function main(argv) {
  if (argv[0] !== 'record') throw new Error('usage: cross-repo-audit.cjs record --from <project> --repo <target> --cwd <worktree> [--corr <corr>] [--task <id>]');
  const value = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  console.log(JSON.stringify(recordBranchWork({ sourceProject: value('--from'), repo: value('--repo'),
    cwd: value('--cwd'), corr: value('--corr'), task: value('--task') })));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { auditCrossRepo, recordBranchWork };
