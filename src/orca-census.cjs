'use strict';
/**
 * orca-census.cjs — census, crash-restore snapshot and durable WORKER_DONE/SUBORCH_* events for
 * ORCA terminals (T-0525, T-0555). Covers: `orca terminal list --json` normalization,
 * _intel/orca-census.json, the `orca` block of /api/health + bridge_health,
 * vault/_wezbridge/orca-session-snapshot.jsonl, and the poller that appends
 * {event:'worker-done'|'suborch_done'|'suborch_question'|'suborch_status'|'suborch_handoff'}
 * to _intel/pane-events.jsonl for foreman-supervised and roster lane-orchestrator terminals.
 * Key terms: runOrca (injectable CLI double), healthBlock, readRichestOrcaSnapshot, ECHO_MARKERS,
 * extractSuborchLines, readRosterTerminals.
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
const { loadRoster } = require('./lane-roster.cjs');

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
// T-0555: lane-orchestrator report lines (see FLEET brief close format). Same echo
// problem as WORKER_DONE — briefs quote the template line back at the orchestrator.
const SUBORCH_DONE_RE = /\[SUBORCH_DONE\]\s+task_id=([^\s<>]+)(?:\s+outcome=(succeeded|failed))?(?:\s+report=([^\s<>]+))?/;
const SUBORCH_QUESTION_RE = /\[SUBORCH_QUESTION\]\s+task_id=([^\s<>]+)\s+q=(.+)/;
const SUBORCH_STATUS_RE = /\[SUBORCH_STATUS\]\s+(.+)/;
const SUBORCH_HANDOFF_RE = /\[SUBORCH_HANDOFF\]\s+(\S+)/;
const ECHO_MARKERS = ['[ORCHESTRATOR]', '[MISSION]', 'emiti', 'emití', 'report=<',
  // T-0555: literal placeholders from the brief's close-format block, quoted back on screen.
  'task_id=T-NNNN', "q='<", 'outcome=succeeded|failed', 'running=<ids>'];

/**
 * Default CLI runner: async, bounded, never blocks the caller's event loop.
 * T-0596: a `.cjs` bin (test doubles only — the real orca.exe never ends in
 * .cjs) is run via `node <script> <args>`: plain .cjs files have no shebang
 * association on Windows and execFile refuses to spawn them directly (same
 * reasoning as test/setup.cjs's mockCommand for the WezTerm double, and
 * orca-send.cjs's defaultRunOrca).
 */
