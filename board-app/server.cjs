#!/usr/bin/env node
'use strict';
/**
 * board-app/server.cjs — the fleet board's hands. Bare node http, zero deps.
 *
 * Serves the built SPA (dist/) plus a narrow, deterministic API. No model in
 * any path. The board acts the way every fleet component acts: by APPENDING
 * to _intel files. It never edits tasks, never deletes, never holds state of
 * its own — _intel/ remains the only truth and every payload declares its own
 * generated_at so staleness is honest.
 *
 *   GET  /api/state               full cockpit state (token required)
 *   GET  /api/activity?page=N     unified feed, 25 per page (token required)
 *   POST /api/rulings             {task, verb, until?, note} → append rulings.jsonl
 *   POST /api/orchestrator-inbox  {kind, text} → append operator-actions.jsonl
 *
 * Auth: single shared token in board-app/.env.local (generated on first boot),
 * sent as x-board-token. Binds 0.0.0.0 so LAN/WireGuard phones reach it —
 * hence no naked endpoints even though it never leaves the house.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HERE = __dirname;
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(HERE, '..', '..', '_intel');
const DIST = path.join(HERE, 'dist');
const PORT = Number(process.env.WEZBRIDGE_BOARD_PORT || 4272);
const ENV_FILE = path.join(HERE, '.env.local');

const { audit, loadTasks } = require(path.join(HERE, '..', 'scripts', 'fleet-steward.cjs'));
const { evaluate } = require(path.join(HERE, '..', 'scripts', 'steward-gate.cjs'));
const { gateOf } = require(path.join(HERE, '..', 'scripts', 'fleet-board.cjs'));

const VERBS = ['approved', 'deferred', 'cancelled'];
const INBOX_KINDS = ['note', 'new-task', 'call-me'];
const PAGE_SIZE = 25;
const OPEN_STATES = ['ready', 'queued', 'running', 'review', 'blocked', 'failed'];

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

function loadToken() {
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    const m = text.match(/^BOARD_TOKEN=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* first boot */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(ENV_FILE, `BOARD_TOKEN=${token}\n`, { flag: 'a' });
  return token;
}

