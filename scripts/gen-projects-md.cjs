#!/usr/bin/env node
'use strict';
/**
 * gen-projects-md.cjs — writes _intel/PROJECTS.md, the operator's marking sheet.
 *
 * WHY IT EXISTS. The loop can find stale work, but it cannot know whether a
 * project MATTERS — and the standing hard rule is that project selection belongs
 * to the operator alone: never sort, rank, label, archive or decide which are
 * "active" or "dead". So this emits FACTS ONLY, alphabetically, with the decision
 * column left unset. Pre-filling my guesses would be exactly the labelling the
 * rule forbids, and it would put my assumptions into a file that later drives
 * dispatch.
 *
 * The output is meant to be READ BY CODE afterwards, not just by a human — a
 * marking sheet nothing consumes is another document. The table format is the
 * contract: pipe-delimited, project name in column 1, marker in column 2.
 *
 * Regenerate any time: node wezbridge/scripts/gen-projects-md.cjs
 * It PRESERVES existing markers, so regenerating never erases the operator's
 * decisions — a generator that clobbers its own input is a trap.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(ROOT, '_intel');
const OUT = path.join(INTEL, 'PROJECTS.md');
const OPEN = ['ready', 'queued', 'running', 'review', 'blocked', 'failed'];

/** Markers the operator may write. Anything else is treated as unset. */
const MARKERS = ['ACTIVE', 'WATCH', 'PARKED', 'DEAD'];

function openTaskCounts() {
  const by = {};
  try {
    for (const f of fs.readdirSync(path.join(INTEL, 'tasks'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(INTEL, 'tasks', f), 'utf8'));
        if (OPEN.includes(t.state)) by[t.repo] = (by[t.repo] || 0) + 1;
      } catch { /* skip */ }
    }
  } catch { /* no ledger */ }
  return by;
}

function lastCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%cs'],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || '-';
  } catch { return '-'; }
}

/** Read markers already written, so a regeneration never loses a decision. */
function existingMarkers() {
  const out = {};
  let text;
  try { text = fs.readFileSync(OUT, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([A-Z?]*)\s*\|/);
    if (m && MARKERS.includes(m[2])) out[m[1]] = m[2];
  }
  return out;
}

function main() {
  const counts = openTaskCounts();
  const prior = existingMarkers();
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const rows = dirs.map((name) => {
    const full = path.join(ROOT, name);
    const git = fs.existsSync(path.join(full, '.git'));
    return {
      name,
      marker: prior[name] || '',
      git: git ? 'yes' : 'no',
      commit: git ? lastCommit(full) : '-',
      open: counts[name] || 0,
      goal: fs.existsSync(path.join(full, '.orchestrator', 'GOAL.md')) ? 'yes' : '-',
      graph: fs.existsSync(path.join(full, '.agent-workflow', 'graph.json')) ? 'yes' : '-',
      brain: ['CLAUDE.md', 'AGENTS.md'].some((f) => fs.existsSync(path.join(full, f))) ? 'yes' : '-',
    };
  });

  const head = `# Py Apps — project marking sheet

**Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z. ${rows.length} directories, alphabetical.**
Everything below is a measured fact except the **mark** column, which is yours. It is left blank on
purpose: deciding which projects are active is your call alone, and pre-filling my guesses would put my
assumptions into the file that drives dispatch.

## How to use it

Write one word in the **mark** column. Regenerating this file preserves what you wrote.

| mark | what the fleet does with it |
|---|---|
| \`ACTIVE\` | Full loop: findings raised, a \`GOAL.md\` is required, routines may run, work is dispatched to a pane. |
| \`WATCH\` | Stays in the ledger and findings are raised, but nothing is dispatched without asking you first. |
| \`PARKED\` | Excluded from the loop. No findings, no goal expected, no nagging. Not a judgement about the project. |
| \`DEAD\` | Stop reading it entirely. Nothing scans it, nothing reports on it. |
| *(blank)* | Unset. Treated as \`PARKED\` by the loop, and listed back to you as undecided. |

Nothing is renamed, moved, archived or deleted by any mark. This file only controls what the fleet
*pays attention to*.

## Columns

- **git / last commit** — whether it is versioned and when it last changed. A routine cannot run on an
  unversioned tree; the runner refuses it outright.
- **open** — open tasks in the fleet ledger right now.
- **goal** — has \`.orchestrator/GOAL.md\`, which is what lets the loop judge whether a finding *matters*
  rather than only that it is old.
- **graph** — has \`.agent-workflow/graph.json\`, the per-repo contract saying which work needs you.
- **brain** — has a \`CLAUDE.md\` or \`AGENTS.md\`.

| project | mark | git | last commit | open | goal | graph | brain |
|---|---|---|---|---|---|---|---|`;

  const body = rows.map((r) => `| \`${r.name}\` | ${r.marker} | ${r.git} | ${r.commit} | ${r.open || ''} | ${r.goal} | ${r.graph} | ${r.brain} |`);

  const marked = rows.filter((r) => r.marker).length;
  const foot = `
---

**${marked} of ${rows.length} marked.** Unmarked entries are treated as \`PARKED\` and reported back as
undecided rather than guessed at.

Regenerate with \`node wezbridge/scripts/gen-projects-md.cjs\` — it re-reads the tree and keeps your marks.`;

  fs.writeFileSync(OUT, [head, ...body, foot].join('\n') + '\n');
  console.log(`gen-projects-md: wrote ${OUT} (${rows.length} directories, ${marked} already marked)`);
}

if (require.main === module) main();
module.exports = { MARKERS, existingMarkers };
