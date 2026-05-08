'use strict';
/**
 * sidecar-spawn.cjs — Spawn a paired audit pane that watches an executor
 * coder mid-response (Task #12).
 *
 * Revives Layer 2 from docs/BRAINSTORM-look-ahead-context.md: paired
 * sidecar pane spawned with persona=sidecar for PRDs with ≥4 phases.
 * Watches its assigned coder, detects phase transitions, runs rolling
 * audits on phase N while coder is on phase N+1. Cost: 2x pane count.
 *
 * The actual watch-loop runs INSIDE the spawned Claude/Codex session
 * via the system prompt this module composes — wezbridge just spawns +
 * primes + records. Testable parts: prompt composition + manifest
 * recording.
 *
 * Library API:
 *   buildSidecarPrompt({ coderPaneId, taskDesc?, rubricPath?,
 *                        watchIntervalMin?, projectCwd? }) → string
 *   recordSidecar({ paneId, coderPaneId, baseCwd, ... }, opts?)
 */

const path = require('node:path');
const teamManifest = require('./team-manifest.cjs');

const DEFAULT_WATCH_INTERVAL_MIN = 2;

function buildSidecarPrompt({
  coderPaneId,
  taskDesc = '',
  rubricPath = '',
  watchIntervalMin = DEFAULT_WATCH_INTERVAL_MIN,
  projectCwd = '',
} = {}) {
  if (coderPaneId === undefined || coderPaneId === null) {
    throw new Error('buildSidecarPrompt: coderPaneId required');
  }
  const lines = [
    '[SIDECAR PANE BOOTSTRAP]',
    '',
    `You are an audit sidecar paired with coder pane ${coderPaneId}.`,
    'Your job is rolling audit, not coding. Do NOT modify files in this pane.',
    '',
    'Watch loop:',
    `  1. Every ${watchIntervalMin} minutes, read the last ~150 lines of pane ${coderPaneId} via wezbridge MCP read_output.`,
    `  2. Detect phase transitions in the coder's TodoList (if any).`,
    '  3. While the coder is on phase N+1, audit phase N\'s output against the rubric.',
    '  4. If you find a real issue, post an A2A envelope with type=progress to the coder, NOT type=error.',
    '  5. If a phase looks satisfied, stay quiet.',
    '',
    'Output discipline:',
    '  - Only post A2A envelopes for ACTIONABLE feedback. No play-by-play.',
    '  - Use scripts/outcome-grader.cjs (CLI) for structured grading when possible.',
    '  - End each watch tick with a one-line status comment in your own pane.',
  ];
  if (taskDesc) {
    lines.push('', 'TASK DESCRIPTION (verbatim from coder briefing):', taskDesc);
  }
  if (rubricPath) {
    lines.push('', `RUBRIC PATH: ${rubricPath} — read it once at start, reload if file changes.`);
  }
  if (projectCwd) {
    lines.push('', `Project cwd: ${projectCwd}`);
  }
  lines.push(
    '',
    'Begin your first watch tick now: read pane ' + coderPaneId + ' tail, post a one-line "[sidecar tick #1]" status comment, then sleep until the next interval.',
  );
  return lines.join('\n');
}

function recordSidecar(info, opts = {}) {
  if (!info || info.paneId === undefined) return false;
  return teamManifest.record({
    event: 'worktree_added', // sidecar tracked under same channel for v1
    pane_id: info.paneId,
    persona: 'sidecar',
    worktree_path: info.worktreePath || null,
    branch_name: info.branchName || null,
    base_cwd: info.baseCwd || null,
    sidecar_for: info.coderPaneId,
    spawned_at: new Date().toISOString(),
  }, opts);
}

module.exports = {
  DEFAULT_WATCH_INTERVAL_MIN,
  buildSidecarPrompt,
  recordSidecar,
};