function tokenOk(req, token) {
  const got = String(req.headers['x-board-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// reads (all derive from _intel; nothing cached, nothing owned)
// ---------------------------------------------------------------------------

function readJsonl(file, max = Infinity) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-max)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function fileAge(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function lastTurn() {
  const dir = path.join(INTEL, 'turns');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('turn-') && f.endsWith('.json')).sort();
    if (!files.length) return null;
    const f = files[files.length - 1];
    return { file: f, at: fs.statSync(path.join(dir, f)).mtimeMs };
  } catch { return null; }
}

function routineRuns() {
  const dir = path.join(INTEL, 'routine-findings');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.startsWith('run-') || !f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const at = fs.statSync(path.join(dir, f)).mtimeMs;
      let verdict = 'no artifact';
      if (rec.findings_file) {
        // Relative findings_file resolves against the routine-findings dir,
        // NOT the server cwd (routine-audit.cjs loadRuns() precedent) — the
        // cwd-relative read rendered a permanent false "no artifact" amber
        // on healthy routines.
        const target = path.isAbsolute(rec.findings_file)
          ? rec.findings_file
          : path.join(dir, rec.findings_file);
        try { verdict = JSON.parse(fs.readFileSync(target, 'utf8')).verdict || '?'; } catch { /* genuinely absent */ }
      }
      out.push({ routine: rec.routine, repo: rec.repo, cadence_hours: rec.cadence_hours, exit_status: rec.exit_status, at, verdict });
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Unified reverse-chron activity feed. Each entry: {at, type, title, detail}.
 * Sources are the append-only files the fleet already writes — the feed is a
 * VIEW, not a new log.
 */
function activityFeed() {
  const items = [];
  for (const r of readJsonl(path.join(INTEL, 'rulings.jsonl'), 500)) {
    items.push({ at: Date.parse(r.at) || 0, type: 'ruling', title: `${r.ruling}: ${r.task}`, detail: r.why || '' });
  }
  for (const e of readJsonl(path.join(INTEL, 'events.jsonl'), 500)) {
    const title = e.event === 'a2a.sent'
      ? `a2a ${e.from_pane}→${e.to_pane} ${e.type || ''}`.trim()
      : `${e.event}${e.task_id ? `: ${e.task_id}` : ''}`;
    items.push({ at: Date.parse(e.time) || 0, type: 'event', title, detail: e.state || e.corr || '' });
  }
  for (const a of readJsonl(path.join(INTEL, 'operator-actions.jsonl'), 200)) {
    items.push({ at: Date.parse(a.at) || 0, type: 'operator', title: `${a.kind}: ${String(a.text).slice(0, 80)}`, detail: '' });
  }
  for (const r of routineRuns().slice(0, 50)) {
    items.push({ at: r.at, type: 'routine', title: `${r.routine} (${r.repo})`, detail: `exit ${r.exit_status} · ${r.verdict}` });
  }
  return items.sort((a, b) => b.at - a.at);
}

/** Sparkline: per-hour counts over the last 24h of rulings + events + turns. */
function sparkline(now) {
  const buckets = new Array(24).fill(0);
  const add = (t) => {
    if (!t) return;
    const h = Math.floor((now - t) / 3600000);
    if (h >= 0 && h < 24) buckets[23 - h] += 1;
  };
  for (const r of readJsonl(path.join(INTEL, 'rulings.jsonl'), 500)) add(Date.parse(r.at));
  for (const e of readJsonl(path.join(INTEL, 'events.jsonl'), 1000)) add(Date.parse(e.time));
  try {
    for (const f of fs.readdirSync(path.join(INTEL, 'turns'))) {
      if (f.startsWith('turn-')) add(fs.statSync(path.join(INTEL, 'turns', f)).mtimeMs);
    }
  } catch { /* no turns dir */ }
  return buckets;
}

function buildState(now = Date.now()) {
  const tasks = loadTasks();
  const report = audit(tasks, now, INTEL);
  const rulings = readJsonl(path.join(INTEL, 'rulings.jsonl'));
  const { unruled, verdict } = evaluate({ findings: report.findings, rulings, now });

  const open = tasks.filter((t) => OPEN_STATES.includes(t.state));
  const findingByTask = {};
  for (const f of report.findings) findingByTask[f.id] = f;

  // DECISIONES: operator-gated open tasks — the reason this app exists.
  const decisions = open.filter((t) => gateOf(t) === 'operator').map((t) => ({
    id: t.id,
    repo: t.repo,
    title: t.title,
    state: t.state,
    updated_at: t.updated_at || t.created_at || null,
    question: t.blocker || (t.contract && t.contract._note) || t.next_action
      || (findingByTask[t.id] && findingByTask[t.id].why) || '',
    category: (findingByTask[t.id] && findingByTask[t.id].category) || 'awaiting-operator',
  })).sort((a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0));

  const lastRuling = rulings.length ? rulings[rulings.length - 1] : null;

  const inFlight = open.filter((t) => ['running', 'review'].includes(t.state)).map((t) => ({
    id: t.id, repo: t.repo, title: t.title, state: t.state,
    owner: (t.lease && t.lease.owner) || null, updated_at: t.updated_at || null,
  }));

  const rest = open.filter((t) => gateOf(t) !== 'operator' && !['running', 'review'].includes(t.state));
  const byRepo = {};
  for (const t of rest) {
    (byRepo[t.repo] = byRepo[t.repo] || []).push({
      id: t.id, title: t.title, state: t.state, updated_at: t.updated_at || t.created_at || null,
    });
  }

  const gateLog = path.join(INTEL, 'steward-gate-latest.txt');
  const gateAt = fileAge(gateLog);
  let gateText = '';
  try { gateText = fs.readFileSync(gateLog, 'utf8').trim().split('\n')[0]; } catch { /* absent */ }

  const turn = lastTurn();
  const snapshotAt = fileAge(path.join(HERE, '..', 'vault', '_wezbridge', 'session-snapshot.jsonl'));

  return {
    generated_at: new Date(now).toISOString(),
    gate: {
      // Verdict from the LIVE evaluation, age from the last scheduled run.
      verdict,
      unruled: unruled.length,
      last_run_at: gateAt ? new Date(gateAt).toISOString() : null,
      last_run_text: gateText,
    },
    // Every steward finding that is NOT an operator gate (those are decision
    // cards already), marked ruled/unruled — so a ruling can be made where the
    // problem is seen, before OR after the deadline forces it.
    findings_list: report.findings
      .filter((f) => f.category !== 'awaiting-operator')
      .map((f) => ({
        id: f.id, repo: f.repo, title: f.title || '', category: f.category,
        age_hours: f.age_hours, why: f.why || '',
        unruled: unruled.some((u) => u.id === f.id),
      })),
    last_turn_at: turn ? new Date(turn.at).toISOString() : null,
    snapshot_at: snapshotAt ? new Date(snapshotAt).toISOString() : null,
    decisions,
    last_ruling: lastRuling,
    in_flight: inFlight,
    by_repo: byRepo,
    routines: routineRuns().slice(0, 12),
    sparkline: sparkline(now),
    open_count: open.length,
  };
}

/**
 * Kitchen chain pill. Only probed when the operator configures the URL —
 * an unconfigured probe reports 'unconfigured', never a guessed 'down'.
 */
async function kitchenHealth() {
  const url = process.env.BOARD_KITCHEN_HEALTH_URL;
  if (!url) return { status: 'unconfigured' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok ? { status: 'up' } : { status: 'down', detail: `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'down', detail: String(e.message || e).slice(0, 80) };
  }
}

// ---------------------------------------------------------------------------
// writes — appends ONLY, schema-exact
// ---------------------------------------------------------------------------

/**
 * Validate a ruling request. Returns {error} or {line} — the EXACT object that
 * will be appended, in the schema the gate and every reader already parse:
 * {task, category, ruling, why, at}. Verb maps 1:1 to `ruling`.
 */
function validateRuling(body, findings, now = Date.now()) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const { task, verb, until, note } = body;
  if (typeof task !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(task)) return { error: 'invalid task id' };
  if (!VERBS.includes(verb)) return { error: `verb must be one of ${VERBS.join('|')}` };
  if (typeof note !== 'string' || !note.trim() || note.length > 2000) return { error: 'note is required (≤2000 chars)' };
  const line = {
    task,
    category: null,
    ruling: verb,
    why: note.trim(),
    at: new Date(now).toISOString(),
  };
  const finding = findings.find((f) => f.id === task);
  line.category = finding ? finding.category : 'awaiting-operator';
  if (verb === 'deferred') {
    const t = Date.parse(until);
    if (!Number.isFinite(t)) return { error: 'deferred requires a valid `until` ISO date' };
    if (t <= now) return { error: '`until` must be in the future — a deferral into the past is a shrug' };
    line.until = new Date(t).toISOString();
  }
  return { line };
}

function validateInboxNote(body) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const { kind, text } = body;
  if (!INBOX_KINDS.includes(kind)) return { error: `kind must be one of ${INBOX_KINDS.join('|')}` };
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) return { error: 'text is required (≤4000 chars)' };
  return { line: { type: 'operator-action', kind, text: text.trim(), at: new Date().toISOString(), source: 'board-app' } };
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

/**
 * Per-IP sliding-window limiter for the append endpoints. rulings.jsonl is the
 * fleet control plane; a stuck retry loop must not be able to flood it.
 */
function makeRateLimiter(max = 10, windowMs = 60000) {
  const hits = new Map();
  return function allow(ip, now = Date.now()) {
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    return true;
  };
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  let file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('SPA not built yet: run `npm run build` in board-app/');
    return;
  }
  const ext = path.extname(file);
  // The SW must never be cached hard or updates wedge; the shell is cached BY the SW.
  const cache = (ext === '.html' || file.endsWith('sw.js')) ? 'no-cache' : 'public, max-age=86400';
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cache });
  fs.createReadStream(file).pipe(res);
}

function log(line) {
  const stamp = new Date().toISOString();
  console.log(`${stamp} ${line}`);
}

function createServer(token, { rateLimiter = makeRateLimiter() } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

      if (!tokenOk(req, token)) return sendJson(res, 401, { error: 'missing or wrong x-board-token' });

      if (req.method === 'POST' && !rateLimiter(req.socket.remoteAddress || '?')) {
        return sendJson(res, 429, { error: 'rate limited — appends are capped per minute' });
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = buildState();
        state.kitchen = await kitchenHealth();
        return sendJson(res, 200, state);
      }

      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const page = Math.max(0, Number(url.searchParams.get('page') || 0) | 0);
        const all = activityFeed();
        return sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          page,
          page_size: PAGE_SIZE,
          total: all.length,
          items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/rulings') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const tasks = loadTasks();
        const report = audit(tasks, Date.now(), INTEL);
        const { error, line } = validateRuling(body, report.findings);
        if (error) return sendJson(res, 400, { error });
        appendLine(path.join(INTEL, 'rulings.jsonl'), line);
        // Approvals are a GO the orchestrator must act on, so they ALSO land in
        // the inbox its monitor watches. Deferrals/cancellations are complete
        // in themselves — the gate reads them directly.
        if (line.ruling === 'approved') {
          appendLine(path.join(INTEL, 'operator-actions.jsonl'), {
            type: 'operator-action', kind: 'approval',
            text: `Operator approved ${line.task} from the board: ${line.why}`,
            task: line.task, at: line.at, source: 'board-app',
          });
        }
        log(`ruling appended: ${JSON.stringify(line)}`);
        return sendJson(res, 200, { ok: true, line });
      }

      if (req.method === 'POST' && url.pathname === '/api/orchestrator-inbox') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const { error, line } = validateInboxNote(body);
        if (error) return sendJson(res, 400, { error });
        appendLine(path.join(INTEL, 'operator-actions.jsonl'), line);
        log(`inbox appended: ${JSON.stringify(line)}`);
        return sendJson(res, 200, { ok: true, line });
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    } catch (e) {
      log(`ERROR ${req.method} ${url.pathname}: ${e.message}`);
      return sendJson(res, 500, { error: 'internal error', detail: String(e.message) });
    }
  });
}

if (require.main === module) {
  // Daemon precedent (wezbridge v3.4.3): a non-loopback bind REQUIRES a token.
  // loadToken() self-provisions one, but if that fails for any reason we fall
  // back to loopback rather than ever exposing naked endpoints on the LAN.
  let token = null;
  try { token = loadToken(); } catch (e) { log(`token unavailable (${e.message})`); }
  const bind = token ? '0.0.0.0' : '127.0.0.1';
  const server = createServer(token || crypto.randomBytes(24).toString('base64url'));
  server.listen(PORT, bind, () => {
    log(`fleet-board-app listening on ${bind}:${PORT} (intel: ${INTEL})`);
    log(token ? `token file: ${ENV_FILE}` : 'NO TOKEN FILE — loopback only, API unusable until .env.local exists');
  });
}

module.exports = {
  createServer, loadToken, buildState, activityFeed, makeRateLimiter,
  validateRuling, validateInboxNote, VERBS, INBOX_KINDS, PAGE_SIZE,
};
