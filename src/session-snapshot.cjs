'use strict';
/**
 * session-snapshot.cjs — Capture + restore wezterm pane state across crashes.
 *
 * Pain point this fixes: WezTerm dies (mux crash, OS reboot, manual close) and
 * every running pane is lost. Re-spawning each one by hand is tedious because
 * each pane has different launch flags (Claude vs Codex, --channels,
 * --dangerously-skip-permissions, --continue, persona, cwd).
 *
 * This library snapshots every active AI pane's full launch state on a timer,
 * appending to vault/_wezbridge/session-snapshot.jsonl. After a crash, the
 * companion script `scripts/restore-session.cjs` reads the latest snapshot
 * and re-spawns each pane via `wezterm cli spawn`.
 *
 * Library API:
 *   classifyAI(cmdline, title?)             → 'claude' | 'codex' | null
 *   captureProcessCmdline(pid, opts?)       → string | null
 *   buildSnapshotEntry(pane, cmdline, ts)   → entry object | null
 *   appendSnapshot(entries, opts?)          → bool (true if written)
 *   readLatestSnapshot(opts?)               → array of entries
 *   readAllSnapshots(opts?)                 → all entries (for debugging)
 *
 * The capture filter is intentionally narrow — only panes running claude.exe
 * or codex.exe get snapshotted. Random shells, test runs, debugging panes,
 * and the dashboard daemon itself are skipped. This keeps restore focused
 * on AI sessions.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_LOG = path.resolve(__dirname, '..', 'vault', '_wezbridge', 'session-snapshot.jsonl');

const AI_CLI_PATTERNS = [
  { pattern: /\bclaude(?:\.exe)?\b/i, kind: 'claude' },
  { pattern: /\bcodex(?:\.exe)?\b/i, kind: 'codex' },
];

/**
 * Classify a process as a known AI CLI based on its command line + title.
 * Returns 'claude', 'codex', or null.
 */
function classifyAI(cmdline, title = '') {
  const haystack = `${cmdline || ''} ${title || ''}`;
  for (const { pattern, kind } of AI_CLI_PATTERNS) {
    if (pattern.test(haystack)) return kind;
  }
  return null;
}

/**
 * Read the full command line of a process by PID. Returns null if the process
 * is gone or inaccessible. Best-effort — uses Win32_Process on Windows and
 * `ps -p` elsewhere.
 */
