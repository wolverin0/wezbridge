'use strict';
/**
 * orca-census.cjs — census, crash-restore snapshot and durable WORKER_DONE events for ORCA terminals (T-0525).
 * Covers: `orca terminal list --json` normalization, _intel/orca-census.json, the `orca` block of
 * /api/health + bridge_health, vault/_wezbridge/orca-session-snapshot.jsonl, and the WORKER_DONE poller
 * that appends {event:'worker-done'} to _intel/pane-events.jsonl.
 * Key terms: runOrca (injectable CLI double), healthBlock, readRichestOrcaSnapshot, ECHO_MARKERS.
 * Read when: bridge_health says pane_count 0 while the fleet runs in Orca, or a crash-restore must recreate Orca terminals.
 * Never throws: every failure lands in last_error / {ok:false, reason}.
 *
 * WHY. The fleet moved from WezTerm panes to Orca terminals; the pane census, the
 * session snapshot and completion detection all looked at WezTerm only, so health said
 * pane_count 0 and a crash left nothing to restore. Everything here is ASYNC (execFile),
 * so the daemon event loop is never blocked by the Orca CLI (the T-0321 lesson).
 *
 * The Orca snapshot lives in its OWN jsonl, not in session-snapshot.jsonl: every line
 * of that file is read as a WezTerm pane by scripts/restore-session.cjs and by the
 * LEADER+R picker in wezterm/wezbridge.lua, so mixing Orca entries there would make
 * restore spawn bogus WezTerm panes.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const DEFAULT_ORCA_BIN = process.env.ORCA_CLI
  || 'C:/Users/pauol/AppData/Local/Programs/orca/resources/bin/orca.exe';
const DEFAULT_INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
const DEFAULT_SNAPSHOT_LOG = path.resolve(__dirname, '..', 'vault', '_wezbridge', 'orca-session-snapshot.jsonl');
const PROVIDERS = ['claude', 'codex', 'gemini', 'shell'];
const SNAPSHOT_RETENTION_MS = 24 * 3600 * 1000;
const SNAPSHOT_REFRESH_MS = 3600 * 1000; // re-append an unchanged set hourly so retention never empties the log
const SEEN_MAX = 2000;

// Same filter as scripts/orchestration/foreman.py: these lines echo a DISPATCH
// (instruction text, templates), not a worker's closure.
const SENTINEL_RE = /\[WORKER_DONE\]\s+task_id=([^\s<>]+)(?:\s+outcome=(succeeded|failed))?/;
const ECHO_MARKERS = ['[ORCHESTRATOR]', '[MISSION]', 'emiti', 'emití', 'report=<'];

/** Default CLI runner: async, bounded, never blocks the caller's event loop. */
function defaultRunOrca(args, { bin = DEFAULT_ORCA_BIN, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { err.message = `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`; return reject(err); }
        resolve(stdout);
      });
  });
}

function guessProvider(t) {
  const ident = String(t.agentIdentity || '').toLowerCase();
  if (PROVIDERS.includes(ident) && ident !== 'shell') return ident;
  const hay = `${t.title || ''}\n${t.preview || ''}`;
  if (/gemini/i.test(hay)) return 'gemini';
  if (/codex|Ask Codex|\bgpt-\d/i.test(hay)) return 'codex';
  if (/claude|^[\u2733\u25D0-\u25D3\u2722-\u273D\u00B7*]\s/i.test(t.title || '') || /Claude Code|bypass permissions/i.test(hay)) return 'claude';
  return 'shell';
}

function normalizeTerminal(t) {
  if (!t || typeof t !== 'object' || !t.handle) return null;
  return {
    handle: String(t.handle),
    title: t.title == null ? '' : String(t.title),
    worktreePath: t.worktreePath || null,
    branch: t.branch || null,
    connected: t.connected === true,
    writable: t.writable === true,
    provider: guessProvider(t),
    tabId: t.tabId || null,
    lastOutputAt: Number.isFinite(t.lastOutputAt) ? t.lastOutputAt : null,
    exitCause: t.exitCause && t.exitCause.kind ? t.exitCause.kind : null,
  };
}