function defaultRunOrca(args, { bin = DEFAULT_ORCA_BIN, timeoutMs = 15000 } = {}) {
  const [cmd, cmdArgs] = bin.endsWith('.cjs') ? [process.execPath, [bin, ...args]] : [bin, args];
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Same nuance as orca-send.cjs's defaultRunOrca: the real orca.exe can
        // exit non-zero while still emitting a well-formed {ok:false,...} JSON
        // body on stdout — only a truly empty stdout is a real transport
        // failure, never discard a non-empty body.
        if (err) {
          if (stdout && stdout.trim()) return resolve(stdout);
          err.message = `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`;
          return reject(err);
        }
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

/** '`key=value key2=value2`' -> {key: 'value', key2: 'value2'}. Empty values kept. */
function parseStatusKv(str) {
  const out = {};
  const re = /(\w+)=(\S*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[2];
  return out;
}

/** True when a value (or any string value nested one level deep) still carries a `<...>`
 * template placeholder — real ids/paths/questions never contain angle brackets. Belt-and-braces
 * alongside ECHO_MARKERS: it catches template shapes not on that literal list (e.g. a bare
 * `[SUBORCH_HANDOFF] <path>`) without having to enumerate every brief's placeholder wording. */
function containsAngleBracket(v) {
  if (typeof v === 'string') return /[<>]/.test(v);
  if (v && typeof v === 'object') return Object.values(v).some(containsAngleBracket);
  return false;
}

/**
 * Real lane-orchestrator report lines on a screen: [{line, kind, fields}], echoes
 * filtered out (same ECHO_MARKERS as WORKER_DONE, extended with the SUBORCH close-format
 * placeholders, plus the containsAngleBracket net). kind is one of
 * suborch_done|suborch_question|suborch_status|suborch_handoff.
 */
function extractSuborchLines(screenLines) {
  const out = [];
  for (const raw of screenLines || []) {
    const line = String(raw).trim();
    if (!line.includes('[SUBORCH_')) continue;
    if (ECHO_MARKERS.some((m) => line.includes(m))) continue;
    let kind = null;
    let fields = null;
    if (line.includes('[SUBORCH_DONE]')) {
      const m = SUBORCH_DONE_RE.exec(line);
      if (m) { kind = 'suborch_done'; fields = { task_id: m[1], outcome: m[2] || null, report: m[3] || null }; }
    } else if (line.includes('[SUBORCH_QUESTION]')) {
      const m = SUBORCH_QUESTION_RE.exec(line);
      if (m) {
        let q = m[2].trim();
        if ((q.startsWith("'") && q.endsWith("'")) || (q.startsWith('"') && q.endsWith('"'))) q = q.slice(1, -1);
        kind = 'suborch_question'; fields = { task_id: m[1], q };
      }
    } else if (line.includes('[SUBORCH_HANDOFF]')) {
      const m = SUBORCH_HANDOFF_RE.exec(line);
      if (m) { kind = 'suborch_handoff'; fields = { path: m[1] }; }
    } else if (line.includes('[SUBORCH_STATUS]')) {
      const m = SUBORCH_STATUS_RE.exec(line);
      if (m) { kind = 'suborch_status'; fields = { kv: parseStatusKv(m[1]) }; }
    }
    if (!kind || containsAngleBracket(fields)) continue;
    out.push({ line, kind, fields });
  }
  return out;
}

/** Lane-orchestrator terminals from the roster (_intel/orchestrators.json via lane-roster.cjs). Never throws. */
function readRosterTerminals(intelDir = DEFAULT_INTEL) {
  let roster;
  try { roster = loadRoster(intelDir); } catch { return []; }
  const lanes = (roster && Array.isArray(roster.lanes)) ? roster.lanes : [];
  const out = [];
  for (const l of lanes) {
    if (l && l.handle) out.push({ terminal: String(l.handle), lane: l.lane || null });
  }
  return out;
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function loadSeen(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

/**
 * One poll pass. Appends one event per NEW report line to pane-events.jsonl (dedupe by
 * sha1(terminal + line), persisted so a daemon restart does not re-emit):
 *  - {event:'worker-done', source:'orca', terminal, task_id, outcome, line, repo} for
 *    [WORKER_DONE] closures on foreman-supervised terminals (_intel/foreman/*.json).
 *  - {event:'suborch_done'|'suborch_question'|'suborch_status'|'suborch_handoff', source:'orca',
 *    terminal, line, repo, ...fields} for [SUBORCH_*] lines (T-0555) on roster lane-orchestrator
 *    terminals (_intel/orchestrators.json via lane-roster.cjs).
 * A terminal that is both supervised and rostered is read once and scanned for both kinds.
 */
async function pollWorkerDone({ runOrca = defaultRunOrca, intelDir = DEFAULT_INTEL, now = Date.now, terminals = [] } = {}) {
  const supervised = readSupervised(intelDir);
  const roster = readRosterTerminals(intelDir);
  const result = { polled: 0, appended: [], errors: [] };
  const byTerminal = new Map();
  for (const s of supervised) {
    const cur = byTerminal.get(s.terminal) || {};
    cur.supervised = true;
    cur.task_id = s.task_id;
    byTerminal.set(s.terminal, cur);
  }
  for (const r of roster) {
    if (!byTerminal.has(r.terminal)) byTerminal.set(r.terminal, {});
  }
  if (!byTerminal.size) return result;
  const seenFile = path.join(intelDir, '.orca-done-seen.json');
  const seenList = loadSeen(seenFile);
  const seen = new Set(seenList);
  const wtOf = new Map(terminals.map((t) => [t.handle, t.worktreePath]));

  const appendEvt = (evt) => {
    try {
      fs.mkdirSync(intelDir, { recursive: true });
      fs.appendFileSync(path.join(intelDir, 'pane-events.jsonl'), JSON.stringify(evt) + '\n', 'utf8');
      result.appended.push(evt);
    } catch (e) { result.errors.push(`append: ${e.message}`); }
  };

  for (const [term, meta] of byTerminal) {
    result.polled += 1;
    let lines;
    try {
      const j = JSON.parse(await runOrca(['terminal', 'read', '--terminal', term, '--screen', '--json']));
      const r = (j && j.result) || {};
      lines = (r.terminal && r.terminal.tail) || r.lines || [];
    } catch (e) { result.errors.push(`${term}: ${e.message}`); continue; }
    const wt = wtOf.get(term) || null;
    const repo = wt ? path.basename(wt) : null;

    if (meta.supervised) {
      for (const d of extractDoneLines(lines)) {
        if (meta.task_id && d.task_id !== meta.task_id && !d.task_id.includes(meta.task_id)) continue;
        const h = sha1(`${term}\n${d.line}`);
        if (seen.has(h)) continue;
        seen.add(h); seenList.push(h);
        const iso = new Date(now()).toISOString();
        appendEvt({ time: iso, ts: iso, event: 'worker-done', source: 'orca', terminal: term,
          task_id: d.task_id, outcome: d.outcome, line: d.line, repo });
      }
    }
    for (const d of extractSuborchLines(lines)) {
      const h = sha1(`${term}\n${d.line}`);
      if (seen.has(h)) continue;
      seen.add(h); seenList.push(h);
      const iso = new Date(now()).toISOString();
      appendEvt({ time: iso, ts: iso, event: d.kind, source: 'orca', terminal: term, repo, line: d.line, ...d.fields });
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
      for (const e of p.appended) log(`orca-census: ${e.event} ${e.task_id || e.path || ''} en ${e.terminal} -> pane-events.jsonl`);
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
  // T-0555
  extractSuborchLines, readRosterTerminals, parseStatusKv,
};
