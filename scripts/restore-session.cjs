#!/usr/bin/env node
'use strict';
/**
 * restore-session.cjs — Re-spawn AI panes from the most recent session snapshot.
 *
 * Usage:
 *   node scripts/restore-session.cjs [--dry-run] [--stagger-ms N] [--filter regex]
 *
 * Options:
 *   --dry-run        Print what would be spawned, don't actually spawn.
 *   --stagger-ms N   Wait N ms between spawns (default 2000) — keeps the
 *                    telegram channel-plugin race in check when restoring
 *                    multiple --channels panes.
 *   --filter REGEX   Only restore entries whose cwd OR cmdline matches REGEX.
 *
 * Read latest snapshot from vault/_wezbridge/session-snapshot.jsonl
 * (or path passed via WEZBRIDGE_SESSION_SNAPSHOT_LOG env var). For each
 * entry, run `wezterm cli spawn --cwd <cwd> -- <cmdline parts>`.
 *
 * Prerequisite: WezTerm must be running (mux alive). If wezterm crashed,
 * start a single new wezterm pane manually first, then run this script
 * from inside it — the new panes will be added as additional tabs.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const snap = require(path.resolve(__dirname, '..', 'src', 'session-snapshot.cjs'));

function parseArgs(argv) {
  const out = { dryRun: false, staggerMs: 2000, filter: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--stagger-ms') out.staggerMs = parseInt(argv[++i], 10) || 2000;
    else if (a === '--filter') out.filter = new RegExp(argv[++i]);
  }
  return out;
}

function splitCmdline(cmdline) {
  if (!cmdline) return [];
  // Naive splitter — handles quoted args. Good enough for claude/codex
  // launches which are space-separated with no shell metacharacters.
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmdline.length; i++) {
    const c = cmdline[i];
    if (q) {
      if (c === q) { q = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ' ' || c === '\t') {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

// The resume command per agent. Snapshots capture ai via title/discovery hint
// and usually have a null cmdline (headless pid unknown), so we reconstruct the
// launch from `ai` rather than replaying a captured process line.
//
// Codex: NEVER pin to an exact session id — codex resume <uuid> is fragile (a
// corrupt/oversized session kills the pane, e.g. pedrito 2026-07-15). Use
// `codex resume --yolo`: full-access (bypass approvals/sandbox) and codex picks
// the right session for the pane's cwd (its picker defaults to the Cwd filter).
function resumeCommandFor(ai) {
  if (ai === 'codex') return 'codex resume --yolo';
  return 'claude --continue --dangerously-skip-permissions';       // default: claude
}

function spawnPane(entry, opts = {}) {
  const cwd = entry.cwd ? entry.cwd.replace(/^file:\/\/[^/]*/, '').replace(/%20/g, ' ') : '';
  const parts = splitCmdline(entry.cmdline);

  // Path A: a real captured cmdline → replay it verbatim (legacy snapshots).
  if (parts.length > 0) {
    const args = ['cli', 'spawn'];
    if (cwd) args.push('--cwd', cwd);
    args.push('--', ...parts);
    if (opts.dryRun) { console.log(`[dry-run] wezterm ${args.join(' ')}`); return true; }
    const res = spawnSync('wezterm', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      console.error(`[restore] failed pane ${entry.pane_id}: ${res.error ? res.error.message : 'exit ' + res.status + ' ' + (res.stderr || '').trim()}`);
      return false;
    }
    console.log(`[restore] spawned ${entry.ai} pane (was ${entry.pane_id}, now ${(res.stdout || '').trim()}) cwd=${cwd}`);
    return true;
  }

  // Path B: no cmdline → spawn a shell, then type the agent's resume command.
  const cmd = resumeCommandFor(entry.ai);
  if (opts.dryRun) { console.log(`[dry-run] spawn shell @ ${cwd} → "${cmd}"`); return true; }
  const spawnArgs = ['cli', 'spawn'];
  if (cwd) spawnArgs.push('--cwd', cwd);
  const res = spawnSync('wezterm', spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    console.error(`[restore] failed pane ${entry.pane_id}: ${res.error ? res.error.message : 'exit ' + res.status}`);
    return false;
  }
  const newPaneId = (res.stdout || '').trim();
  spawnSync('wezterm', ['cli', 'send-text', '--pane-id', newPaneId, '--no-paste'], { input: cmd + '\r', encoding: 'utf8' });
  console.log(`[restore] spawned ${entry.ai || 'shell'} pane (was ${entry.pane_id}, now ${newPaneId}) cwd=${cwd} → ${cmd}`);
  return true;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logPath = process.env.WEZBRIDGE_SESSION_SNAPSHOT_LOG || undefined;
  const entries = snap.readLatestSnapshot({ logPath });
  if (entries.length === 0) {
    console.error('[restore] no snapshot found. Has the session-snapshot daemon ever run?');
    console.error(`[restore]   expected: ${logPath || snap.DEFAULT_LOG}`);
    process.exit(1);
  }
  const filtered = opts.filter
    ? entries.filter((e) => opts.filter.test(e.cwd || '') || opts.filter.test(e.cmdline || ''))
    : entries;

  console.log(`[restore] latest snapshot ts=${entries[0].snapshot_ts}, ${filtered.length}/${entries.length} entries to restore`);
  if (opts.dryRun) console.log('[restore] DRY RUN — no panes will be spawned');

  let ok = 0;
  for (let i = 0; i < filtered.length; i++) {
    const e = filtered[i];
    if (spawnPane(e, opts)) ok++;
    if (i < filtered.length - 1 && opts.staggerMs > 0 && !opts.dryRun) {
      await sleep(opts.staggerMs);
    }
  }
  console.log(`[restore] done. ${ok}/${filtered.length} spawned successfully.`);
  process.exit(ok === filtered.length ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[restore] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, splitCmdline };