/** Parse `orca terminal list --json` stdout. Returns {ok, terminals, truncated} or {ok:false, reason}. */
function parseTerminalList(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch (e) { return { ok: false, reason: `unparseable orca output: ${e.message}` }; }
  if (!j || j.ok === false) return { ok: false, reason: `orca error: ${JSON.stringify(j && (j.error || j)).slice(0, 200)}` };
  const raw = (j.result && Array.isArray(j.result.terminals)) ? j.result.terminals
    : (Array.isArray(j.terminals) ? j.terminals : null);
  if (!raw) return { ok: false, reason: 'orca output has no result.terminals array' };
  return { ok: true, terminals: raw.map(normalizeTerminal).filter(Boolean), truncated: !!(j.result && j.result.truncated) };
}

/** One census. Never throws. */
async function runCensus({ runOrca = defaultRunOrca, now = Date.now } = {}) {
  let stdout;
  try { stdout = await runOrca(['terminal', 'list', '--json']); }
  catch (e) { return { ok: false, at: now(), reason: `orca cli: ${e && e.message ? e.message : String(e)}` }; }
  const parsed = parseTerminalList(stdout);
  return { ...parsed, at: now() };
}

function summarize(terminals) {
  const by_provider = {};
  let connected = 0;
  for (const t of terminals) {
    by_provider[t.provider] = (by_provider[t.provider] || 0) + 1;
    if (t.connected) connected += 1;
  }
  return { terminals: terminals.length, connected, by_provider };
}

/** Health block from a cached state {last (good census), lastError, lastAttemptAt}. */
function buildHealthBlock(state, now = Date.now()) {
  const last = state && state.last;
  if (!last) {
    return { terminals: 0, connected: 0, by_provider: {}, census_age_ms: null,
      last_error: (state && state.lastError) || 'no census yet', list: [] };
  }
  return {
    ...summarize(last.terminals),
    census_age_ms: now - last.at,
    last_error: state.lastError || null,
    truncated: !!last.truncated,
    list: last.terminals.map((t) => ({ handle: t.handle, title: t.title, worktreePath: t.worktreePath,
      connected: t.connected, provider: t.provider })),
  };
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Read the persisted census (fallback for bridge_health when the daemon is down). */
function readPersistedCensus(intelDir = DEFAULT_INTEL, now = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(intelDir, 'orca-census.json'), 'utf8'));
    const state = { last: j.last_good || null, lastError: j.last_error || null };
    return { ...buildHealthBlock(state, now), source: 'file' };
  } catch (e) { return null; }
}

// ─── snapshot ──────────────────────────────────────────────────────────────

function restoreArgv(t) {
  const argv = ['terminal', 'create'];
  if (t.worktreePath) argv.push('--worktree', `path:${t.worktreePath}`);
  if (t.title) argv.push('--title', t.title);
  argv.push('--json');
  return argv;
}

function buildOrcaSnapshot(terminals, ts = new Date().toISOString()) {
  return {
    snapshot_ts: ts,
    source: 'orca',
    terminals: terminals.map((t) => ({
      handle: t.handle, title: t.title, worktreePath: t.worktreePath, branch: t.branch,
      provider: t.provider, connected: t.connected, restore_argv: restoreArgv(t),
    })),
  };
}

function readOrcaSnapshots(logPath = DEFAULT_SNAPSHOT_LOG) {
  try {
    return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && Array.isArray(e.terminals));
  } catch { return []; }
}

function snapshotKey(terminals) {
  return terminals.map((t) => `${t.handle}|${t.title}|${t.worktreePath}`).sort().join('\n');
}

/**
 * Append a snapshot line when the terminal set changed (or hourly). Empty sets are
 * never written: right after a crash Orca lists 0 terminals, and that must not
 * become "the latest state". Returns true when a line was written.
 */