function captureProcessCmdline(pid, opts = {}) {
  if (!pid || !Number.isFinite(Number(pid))) return null;
  const _exec = opts.exec || execFileSync;
  try {
    if (process.platform === 'win32') {
      const out = _exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const trimmed = (out || '').trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    const out = _exec('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = (out || '').trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Compose a snapshot entry from a discovered pane + its captured cmdline.
 * Returns null if the pane is not an AI session (filtered out).
 */
function buildSnapshotEntry(pane, cmdline, ts) {
  if (!pane || pane.pane_id == null) return null;
  const title = pane.title || '';
  const tabTitle = pane.tab_title || '';
  const ai = classifyAI(cmdline, `${title} ${tabTitle}`);
  if (!ai) return null;
  return {
    snapshot_ts: ts || new Date().toISOString(),
    pane_id: pane.pane_id,
    tab_id: pane.tab_id ?? null,
    window_id: pane.window_id ?? null,
    cwd: pane.cwd || null,
    pid: pane.pid ?? null,
    title,
    tab_title: tabTitle,
    cmdline: cmdline || null,
    ai,
  };
}

function _ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Append a batch of snapshot entries (one per AI pane) as a single JSONL
 * batch — every entry shares the same snapshot_ts so readLatestSnapshot can
 * reconstruct the most-recent group cleanly.
 *
 * Returns true if any entries were written.
 */
// Retention window: entries older than this are dropped on append so the log
// (and the LEADER+R restore picker) never fills with dead history again —
// 2,607 stale entries had accumulated by 2026-07-02. Override with
// WEZBRIDGE_SNAPSHOT_RETENTION_H (hours, 0 disables trimming).
const RETENTION_MS = (() => {
  const h = Number(process.env.WEZBRIDGE_SNAPSHOT_RETENTION_H);
  if (Number.isFinite(h)) return h <= 0 ? 0 : h * 3600 * 1000;
  return 24 * 3600 * 1000;
})();

function _trimOldEntries(logPath, now) {
  if (!RETENTION_MS || !fs.existsSync(logPath)) return;
  const cutoff = now - RETENTION_MS;
  const kept = fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      try { return Date.parse(JSON.parse(line).snapshot_ts) >= cutoff; }
      catch { return false; }
    });
  fs.writeFileSync(logPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
}

function appendSnapshot(entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const logPath = opts.logPath || DEFAULT_LOG;
  try {
    _ensureDir(logPath);
    _trimOldEntries(logPath, Date.now());
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(logPath, lines, 'utf8');
    return true;
  } catch (err) {
    if (typeof opts.log === 'function') opts.log(`session-snapshot append failed: ${err.message}`);
    return false;
  }
}

/** Read all entries from the JSONL log. Skips malformed lines. */
function readAllSnapshots(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG;
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Read entries belonging to the most-recent snapshot batch (i.e. the entries
 * with the maximum snapshot_ts). Used by restore-session.
 */
function readLatestSnapshot(opts = {}) {
  const all = readAllSnapshots(opts);
  if (all.length === 0) return [];
  let maxTs = '';
  for (const e of all) {
    if (e.snapshot_ts && e.snapshot_ts > maxTs) maxTs = e.snapshot_ts;
  }
  if (!maxTs) return [];
  return all.filter((e) => e.snapshot_ts === maxTs);
}

/**
 * T-0234: the RESTORE selector. "Latest group" is the wrong witness after a
 * crash: the first post-crash tick captures only the one pane the operator
 * already revived, and restoring THAT group (a) skips the fleet and (b) spawns
 * a `--continue` duplicate of the live session — both happened on 2026-08-24
 * (panes 6 and 8 duplicated the orchestrator; the 8-pane group sat 12 min
 * earlier in the log). The fleet you want back is the RICHEST recent group:
 * within `windowMs` of the newest group, pick the one with most panes; ties go
 * to the newest. Beyond the window, old rich groups are history, not state.
 */
function readRichestRecentSnapshot({ logPath, windowMs = 30 * 60_000, now = Date.now() } = {}) {
  const all = readAllSnapshots({ logPath });
  if (all.length === 0) return [];
  const groups = new Map(); // ts -> entries
  for (const e of all) {
    if (!e.snapshot_ts) continue;
    if (!groups.has(e.snapshot_ts)) groups.set(e.snapshot_ts, []);
    groups.get(e.snapshot_ts).push(e);
  }
  const cutoff = now - windowMs;
  let best = null;
  for (const [ts, entries] of groups) {
    const t = Date.parse(ts);
    if (Number.isNaN(t) || t < cutoff) continue;
    if (!best
      || entries.length > best.entries.length
      || (entries.length === best.entries.length && ts > best.ts)) {
      best = { ts, entries };
    }
  }
  return best ? best.entries : readLatestSnapshot({ logPath });
}

/**
 * Run one snapshot tick: list current panes via the supplied callback,
 * capture each AI pane's cmdline, append a batch entry to the JSONL log.
 * Returns the number of entries written.
 */
function snapshotOnce({ listPanes, capture, logPath, log, ts }) {
  const panes = (typeof listPanes === 'function') ? (listPanes() || []) : [];
  const captureFn = capture || captureProcessCmdline;
  const stamp = ts || new Date().toISOString();
  const entries = [];
  for (const pane of panes) {
    // cmdline_hint: injected by the daemon wiring from pane-discovery. Claude
    // Code sets session-TOPIC titles ("✳ Fix the parser") with no "claude" in
    // them, so title-regex classification silently captured NOTHING — the
    // 2026-07-02 crash had zero restorable snapshots because of this.
    const cmdline = pane.cmdline_hint || (pane.pid != null ? captureFn(pane.pid) : null);
    const entry = buildSnapshotEntry(pane, cmdline, stamp);
    if (entry) entries.push(entry);
  }
  if (entries.length > 0) appendSnapshot(entries, { logPath, log });
  return entries.length;
}

/**
 * Start a periodic snapshot watcher. Returns a stop() function.
 * intervalMs default 60s. Skips ticks where listPanes throws.
 */
function startWatcher({ listPanes, capture, logPath, log, intervalMs }) {
  const tick = () => {
    try { snapshotOnce({ listPanes, capture, logPath, log }); }
    catch (err) {
      if (typeof log === 'function') log(`session-snapshot tick failed: ${err.message}`);
    }
  };
  const handle = setInterval(tick, intervalMs || 60_000);
  if (handle && typeof handle.unref === 'function') handle.unref();
  tick(); // fire immediately so a snapshot exists right after boot
  return () => clearInterval(handle);
}

module.exports = {
  DEFAULT_LOG,
  AI_CLI_PATTERNS,
  classifyAI,
  captureProcessCmdline,
  buildSnapshotEntry,
  appendSnapshot,
  readAllSnapshots,
  readLatestSnapshot,
  readRichestRecentSnapshot,
  snapshotOnce,
  startWatcher,
};