function appendOrcaSnapshot(terminals, { logPath = DEFAULT_SNAPSHOT_LOG, now = Date.now() } = {}) {
  if (!Array.isArray(terminals) || terminals.length === 0) return false;
  const all = readOrcaSnapshots(logPath);
  const prev = all[all.length - 1];
  if (prev && snapshotKey(prev.terminals) === snapshotKey(terminals)
    && now - Date.parse(prev.snapshot_ts) < SNAPSHOT_REFRESH_MS) return false;
  const kept = all.filter((e) => now - Date.parse(e.snapshot_ts) < SNAPSHOT_RETENTION_MS);
  kept.push(buildOrcaSnapshot(terminals, new Date(now).toISOString()));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const tmp = `${logPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, logPath);
  return true;
}

/** Restore selector (same rule as readRichestRecentSnapshot): richest line within windowMs of the newest. */
function readRichestOrcaSnapshot({ logPath = DEFAULT_SNAPSHOT_LOG, windowMs = 30 * 60_000 } = {}) {
  const all = readOrcaSnapshots(logPath);
  if (!all.length) return null;
  const newest = Math.max(...all.map((e) => Date.parse(e.snapshot_ts) || 0));
  let best = null;
  for (const e of all) {
    if ((Date.parse(e.snapshot_ts) || 0) < newest - windowMs) continue;
    if (!best || e.terminals.length > best.terminals.length
      || (e.terminals.length === best.terminals.length && e.snapshot_ts > best.snapshot_ts)) best = e;
  }
  return best;
}

// ─── WORKER_DONE poller ──────────────────────────────────────────────────

/** Foreman state files: {terminal|term_id|handle, task_id, status} or an array/{workers:[]} of them. */
function readSupervised(intelDir = DEFAULT_INTEL) {
  const dir = path.join(intelDir, 'foreman');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const items = Array.isArray(j) ? j : (j && Array.isArray(j.workers) ? j.workers : [j]);
    for (const it of items) {
      if (!it || it.status !== 'supervising') continue;
      const terminal = it.terminal || it.term_id || it.handle;
      if (terminal) out.push({ terminal: String(terminal), task_id: it.task_id || null });
    }
  }
  return out;
}

/** Real closures on a screen: [{line, task_id, outcome}], echoes filtered out. */
function extractDoneLines(screenLines) {
  const out = [];
  for (const raw of screenLines || []) {
    const line = String(raw).trim();
    if (!line.includes('[WORKER_DONE]')) continue;
    if (ECHO_MARKERS.some((m) => line.includes(m))) continue;
    const m = SENTINEL_RE.exec(line);
    if (!m) continue;
    out.push({ line, task_id: m[1], outcome: m[2] || null });
  }
  return out;
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function loadSeen(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * One poll pass. Appends {time, ts, event:'worker-done', source:'orca', terminal, task_id,
 * outcome, line, repo} to pane-events.jsonl for each NEW closure line (dedupe by
 * sha1(terminal + line), persisted so a daemon restart does not re-emit).
 */
async function pollWorkerDone({ runOrca = defaultRunOrca, intelDir = DEFAULT_INTEL, now = Date.now, terminals = [] } = {}) {
  const supervised = readSupervised(intelDir);
  const result = { polled: 0, appended: [], errors: [] };
  if (!supervised.length) return result;
  const seenFile = path.join(intelDir, '.orca-done-seen.json');
  const seenList = loadSeen(seenFile);
  const seen = new Set(seenList);
  const wtOf = new Map(terminals.map((t) => [t.handle, t.worktreePath]));
  for (const s of supervised) {
    result.polled += 1;
    let lines;
    try {
      const j = JSON.parse(await runOrca(['terminal', 'read', '--terminal', s.terminal, '--screen', '--json']));
      const r = (j && j.result) || {};
      lines = (r.terminal && r.terminal.tail) || r.lines || [];
    } catch (e) { result.errors.push(`${s.terminal}: ${e.message}`); continue; }
    for (const d of extractDoneLines(lines)) {
      if (s.task_id && d.task_id !== s.task_id && !d.task_id.includes(s.task_id)) continue;
      const h = sha1(`${s.terminal}\n${d.line}`);
      if (seen.has(h)) continue;
      seen.add(h); seenList.push(h);
      const iso = new Date(now()).toISOString();
      const wt = wtOf.get(s.terminal) || null;
      const evt = { time: iso, ts: iso, event: 'worker-done', source: 'orca', terminal: s.terminal,
        task_id: d.task_id, outcome: d.outcome, line: d.line,
        repo: wt ? path.basename(wt) : null };
      try {
        fs.mkdirSync(intelDir, { recursive: true });
        fs.appendFileSync(path.join(intelDir, 'pane-events.jsonl'), JSON.stringify(evt) + '\n', 'utf8');
        result.appended.push(evt);
      } catch (e) { result.errors.push(`append: ${e.message}`); }
    }
  }
  if (result.appended.length) {
    try { writeJsonAtomic(seenFile, seenList.slice(-SEEN_MAX)); } catch (e) { result.errors.push(`seen: ${e.message}`); }
  }
  return result;
}

// ─── the daemon-side loop ────────────────────────────────────────────────

/**
 * Start the Orca census loop (async, unref'd timers). Returns {status, healthBlock, tick, stop}.
 * snapshotIntervalMs 0 disables the snapshot; the done poller runs every tick.
 */
function startOrcaCensus({
  runOrca = defaultRunOrca, intelDir = DEFAULT_INTEL, intervalMs = 20000,
  snapshotIntervalMs = 60000, snapshotLogPath = DEFAULT_SNAPSHOT_LOG,
  log = () => {}, now = Date.now, autoStart = true,
} = {}) {
  const state = { last: null, lastError: null, lastAttemptAt: 0, lastSnapshotAt: 0, running: false,
    ticks: 0, doneEvents: 0, timer: null };

  async function tick() {
    if (state.running) return;
    state.running = true;
    try {
      state.ticks += 1;
      state.lastAttemptAt = now();
      const c = await runCensus({ runOrca, now });
      if (c.ok) { state.last = c; state.lastError = null; } else { state.lastError = c.reason; }
      try {
        writeJsonAtomic(path.join(intelDir, 'orca-census.json'), {
          updated_at: new Date(now()).toISOString(), ok: c.ok, last_error: state.lastError,
          last_good_at: state.last ? new Date(state.last.at).toISOString() : null,
          summary: state.last ? summarize(state.last.terminals) : null,
          last_good: state.last,
        });
      } catch (e) { state.lastError = `persist: ${e.message}`; }
      if (c.ok && snapshotIntervalMs > 0 && now() - state.lastSnapshotAt >= snapshotIntervalMs) {
        state.lastSnapshotAt = now();
        try { if (appendOrcaSnapshot(c.terminals, { logPath: snapshotLogPath, now: now() })) log(`orca-census: snapshot ${c.terminals.length} terminals`); }
        catch (e) { state.lastError = `snapshot: ${e.message}`; }
      }
      const p = await pollWorkerDone({ runOrca, intelDir, now, terminals: state.last ? state.last.terminals : [] });
      state.doneEvents += p.appended.length;
      for (const e of p.appended) log(`orca-census: WORKER_DONE ${e.task_id} en ${e.terminal} -> pane-events.jsonl`);
      if (p.errors.length) state.lastPollError = p.errors.join('; ').slice(0, 300);
    } catch (e) {
      state.lastError = `tick: ${e && e.message}`;
    } finally { state.running = false; }
  }

  function healthBlock() { return buildHealthBlock(state, now()); }
  function status() {
    const h = healthBlock();
    return { armed: true, terminals: h.terminals, connected: h.connected, census_age_ms: h.census_age_ms,
      last_error: h.last_error, ticks: state.ticks, done_events: state.doneEvents,
      last_poll_error: state.lastPollError || null, interval_ms: intervalMs };
  }
  function stop() { if (state.timer) clearInterval(state.timer); state.timer = null; }

  if (autoStart) {
    state.timer = setInterval(tick, intervalMs);
    if (state.timer.unref) state.timer.unref();
    tick();
  }
  return { tick, status, healthBlock, stop, _state: state };
}

// /api/health reads through this so the route does not need the handle.
let healthSource = null;
function setHealthSource(fn) { healthSource = typeof fn === 'function' ? fn : null; }
function healthBlock() {
  if (healthSource) { try { return healthSource(); } catch (e) { return { last_error: `health source: ${e.message}` }; } }
  return readPersistedCensus() || { terminals: 0, connected: 0, by_provider: {}, census_age_ms: null,
    last_error: 'orca census not armed in this daemon', list: [] };
}

module.exports = {
  DEFAULT_ORCA_BIN, DEFAULT_SNAPSHOT_LOG, ECHO_MARKERS,
  defaultRunOrca, guessProvider, normalizeTerminal, parseTerminalList, runCensus, summarize,
  buildHealthBlock, readPersistedCensus, restoreArgv, buildOrcaSnapshot, readOrcaSnapshots,
  appendOrcaSnapshot, readRichestOrcaSnapshot, readSupervised, extractDoneLines, pollWorkerDone,
  startOrcaCensus, setHealthSource, healthBlock,
};
