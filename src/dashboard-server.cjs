#!/usr/bin/env node
/**
 * theorchestra dashboard server — thin HTTP + SSE layer over wezbridge tooling.
 *
 * Endpoints:
 *   GET  /api/panes                        — current pane list with status, identity, metrics
 *   GET  /api/panes/:id/output?lines=50    — scrollback from a pane
 *   GET  /api/tasks                        — parsed active_tasks.md (if present)
 *   GET  /api/events                       — SSE stream of omni-watcher events
 *   POST /api/panes/:id/prompt  {text}     — send_prompt + send_key(enter)
 *   POST /api/panes/:id/key     {key}      — send_key
 *   POST /api/panes/:id/kill               — kill pane
 *   POST /api/spawn             {cwd,program?} — spawn a new pane
 *
 * Static frontend assets served from ../dashboard/dist (after `npm run build`).
 * Dev mode: run Vite separately on :5173 and set a proxy to this server on :4200.
 */

// Opt-in destructive-op guard. No-op unless WEZBRIDGE_GUARD_SHIMS=1.
require('./guard-bootstrap.cjs');

const safetyPolicy = require('./safety-policy.cjs');
const a2aHeartbeat = require('./a2a-heartbeat.cjs');
const sessionSnapshot = require('./session-snapshot.cjs');
const teamManifest = require('./team-manifest.cjs');
const gradesRegistryFactory = require('./grades-registry.cjs');
const outcomeGrader = require('../scripts/outcome-grader.cjs');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const wez = require('./wezterm.cjs');
const { discoverPanes } = require('./pane-discovery.cjs');
const routinesConfig = require('./routines-config.cjs');
const { parseTasksFile } = (() => {
  try { return require('./task-parser.cjs'); }
  catch { return { parseTasksFile: () => ({ tasks: [], error: 'task-parser not available' }) }; }
})();
const { scanProjects } = (() => {
  try { return require('./project-scanner.cjs'); }
  catch { return { scanProjects: () => [] }; }
})();

const PORT = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
const STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'dist');
// dashboard.html UI deprecated 2026-05-03 (per src/DEPRECATED.md). The daemon
// stays alive only because mcp__wezbridge__* tools fetch /api/panes against it.
const ACTIVE_TASKS_PATH = process.env.ACTIVE_TASKS_PATH
  || path.join(process.env.OMNICLAUDE_PATH || path.join(__dirname, '..', '..', 'omniclaude'), 'active_tasks.md');

// --- helpers ---
function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function log(msg) { process.stderr.write(`[dashboard] ${new Date().toISOString()} ${msg}\n`); }

// --- route handlers ---

function collectPanes() {
  const raw = discoverPanes ? discoverPanes() : wez.listPanes().map(p => ({ paneId: p.pane_id }));
  return (raw || []).map(p => ({
    pane_id: p.paneId ?? p.pane_id,
    is_claude: p.isClaude ?? false,
    status: p.status ?? 'unknown',
    project: p.project ?? null,
    project_name: p.projectName ?? null,
    title: p.title ?? '',
    workspace: p.workspace ?? 'default',
    confidence: p.confidence ?? 0,
    last_line: p.lastLines ?? '',
    persona: p.persona ?? null,
    ctx: typeof p.ctx === 'number' ? p.ctx : null,
    session_pct: typeof p.sessionPct === 'number' ? p.sessionPct : null,
    weekly_pct: typeof p.weeklyPct === 'number' ? p.weeklyPct : null,
    model: p.model ?? null,
  }));
}

async function handleGetPanes(req, res) {
  try { sendJson(res, 200, { panes: collectPanes() }); }
  catch (err) { log(`GET /api/panes error: ${err.message}`); sendJson(res, 500, { error: err.message }); }
}

// Legacy-compat: v3.1 HTML expects { sessions: [...] } with confidence in %.
async function handleGetSessions(req, res) {
  try {
    const sessions = collectPanes().map(p => ({
      ...p,
      confidence: Math.round((p.confidence || 0) * (p.confidence > 1 ? 1 : 100)),
    }));
    sendJson(res, 200, { sessions });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handleGetProjects(req, res) {
  try {
    const list = scanProjects({ includeCodex: true, limit: null }) || [];
    // v3.1 HTML expects a bare array of {name, path, ...}.
    const projects = list.map(p => ({
      name: p.name || (p.realPath || '').split(/[/\\]/).pop() || 'project',
      path: p.realPath || p.cwd || '',
      cwd: p.realPath || p.cwd || '',
      type: p.agent || 'claude',
      last_activity: p.latestActivityMs ? new Date(p.latestActivityMs).toISOString() : null,
      session_count: p.sessionCount || 0,
    }));
    sendJson(res, 200, projects);
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handleGetBrowse(req, res, queryPath) {
  try {
    const dir = queryPath || process.env.HOME || process.env.USERPROFILE || '/';
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return sendJson(res, 200, { cwd: dir, dirs: [], error: 'not a directory' });
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .slice(0, 200);
    sendJson(res, 200, { cwd: dir, dirs: entries });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handlePostBroadcast(req, res) {
  try {
    const { text, panes: targets } = await parseBody(req);
    if (!text) return sendJson(res, 400, { error: 'missing text' });
    const all = collectPanes().filter(p => p.is_claude);
    const ids = Array.isArray(targets) && targets.length ? targets : all.map(p => p.pane_id);
    for (const id of ids) {
      try { wez.sendText(id, text); wez.sendTextNoEnter(id, '\r'); } catch (e) { log(`broadcast pane ${id}: ${e.message}`); }
    }
    sendJson(res, 200, { ok: true, sent: ids.length });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handleGetPaneOutput(res, paneId, lines) {
  try {
    const text = wez.getFullText(paneId, lines);
    // Return both field names: `output` for v3.1 HTML compat, `lines` for new clients.
    sendJson(res, 200, { pane_id: paneId, output: text || '', lines: text || '' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGetTasks(res) {
  try {
    if (!fs.existsSync(ACTIVE_TASKS_PATH)) {
      return sendJson(res, 200, { tasks: [], note: `no active_tasks.md at ${ACTIVE_TASKS_PATH}` });
    }
    const { tasks: tasksMap, errors } = parseTasksFile(ACTIVE_TASKS_PATH);
    const tasks = Array.from(tasksMap.values());
    sendJson(res, 200, { tasks, errors });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// Translate raw omni-watcher events → v3.1 dashboard contract.
// v3.1 HTML expects: {type, pane_id, project, timestamp, output?, from?, to?}.
// We skip noise (heartbeat, metrics_summary, watcher_started, relaunch_me).
const NOISE_EVENTS = new Set(['heartbeat', 'metrics_summary', 'watcher_started', 'relaunch_me']);

// --- A2A state (module-scoped, shared across all SSE clients) ---
// Map<corr, {corr, from, to, firstSeen, lastSeen, status}>
// Status: 'active' | 'resolved' | 'orphaned'. LRU cap 500 + 24h TTL.
const a2aState = new Map();
const A2A_MAX = 500;
const A2A_TTL_MS = 24 * 3600 * 1000;
const A2A_ENVELOPE_RE = /\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)/g;

// --- Auto-handoff registry (v2.6) ---
// Map<corr, {corr, paneId, file, createdAt, readinessReason, status}>
const handoffRegistry = new Map();

// --- SSE client registry (v2.6) ---
// Set of active response objects currently streaming /api/events. The
// auto-handoff daemon iterates this set to broadcast autoHandoffSuggest /
// autoHandoffUrgent events to dashboards in real time. Without this,
// src/dashboard.html's SSE listeners at line ~2889 never fire because
// the daemon only pushes to pendingAutoHandoffEvents (polling-only).
const sseClients = new Set();
function broadcastSSE(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch (e) { /* dead client — will be cleaned up on req.close */ }
  }
}

// --- Grades registry (Task #4 — outcome-grader output, surfaced via SSE + GET /api/grades) ---
const gradesRegistry = gradesRegistryFactory.createRegistry({
  max: 100,
  broadcast: (e) => broadcastSSE(e),
});

// --- Worktree registry (Phase 3 — Agency Mode) ---
// Map<paneId, {persona, worktreePath, branchName, baseCwd}>
const worktreeRegistry = new Map();

// --- Teams registry (Phase 4 — PRD-driven bootstrap) ---
// Map<teamName, {prd, createdAt, cwd, roles: [{paneId, persona, worktree, branch, task, status}]}>
const teamsRegistry = new Map();

// --- PRD directory ---
const PRD_DIR = path.join(__dirname, '..', 'docs', 'prd');

/**
 * Parse a PRD markdown file with YAML frontmatter.
 * Returns {name, roles: [{persona, permission_mode, worktree, task}], scope, deadline, body}
 * or null if parsing fails.
 *
 * Uses a simple line-by-line YAML parser (no library).
 */
function parsePRD(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const fmMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fmBlock = fmMatch[1];
  const body = raw.slice(fmMatch[0].length).trim();
  const lines = fmBlock.split(/\r?\n/);

  const result = { name: null, roles: [], scope: null, deadline: null, body };
  let inRoles = false;
  let currentRole = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of roles array (check BEFORE top-level scalar so "roles:" isn't consumed as a scalar)
    if (/^roles:\s*$/.test(line)) {
      inRoles = true;
      continue;
    }

    // Detect top-level scalar keys (no leading whitespace)
    const topMatch = line.match(/^(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
    if (topMatch && !inRoles) {
      const key = topMatch[1];
      const val = topMatch[2].trim();
      if (key === 'name') result.name = val || null;
      else if (key === 'scope') result.scope = val || null;
      else if (key === 'deadline') result.deadline = val || null;
      else if (key === 'prd') { /* skip boolean marker */ }
      continue;
    }

    // A new role item (  - persona: xxx)
    const roleItemMatch = line.match(/^\s+-\s+(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
    if (roleItemMatch && inRoles) {
      // Flush previous role
      if (currentRole && currentRole.persona && currentRole.task) {
        result.roles.push(Object.assign({}, currentRole));
      }
      currentRole = { persona: null, permission_mode: null, worktree: false, task: null };
      const key = roleItemMatch[1];
      const val = roleItemMatch[2].trim();
      if (key === 'persona') currentRole.persona = val;
      else if (key === 'permission_mode') currentRole.permission_mode = val;
      else if (key === 'worktree') currentRole.worktree = val === 'true';
      else if (key === 'task') currentRole.task = val;
      continue;
    }

    // Continuation key inside a role (    key: val)
    const roleKeyMatch = line.match(/^\s{4,}(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
    if (roleKeyMatch && inRoles && currentRole) {
      const key = roleKeyMatch[1];
      const val = roleKeyMatch[2].trim();
      if (key === 'persona') currentRole.persona = val;
      else if (key === 'permission_mode') currentRole.permission_mode = val;
      else if (key === 'worktree') currentRole.worktree = val === 'true';
      else if (key === 'task') currentRole.task = val;
      continue;
    }

    // A top-level key after roles ended (no indentation = roles block is over)
    if (inRoles && /^\w/.test(line)) {
      inRoles = false;
      // Flush last role
      if (currentRole && currentRole.persona && currentRole.task) {
        result.roles.push(Object.assign({}, currentRole));
      }
      currentRole = null;
      // Re-process line as top-level
      const reMatch = line.match(/^(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
      if (reMatch) {
        if (reMatch[1] === 'scope') result.scope = reMatch[2].trim() || null;
        else if (reMatch[1] === 'deadline') result.deadline = reMatch[2].trim() || null;
      }
    }
  }

  // Flush final role if still pending
  if (currentRole && currentRole.persona && currentRole.task) {
    result.roles.push(Object.assign({}, currentRole));
  }

  if (!result.name || result.roles.length === 0) return null;
  return result;
}

/**
 * Shared helper to spawn a single agent pane.
 * Follows v2.5 constraint (claim 9708): shell first -> wait 2s -> sendText claude command
 * -> NO --continue when persona set -> setTabTitle.
 *
 * Returns {paneId, worktreeInfo} or throws.
 */
async function spawnAgentPane({ cwd, persona, permission_mode, worktree }) {
  const spawnCwd = String(cwd);
  let worktreeInfo = null;
  let effectiveCwd = spawnCwd;

  // Worktree creation if requested
  if (worktree === true) {
    try {
      execSync(`git -C "${spawnCwd.replace(/\\/g, '/')}" rev-parse --git-dir`, { timeout: 15000, encoding: 'utf8' });
    } catch {
      throw new Error('not a git repo -- cannot create worktree');
    }
    const shortId = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
    const agentSlug = persona || 'agent';
    const branchName = `claude/agency-${agentSlug}-${shortId}`;
    const worktreePath = path.join(spawnCwd, '.worktrees', `${agentSlug}-${shortId}`).replace(/\\/g, '/');
    execSync(`git -C "${spawnCwd.replace(/\\/g, '/')}" worktree add "${worktreePath}" -b "${branchName}"`, { timeout: 15000, encoding: 'utf8' });
    effectiveCwd = worktreePath;
    worktreeInfo = { path: worktreePath, branch: branchName, baseCwd: spawnCwd };
  }

  // Spawn shell pane first (no program)
  const paneId = wez.spawnPane({ cwd: effectiveCwd });

  // Wait for shell to initialize
  await new Promise(r => setTimeout(r, 2000));

  // Build claude command
  const validModes = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
  let claudeCmd = 'claude';
  if (persona) {
    const personaPath = resolvePersona(persona);
    if (personaPath) {
      claudeCmd += ' --append-system-prompt-file "' + personaPath.replace(/\\/g, '/') + '"';
    }
    // Fresh start when persona set (no --continue)
  } else {
    claudeCmd += ' --continue';
  }
  claudeCmd += ' --dangerously-skip-permissions';
  if (permission_mode && validModes.includes(permission_mode)) {
    claudeCmd += ' --permission-mode ' + permission_mode;
  }
  wez.sendText(paneId, claudeCmd);

  // Set tab title for persona detection
  if (persona) {
    try { wez.setTabTitle(paneId, `[${persona}]`); } catch { /* best effort */ }
  }

  // Register worktree
  if (worktreeInfo) {
    worktreeRegistry.set(paneId, {
      persona: persona || 'agent',
      worktreePath: worktreeInfo.path,
      branchName: worktreeInfo.branch,
      baseCwd: worktreeInfo.baseCwd,
    });
    // Persist to teams.jsonl so the registry survives dashboard restart.
    teamManifest.record({
      event: 'worktree_added',
      pane_id: paneId,
      persona: persona || 'agent',
      worktree_path: worktreeInfo.path,
      branch_name: worktreeInfo.branch,
      base_cwd: worktreeInfo.baseCwd,
    }, { log });
  }

  return { paneId, worktreeInfo };
}

function a2aEvict() {
  const now = Date.now();
  for (const [corr, info] of a2aState) {
    if (now - (info.lastSeen || info.firstSeen) > A2A_TTL_MS) a2aState.delete(corr);
  }
  // LRU: drop oldest lastSeen if over cap
  while (a2aState.size > A2A_MAX) {
    let oldestCorr = null;
    let oldestTs = Infinity;
    for (const [corr, info] of a2aState) {
      const ts = info.lastSeen || info.firstSeen || 0;
      if (ts < oldestTs) { oldestTs = ts; oldestCorr = corr; }
    }
    if (oldestCorr == null) break;
    a2aState.delete(oldestCorr);
  }
}

function a2aTouch(corr, patch) {
  const now = Date.now();
  const existing = a2aState.get(corr);
  if (existing) {
    Object.assign(existing, patch, { lastSeen: now });
  } else {
    a2aState.set(corr, { corr, from: null, to: null, firstSeen: now, lastSeen: now, status: 'active', ...patch });
  }
  a2aEvict();
}

function recordA2AFromRawEvent(raw) {
  if (!raw) return;
  // peer_orphaned carries corr at top level
  if (raw.event === 'peer_orphaned' && raw.corr) {
    a2aTouch(String(raw.corr), { status: 'orphaned' });
    return;
  }
  // Scan details string for A2A envelopes
  const haystack = typeof raw.details === 'string' ? raw.details
    : (raw.raw && typeof raw.raw === 'object' && typeof raw.raw.corr === 'string')
      ? `[A2A from pane-${raw.pane || 0} to pane-0 | corr=${raw.raw.corr} | type=request]`
      : null;
  if (!haystack) return;
  A2A_ENVELOPE_RE.lastIndex = 0;
  let m;
  while ((m = A2A_ENVELOPE_RE.exec(haystack)) !== null) {
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    const corr = m[3];
    const type = m[4];
    const _now = Date.now();
    if (type === 'request') {
      a2aTouch(corr, { from, to, status: 'active', lastProgressAt: _now, notified_silent: false });
    } else if (type === 'result') {
      a2aTouch(corr, { from, to, status: 'resolved', lastProgressAt: _now });
    } else if (type === 'error') {
      a2aTouch(corr, { from, to, status: 'resolved', lastProgressAt: _now });
    } else {
      // ack/progress: keep alive but don't overwrite status. Refresh
      // lastProgressAt and reset notified_silent so the heartbeat watcher
      // re-fires on the next silence period after a progress beat.
      a2aTouch(corr, { from, to, lastProgressAt: _now, notified_silent: false });
    }
  }
}

async function handleGetA2APending(req, res) {
  try {
    a2aEvict();
    const corrs = Array.from(a2aState.values())
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    sendJson(res, 200, { corrs });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

function slugify(s) {
  return String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function isoForFilename() {
  // 2026-04-14T17-46-12Z (no ms, colons → dashes)
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

async function handleGetGrades(req, res) {
  try {
    sendJson(res, 200, { grades: gradesRegistry.list(), count: gradesRegistry.size() });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostGrade(req, res) {
  try {
    const body = await parseBody(req);
    const key = body.key || body.corr || body.pane_id;
    if (!key) return sendJson(res, 400, { error: 'missing `key` (or `corr` / `pane_id`)' });
    if (typeof body.work !== 'string') return sendJson(res, 400, { error: 'missing `work` (string)' });
    const grade = outcomeGrader.grade({
      work: body.work,
      rubric: body.rubric || '',
      taskDesc: body.taskDesc || body.task_desc || '',
      backend: body.backend,
      model: body.model,
    });
    const entry = gradesRegistry.record(String(key), grade);
    sendJson(res, 200, { ok: true, ...entry });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostA2AHandoff(req, res) {
  // v2.3.1 redesign: the dashboard does NOT write files or inject into the target.
  // Instead, it sends an instructive prompt to the SOURCE pane, delegating the
  // full handoff authoring + A2A dispatch to the source Claude. This gives the
  // source pane authorial control over its own handoff (it has the richest
  // context) and makes the flow traceable: handoff file + A2A envelope both
  // originate from the source pane itself, via wezbridge MCP.
  try {
    const body = await parseBody(req);
    const source_pane = parseInt(body.source_pane, 10);
    const target_pane = parseInt(body.target_pane, 10);
    const instruction = typeof body.instruction === 'string' ? body.instruction : '';
    // `context` is optional extra info from the dashboard user to include in the prompt.
    const context = typeof body.context === 'string' ? body.context
      : typeof body.summary === 'string' ? body.summary : '';
    if (!Number.isFinite(source_pane) || !Number.isFinite(target_pane)) {
      return sendJson(res, 400, { error: 'source_pane and target_pane must be integers' });
    }
    if (!instruction.trim()) {
      return sendJson(res, 400, { error: 'instruction is required' });
    }

    const panes = discoverPanes ? discoverPanes() : [];
    const srcPane = panes.find(p => (p.paneId ?? p.pane_id) === source_pane);
    const tgtPane = panes.find(p => (p.paneId ?? p.pane_id) === target_pane);
    if (!srcPane || !srcPane.isClaude) {
      return sendJson(res, 400, { error: `source pane ${source_pane} not found or not claude` });
    }
    if (!tgtPane || !tgtPane.isClaude) {
      return sendJson(res, 400, { error: `target pane ${target_pane} not found or not claude` });
    }

    const srcProjectName = srcPane.projectName
      || (srcPane.project ? srcPane.project.split(/[\\/]/).filter(Boolean).pop() : null)
      || 'unknown';
    const tgtProjectName = tgtPane.projectName
      || (tgtPane.project ? tgtPane.project.split(/[\\/]/).filter(Boolean).pop() : null)
      || 'unknown';

    // Generate corr the dashboard recommends — source pane is free to reuse or mint its own.
    const corrShort = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
    const corr = `handoff-${corrShort}`;
    const tsFile = isoForFilename();

    // Suggested handoff filename — the SOURCE pane writes it in its OWN project's
    // handoffs/ folder, named after the target. Appends unique timestamp+corr.
    const suggestedFilename = `handoff-to-${slugify(tgtProjectName)}-${tsFile}-${corrShort}.md`;
    const suggestedPath = `handoffs/${suggestedFilename}`;

    // Instruction prompt sent to SOURCE pane. This is what the source Claude receives
    // and executes using its wezbridge MCP tools.
    const prompt = [
      `[Dashboard A2A Handoff Request]`,
      ``,
      `You are pane-${source_pane} (${srcProjectName}). A handoff has been requested FROM you TO pane-${target_pane} (${tgtProjectName}, cwd: ${tgtPane.project || 'unknown'}).`,
      ``,
      `Instruction for target: ${instruction}`,
      ...(context.trim() ? [``, `Additional context from the dashboard user:`, context.trim()] : []),
      ``,
      `## Do these steps in order`,
      ``,
      `1. **Author a handoff file** at \`${suggestedPath}\` (relative to YOUR current cwd). Include:`,
      `   - What you have been doing recently`,
      `   - Current state / work-in-progress`,
      `   - What the target needs to know to pick up or contribute`,
      `   - Any files / commits / context relevant to the instruction above`,
      `   - Use a fresh unique filename — NEVER overwrite an existing handoff file.`,
      ``,
      `2. **Contact pane-${target_pane} via wezbridge MCP** using this exact envelope (the A2A hard-rule is: send_prompt followed by send_key 'enter'):`,
      `   \`\`\``,
      `   [A2A from pane-${source_pane} to pane-${target_pane} | corr=${corr} | type=request]`,
      `   ${instruction}`,
      `   Full handoff context is in: ${srcProjectName}/${suggestedPath}`,
      `   \`\`\``,
      `   Call: \`mcp__wezbridge__send_prompt(pane_id=${target_pane}, text=<envelope above>)\` then \`mcp__wezbridge__send_key(pane_id=${target_pane}, key='enter')\`.`,
      ``,
      `3. **Briefly acknowledge here** that the file was written + the target was contacted, with the filename and corr id.`,
      ``,
      `Do not do the target's work yourself. Your job is only to author the handoff file and delegate via MCP.`,
    ].join('\n');

    try {
      wez.sendText(source_pane, prompt);
      wez.sendTextNoEnter(source_pane, '\r');
    } catch (e) {
      return sendJson(res, 500, { error: `failed to send prompt to source pane: ${e.message}` });
    }

    // Track corr as active (source pane will eventually emit matching envelopes via its MCP calls).
    const now = Date.now();
    a2aTouch(corr, { from: source_pane, to: target_pane, status: 'active', firstSeen: now, lastSeen: now });

    sendJson(res, 200, {
      ok: true,
      corr,
      source_pane,
      target_pane,
      suggested_file: suggestedPath,
      note: 'Instruction prompt sent to source pane. Source pane will author handoff file + contact target via wezbridge MCP.',
    });
  } catch (err) {
    log(`POST /api/a2a/handoff error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

function translateWatcherEvent(raw) {
  if (!raw || !raw.event || NOISE_EVENTS.has(raw.event)) return null;
  const typeMap = {
    session_started: 'started',
    session_started_working: 'started',
    session_completed: 'completed',
    session_permission: 'permission',
    session_stuck: 'status_change',
    session_dead: 'removed',
    session_removed: 'removed',
    peer_orphaned: 'permission',
  };
  const type = typeMap[raw.event] || raw.event;
  const out = {
    // keep original fields for any new clients
    ...raw,
    // v3.1 contract
    type,
    timestamp: raw.ts || new Date().toISOString(),
    pane_id: raw.pane ?? raw.pane_id ?? null,
    project: raw.project || null,
  };
  // Richer payload: for started/completed/permission, pull recent pane text as `output`.
  if (['started', 'completed', 'permission'].includes(type) && out.pane_id != null) {
    try {
      const full = wez.getFullText(out.pane_id, 40) || '';
      const clean = full.split('\n').filter(l => l.trim()).slice(-15).join('\n');
      if (clean) out.output = clean;
    } catch { /* pane may have disappeared */ }
  }
  // If watcher already attached a details summary, use it as fallback output.
  if (!out.output && raw.details) out.output = String(raw.details);
  if (type === 'status_change') {
    out.from = raw.from || 'working';
    out.to = raw.to || (raw.event === 'session_stuck' ? 'stuck' : 'unknown');
  }
  return out;
}

// SSE: spawn an omni-watcher child, translate + forward events.
// Also register in sseClients so the auto-handoff daemon can broadcast to us.
function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const helloTs = new Date().toISOString();
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: helloTs, timestamp: helloTs })}\n\n`);
  sseClients.add(res);

  const child = spawn(process.execPath, [path.join(__dirname, 'omni-watcher.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WATCHER_POLL_MS: process.env.WATCHER_POLL_MS || '30000' },
  });

  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }
      // Side-effect: update A2A state from any envelope pattern or peer_orphaned event.
      try { recordA2AFromRawEvent(raw); } catch (e) { log(`a2a record error: ${e.message}`); }
      const translated = translateWatcherEvent(raw);
      if (!translated) continue;
      res.write(`data: ${JSON.stringify(translated)}\n\n`);
    }
  });
  child.stderr.on('data', chunk => log(`watcher stderr: ${chunk.toString('utf8').trim()}`));
  child.on('exit', code => {
    res.write(`event: watcher_exit\ndata: ${JSON.stringify({ code, timestamp: new Date().toISOString() })}\n\n`);
    sseClients.delete(res);
    res.end();
  });

  req.on('close', () => {
    sseClients.delete(res);
    child.kill();
  });
}

async function handlePostPrompt(req, res, paneId) {
  try {
    const { text } = await parseBody(req);
    if (typeof text !== 'string' || !text.length) {
      return sendJson(res, 400, { error: 'missing `text` body field' });
    }
    const _safety = safetyPolicy.evaluate({ action: 'send_prompt', paneId, prompt: text });
    if (!_safety.allowed) {
      return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
    }
    wez.sendText(paneId, text);
    // Auto-follow with enter per the A2A hard rule
    wez.sendTextNoEnter(paneId, '\r');
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostKey(req, res, paneId) {
  try {
    const { key } = await parseBody(req);
    if (!key) return sendJson(res, 400, { error: 'missing `key` body field' });
    const _safety = safetyPolicy.evaluate({ action: 'send_key', paneId, key });
    if (!_safety.allowed) {
      return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
    }
    const mapping = {
      enter: '\r', y: 'y', n: 'n',
      'ctrl+c': '\x03',
      '1': '1', '2': '2', '3': '3',
    };
    const payload = mapping[key.toLowerCase()] ?? key;
    wez.sendTextNoEnter(paneId, payload);
    sendJson(res, 200, { ok: true, pane_id: paneId, key });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostKill(res, paneId) {
  try {
    const _safety = safetyPolicy.evaluate({ action: 'kill_session', paneId });
    if (!_safety.allowed) {
      return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
    }
    wez.killPane(paneId);
    // Auto-cleanup worktree if this pane had one
    const wt = worktreeRegistry.get(paneId);
    if (wt) {
      try {
        execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" worktree remove "${wt.worktreePath}" --force`, { timeout: 15000, encoding: 'utf8' });
      } catch (e) { log(`worktree auto-cleanup remove failed for pane ${paneId}: ${e.message}`); }
      try {
        execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" branch -d "${wt.branchName}"`, { timeout: 15000, encoding: 'utf8' });
      } catch { /* branch not merged — expected, not an error */ }
      worktreeRegistry.delete(paneId);
      teamManifest.record({ event: 'worktree_removed', pane_id: paneId }, { log });
    }
    sendJson(res, 200, { ok: true, pane_id: paneId, worktree_cleaned: !!wt });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// --- auto-handoff endpoint (v2.6) ---

async function handlePostAutoHandoff(req, res, paneId) {
  try {
    const panes = collectPanes();
    const pane = panes.find(p => p.pane_id === paneId);
    if (!pane) return sendJson(res, 404, { error: 'pane not found' });

    if (pane.status === 'working') return sendJson(res, 409, { error: 'pane is working, retry when idle' });

    const body = await parseBody(req);
    const focus = body.focus || '';
    const force = !!body.force;
    let readinessResult = null;

    // PRE-HANDOFF READINESS CHECK (skip if force)
    if (!force) {
      const ctxPct = pane.ctx || 'unknown';
      const checkPrompt = `[AUTO-HANDOFF READINESS CHECK] The dashboard is considering a session reset because Ctx is at ${ctxPct}%. Are you at a natural break point where a handoff WOULD NOT lose mid-task context?\n\nReply in exactly this format:\n  READY: <1-line reason>\n  — or —\n  NOT_READY: <what you'd need to finish first>\n\nNothing else.`;
      wez.sendText(paneId, checkPrompt);
      wez.sendTextNoEnter(paneId, '\r');

      // 30s (15 × 2s) was too short for Opus 4.7 xhigh effort — observed
      // 40-60s response times on complex panes. Bumped to 120s (60 × 2s).
      // Pane panes still thinking after 120s likely have a real problem.
      const READINESS_POLL_ITERATIONS = 60;
      for (let i = 0; i < READINESS_POLL_ITERATIONS; i++) {
        await sleep(2000);
        try {
          const text = wez.getFullText(paneId, 20) || '';
          // Match only Claude's actual response (prefixed with ● bullet), not the prompt's placeholder.
          const match = text.match(/●\s*(READY|NOT_READY):\s*(.+?)(?:\n|$)/);
          if (match) { readinessResult = { status: match[1], reason: match[2].trim() }; break; }
        } catch { /* pane may be transitioning */ }
      }

      if (!readinessResult) {
        log(`[auto-handoff] pane-${paneId} readiness timed out after ${READINESS_POLL_ITERATIONS * 2}s`);
        return sendJson(res, 504, { error: `readiness check timed out after ${READINESS_POLL_ITERATIONS * 2}s — pane may be mid-thinking, retry or pass force:true` });
      }
      log(`[auto-handoff] pane-${paneId} responded ${readinessResult.status}: ${readinessResult.reason.slice(0, 80)}`);
      if (readinessResult.status === 'NOT_READY') {
        return sendJson(res, 409, {
          error: 'pane declined handoff',
          reason: readinessResult.reason,
          retry_hint: 'wait for pane to finish, or pass force:true',
        });
      }
      // READY: proceed
    }

    const corrShort = Math.random().toString(36).slice(2, 8);
    const corr = 'handoff-' + corrShort;
    const filename = 'handoff-' + isoForFilename() + '-' + corrShort + '.md';

    const instruction = `Use the /handoff skill to write a comprehensive session handoff to handoffs/${filename}. Corr: ${corr}. Focus: ${focus || 'general checkpoint'}. Include sections: Context, Current State, Open Threads, Next Steps, Constraints & Gotchas, Relevant Files. Do NOT include credentials, API keys, tokens, or private paths. Write the file, then stop.`;
    log(`[auto-handoff] pane-${paneId} dispatching /handoff skill (corr=${corr})`);
    wez.sendText(paneId, instruction);
    wez.sendTextNoEnter(paneId, '\r');

    // Poll for file existence
    const paneCwd = (pane.project || '').replace(/^\//, '');
    const handoffsDir = path.join(paneCwd, 'handoffs');
    const filePath = path.join(handoffsDir, filename);
    let fileFound = false;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 200) {
          fileFound = true; break;
        }
      } catch { /* file not ready yet */ }
    }
    if (!fileFound) {
      log(`[auto-handoff] pane-${paneId} handoff file not written within 90s`);
      return sendJson(res, 504, { error: 'handoff generation timed out', partial: true });
    }
    log(`[auto-handoff] pane-${paneId} handoff file found: ${filename}`);

    // Verify file has required sections
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 4000);
    const sectionCount = ['## Current State', '## Next Steps', '## Open Threads', '## Context']
      .filter(h => content.includes(h)).length;
    if (sectionCount < 2) {
      log(`[auto-handoff] pane-${paneId} handoff file incomplete (only ${sectionCount}/4 sections)`);
      return sendJson(res, 500, { error: 'handoff file incomplete', file: 'handoffs/' + filename, sections_found: sectionCount });
    }

    // WAIT FOR PANE TO BE TRULY IDLE before sending /clear. The /handoff skill
    // triggers a Stop event, which fires stop hooks (e.g. memorymaster
    // auto-ingest) that can start NEW turns — including opening permission
    // prompts. If we send /clear while that's in flight, it gets queued
    // behind the permission dialog and never executes. Poll status until
    // "idle" for N consecutive checks, up to 60s.
    let settledChecks = 0;
    const SETTLE_REQUIRED = 3; // need 3 consecutive idle reads (~6s stable)
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      try {
        const panesNow = collectPanes();
        const pNow = panesNow.find(x => x.pane_id === paneId);
        if (pNow && pNow.status === 'idle') {
          settledChecks++;
          if (settledChecks >= SETTLE_REQUIRED) break;
        } else {
          settledChecks = 0;
        }
      } catch { /* transient */ }
    }
    log(`[auto-handoff] pane-${paneId} settled (idle ${settledChecks}x consecutive), sending /clear`);

    // Send Ctrl+C first to cancel any pending permission dialog, then /clear
    try { wez.sendTextNoEnter(paneId, '\x03'); } catch {}
    await sleep(500);
    wez.sendText(paneId, '/clear');
    wez.sendTextNoEnter(paneId, '\r');
    await sleep(4000);
    wez.sendTextNoEnter(paneId, '\r'); // belt-and-suspenders — /clear confirmation

    // Inject continuation
    log(`[auto-handoff] pane-${paneId} injecting continuation prompt`);
    wez.sendText(paneId, `Continue your work from the handoff file at handoffs/${filename}. Read it FIRST, then proceed with your next step.`);
    wez.sendTextNoEnter(paneId, '\r');
    await sleep(500);
    wez.sendTextNoEnter(paneId, '\r');

    // Track
    handoffRegistry.set(corr, {
      corr, paneId, file: 'handoffs/' + filename,
      createdAt: Date.now(), readinessReason: force ? 'forced' : (readinessResult?.reason || 'unknown'),
      status: 'completed',
    });

    sendJson(res, 200, {
      ok: true, corr, handoff_file: 'handoffs/' + filename,
      session_cleared: true,
      readiness_reason: force ? 'forced' : (readinessResult?.reason || 'unknown'),
    });
  } catch (err) {
    log(`POST /api/sessions/${paneId}/auto-handoff error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

// --- persona resolution (v2.5 Agency Mode) ---
const _os = require('os');
const AGENTS_DIR = path.join(_os.homedir(), '.claude', 'agents');

function resolvePersona(name) {
  if (!name) return null;
  // Sanitize: only allow alnum, dash, underscore, dot — no path traversal
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) return null;
  // 1. Exact flat match: ~/.claude/agents/<name>.md
  const flat = path.join(AGENTS_DIR, safe + '.md');
  if (fs.existsSync(flat)) return flat;
  // 2. Category/name: ~/.claude/agents/*/<name>.md (one level deep)
  try {
    const dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const nested = path.join(AGENTS_DIR, d.name, safe + '.md');
      if (fs.existsSync(nested)) return nested;
    }
  } catch { /* agents dir missing */ }
  // 3. Name matches the filename (without category prefix, e.g. "dev-backend-api" lives in development/)
  try {
    const dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const entries = fs.readdirSync(path.join(AGENTS_DIR, d.name)).filter(f => f.endsWith('.md'));
      for (const f of entries) {
        if (f.replace(/\.md$/, '') === safe) return path.join(AGENTS_DIR, d.name, f);
      }
    }
  } catch {}
  return null;
}

// Parse YAML frontmatter from a persona .md file (first --- block).
function parsePersonaFrontmatter(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = {};
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    return fm;
  } catch { return {}; }
}

// GET /api/personas — list available persona files with metadata.
let personasCache = null;
let personasCacheTs = 0;
const PERSONAS_CACHE_TTL = 60000;

async function handleGetPersonas(req, res) {
  try {
    const now = Date.now();
    if (personasCache && (now - personasCacheTs) < PERSONAS_CACHE_TTL) {
      return sendJson(res, 200, personasCache);
    }
    const personas = [];
    if (!fs.existsSync(AGENTS_DIR)) return sendJson(res, 200, []);
    const walk = (dir, prefix) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          walk(path.join(dir, e.name), prefix ? prefix + '/' + e.name : e.name);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          const filePath = path.join(dir, e.name);
          const fm = parsePersonaFrontmatter(filePath);
          personas.push({
            name: fm.name || e.name.replace(/\.md$/, ''),
            file: e.name,
            category: prefix || null,
            path: (prefix ? prefix + '/' : '') + e.name,
            description: fm.description || null,
            type: fm.type || null,
            color: fm.color || null,
          });
        }
      }
    };
    walk(AGENTS_DIR, '');
    // Deduplicate: some agents exist at both category/name.md AND category/sub/name.md.
    // Keep the shorter path (direct child of category).
    const seen = new Map();
    for (const p of personas) {
      const key = p.name;
      if (!seen.has(key) || p.path.split('/').length < seen.get(key).path.split('/').length) {
        seen.set(key, p);
      }
    }
    const result = Array.from(seen.values()).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
    personasCache = result;
    personasCacheTs = now;
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostSpawn(req, res) {
  try {
    const body = await parseBody(req);
    const { cwd, program } = body;
    if (!cwd) return sendJson(res, 400, { error: 'missing `cwd` body field' });

    // Validate persona if provided
    if (body.persona) {
      const personaPath = resolvePersona(body.persona);
      if (!personaPath) return sendJson(res, 400, { error: `persona "${body.persona}" not found in ${AGENTS_DIR}` });
    }

    // Use shared helper for persona/worktree/permission spawns
    if (body.persona || body.permission_mode || body.worktree) {
      try {
        const { paneId, worktreeInfo } = await spawnAgentPane({
          cwd,
          persona: body.persona || null,
          permission_mode: body.permission_mode || null,
          worktree: body.worktree || false,
        });
        const response = { ok: true, pane_id: paneId, persona: body.persona || null };
        if (worktreeInfo) response.worktree = { path: worktreeInfo.path, branch: worktreeInfo.branch };
        return sendJson(res, 200, response);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // Plain spawn (no persona, no worktree, no permission_mode) — original behavior
    const paneId = wez.spawnPane({ cwd, program, args: undefined });
    sendJson(res, 200, { ok: true, pane_id: paneId, persona: null });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// --- worktree endpoints (v2.5 Phase 3) ---

async function handleGetWorktrees(req, res) {
  try {
    const worktrees = Array.from(worktreeRegistry.entries()).map(([paneId, wt]) => ({
      paneId,
      persona: wt.persona,
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      baseCwd: wt.baseCwd,
    }));
    sendJson(res, 200, { worktrees });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostWorktreeCleanup(req, res, paneId) {
  try {
    const wt = worktreeRegistry.get(paneId);
    if (!wt) return sendJson(res, 404, { error: `pane ${paneId} has no registered worktree` });
    const _safety = safetyPolicy.evaluate({
      action: 'worktree_remove',
      baseCwd: wt.baseCwd,
      worktreePath: wt.worktreePath,
    });
    if (!_safety.allowed) {
      return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
    }
    try {
      execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" worktree remove "${wt.worktreePath}" --force`, { timeout: 15000, encoding: 'utf8' });
    } catch (e) {
      return sendJson(res, 500, { error: `worktree remove failed: ${e.message}` });
    }
    try {
      execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" branch -d "${wt.branchName}"`, { timeout: 15000, encoding: 'utf8' });
    } catch { /* branch not merged — soft delete fails, that is OK */ }
    const removed = wt.worktreePath;
    const branch = wt.branchName;
    worktreeRegistry.delete(paneId);
    teamManifest.record({ event: 'worktree_removed', pane_id: paneId }, { log });
    sendJson(res, 200, { ok: true, removed, branch });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostWorktreeMerge(req, res, paneId) {
  try {
    const wt = worktreeRegistry.get(paneId);
    if (!wt) return sendJson(res, 404, { error: `pane ${paneId} has no registered worktree` });
    try {
      const stdout = execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" merge "${wt.branchName}" --no-edit`, { timeout: 15000, encoding: 'utf8' });
      sendJson(res, 200, { ok: true, merged: wt.branchName, stats: stdout.trim() });
    } catch (mergeErr) {
      const output = String(mergeErr.stdout || '') + String(mergeErr.stderr || '');
      if (output.includes('CONFLICT') || output.includes('Merge conflict')) {
        const conflictLines = output.split('\n').filter(l => l.includes('CONFLICT'));
        const files = conflictLines.map(l => {
          const m = l.match(/CONFLICT.*?:\s*(?:Merge conflict in\s+)?(.+)/);
          return m ? m[1].trim() : l.trim();
        });
        return sendJson(res, 200, { ok: false, conflicts: true, files });
      }
      return sendJson(res, 500, { error: `merge failed: ${mergeErr.message}` });
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// --- Agency Mode endpoints (Phase 4 — PRD-driven team bootstrap) ---

async function handleGetPRDs(req, res) {
  try {
    if (!fs.existsSync(PRD_DIR)) return sendJson(res, 200, { prds: [] });
    const files = fs.readdirSync(PRD_DIR).filter(f => f.endsWith('.md'));
    const prds = [];
    for (const f of files) {
      const parsed = parsePRD(path.join(PRD_DIR, f));
      if (!parsed) continue;
      prds.push({
        file: f,
        slug: f.replace(/\.md$/, ''),
        name: parsed.name,
        roles_count: parsed.roles.length,
        scope: parsed.scope,
        deadline: parsed.deadline,
      });
    }
    sendJson(res, 200, { prds });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGetTeams(req, res) {
  try {
    // Merge live pane status from discoverPanes
    const livePanes = collectPanes();
    const paneStatusMap = new Map();
    for (const p of livePanes) {
      paneStatusMap.set(p.pane_id, p.status || 'unknown');
    }

    const teams = [];
    for (const [name, team] of teamsRegistry) {
      const roles = team.roles.map(r => ({
        pane_id: r.paneId,
        persona: r.persona,
        worktree: r.worktree || false,
        branch: r.branch || null,
        task: r.task,
        status: paneStatusMap.get(r.paneId) || r.status || 'unknown',
      }));
      teams.push({
        name,
        prd: team.prd,
        createdAt: team.createdAt,
        cwd: team.cwd,
        roles,
      });
    }
    sendJson(res, 200, { teams });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function handlePostBootstrap(req, res) {
  try {
    const body = await parseBody(req);
    const prdSlug = typeof body.prd === 'string' ? body.prd.trim() : '';
    if (!prdSlug) return sendJson(res, 400, { error: 'missing `prd` field' });

    const prdFile = path.join(PRD_DIR, prdSlug + '.md');
    if (!fs.existsSync(prdFile)) {
      return sendJson(res, 404, { error: `PRD file not found: docs/prd/${prdSlug}.md` });
    }

    const prd = parsePRD(prdFile);
    if (!prd) {
      return sendJson(res, 400, { error: `failed to parse PRD frontmatter in docs/prd/${prdSlug}.md` });
    }

    // Resolve cwd: body.cwd override, else dashboard's own cwd
    const cwd = (body.cwd && typeof body.cwd === 'string') ? body.cwd : process.cwd();

    const agents = [];
    const teamRoles = [];

    for (let i = 0; i < prd.roles.length; i++) {
      const role = prd.roles[i];

      // Rate limit: 3s between spawns (skip delay before first)
      if (i > 0) await sleep(3000);

      let paneId = null;
      let wtInfo = null;
      try {
        const result = await spawnAgentPane({
          cwd,
          persona: role.persona,
          permission_mode: role.permission_mode || null,
          worktree: role.worktree || false,
        });
        paneId = result.paneId;
        wtInfo = result.worktreeInfo;
      } catch (spawnErr) {
        log(`bootstrap spawn failed for role ${role.persona}: ${spawnErr.message}`);
        agents.push({ persona: role.persona, error: spawnErr.message });
        teamRoles.push({
          paneId: null, persona: role.persona, worktree: role.worktree || false,
          branch: null, task: role.task, status: 'spawn_failed',
        });
        continue;
      }

      // Wait for Claude to boot before sending task
      await sleep(8000);

      // Build A2A handoff prompt
      const corrId = `prd-${prdSlug}-${i}`;
      const handoffPrompt = [
        `[A2A from dashboard to pane-${paneId} | corr=${corrId} | type=request]`,
        `You are the ${role.persona} on team "${prd.name}".`,
        `Your task: ${role.task}`,
        `Scope: ${prd.scope || 'full project'}`,
        '',
        'Start working. When done, report completion via A2A result envelope.',
      ].join('\n');

      try {
        wez.sendText(paneId, handoffPrompt);
        wez.sendTextNoEnter(paneId, '\r');
      } catch (sendErr) {
        log(`bootstrap handoff failed for pane ${paneId}: ${sendErr.message}`);
      }

      agents.push({
        pane_id: paneId,
        persona: role.persona,
        worktree: role.worktree || false,
        branch: wtInfo ? wtInfo.branch : null,
        task: role.task,
      });

      teamRoles.push({
        paneId,
        persona: role.persona,
        worktree: role.worktree || false,
        branch: wtInfo ? wtInfo.branch : null,
        task: role.task,
        status: 'dispatched',
      });
    }

    // Register the team
    teamsRegistry.set(prd.name, {
      prd: prdSlug,
      createdAt: Date.now(),
      cwd,
      roles: teamRoles,
    });
    teamManifest.record({
      event: 'team_added',
      team_name: prd.name,
      prd: prdSlug,
      cwd,
      roles: teamRoles,
    }, { log });

    sendJson(res, 200, { ok: true, team: prd.name, agents });
  } catch (err) {
    log(`POST /api/agency/bootstrap error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

// --- handoffs history (filesystem scan of <pane-cwd>/handoffs/*.md) ---

const HANDOFF_HEADER_RE_SOURCE = /#\s*Handoff\s+from\s+([^(]+?)\s*\(pane-(\d+)\)/i;
const HANDOFF_HEADER_RE_TARGET = /→\s*([^(]+?)\s*\(pane-(\d+)\)/;
const HANDOFF_SENT_RE = /\*\*Sent\*\*\s*:\s*(\S+)/i;
const HANDOFF_CORR_RE = /\*\*Corr\*\*\s*:\s*(\S+)/i;

function parseHandoffHeader(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 25).join('\n');
  const src = head.match(HANDOFF_HEADER_RE_SOURCE);
  const tgt = head.match(HANDOFF_HEADER_RE_TARGET);
  const sent = head.match(HANDOFF_SENT_RE);
  const corr = head.match(HANDOFF_CORR_RE);
  return {
    source_project: src ? src[1].trim() : null,
    source_pane: src ? parseInt(src[2], 10) : null,
    target_project: tgt ? tgt[1].trim() : null,
    target_pane: tgt ? parseInt(tgt[2], 10) : null,
    timestamp: sent ? sent[1].trim() : null,
    corr: corr ? corr[1].trim() : null,
  };
}

async function handleGetHandoffs(req, res, paneIdRaw) {
  try {
    const paneId = parseInt(paneIdRaw, 10);
    if (!Number.isFinite(paneId)) {
      return sendJson(res, 400, { error: 'pane query param required (integer)' });
    }
    const panes = discoverPanes ? discoverPanes() : [];
    const pane = panes.find(p => (p.paneId ?? p.pane_id) === paneId);
    if (!pane || !pane.project) {
      return sendJson(res, 200, { handoffs: [], note: `pane ${paneId} has no known cwd` });
    }
    const handoffsDir = path.join(pane.project, 'handoffs');
    if (!fs.existsSync(handoffsDir) || !fs.statSync(handoffsDir).isDirectory()) {
      return sendJson(res, 200, { handoffs: [], note: `no handoffs/ dir at ${handoffsDir}` });
    }
    const entries = fs.readdirSync(handoffsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'));

    const handoffs = [];
    for (const e of entries) {
      const filepath = path.join(handoffsDir, e.name);
      let head = '';
      try {
        const fd = fs.openSync(filepath, 'r');
        try {
          const buf = Buffer.alloc(4096);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          head = buf.slice(0, n).toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { /* skip unreadable */ continue; }

      const meta = parseHandoffHeader(head);
      let mtime = null;
      try { mtime = fs.statSync(filepath).mtime.toISOString(); } catch { /* ignore */ }
      handoffs.push({
        filename: e.name,
        filepath,
        source_pane: meta.source_pane,
        source_project: meta.source_project,
        target_pane: meta.target_pane,
        target_project: meta.target_project,
        timestamp: meta.timestamp || mtime,
        corr: meta.corr,
      });
    }
    handoffs.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    sendJson(res, 200, { handoffs });
  } catch (err) {
    log(`GET /api/handoffs error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

// --- routines fire (proxy to Anthropic /v1/claude_code/routines/:id/fire) ---

const ROUTINES_API_HOST = 'api.anthropic.com';
const ROUTINES_BETA_HEADER = 'experimental-cc-routine-2026-04-01';
const ROUTINES_ANTHROPIC_VERSION = '2023-06-01';
const ROUTINES_TIMEOUT_MS = 15 * 1000;

async function handlePostRoutinesFire(req, res) {
  try {
    const body = await parseBody(req);
    const routineId = typeof body.routine_id === 'string' ? body.routine_id.trim() : '';
    if (!routineId) {
      return sendJson(res, 400, { error: 'routine_id is required' });
    }
    const routine = routinesConfig.getRoutine(routineId);
    if (!routine) {
      return sendJson(res, 400, {
        error: `routine_id "${routineId}" not found in vault/_routines-config.md. ` +
               'Add a YAML block for it, or copy _routines-config.md.template to activate.',
      });
    }
    const envVar = (typeof body.token_env_var === 'string' && body.token_env_var.trim())
      ? body.token_env_var.trim()
      : routine.token_env || routinesConfig.defaultTokenEnv(routineId);
    const token = process.env[envVar];
    if (!token) {
      return sendJson(res, 400, {
        error: `Bearer token env var "${envVar}" is not set. Generate a token on the routine's Edit page and export ${envVar}=<token> before starting the dashboard.`,
      });
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const payload = text.trim() ? JSON.stringify({ text }) : '';

    const headers = {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': ROUTINES_BETA_HEADER,
      'anthropic-version': ROUTINES_ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const upstream = https.request({
      hostname: ROUTINES_API_HOST,
      port: 443,
      path: `/v1/claude_code/routines/${encodeURIComponent(routineId)}/fire`,
      method: 'POST',
      headers,
      timeout: ROUTINES_TIMEOUT_MS,
    }, (up) => {
      let buf = '';
      up.on('data', chunk => { buf += chunk.toString('utf8'); });
      up.on('end', () => {
        const status = up.statusCode || 502;
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* non-JSON upstream */ }
        if (parsed) {
          sendJson(res, status, parsed);
        } else {
          res.writeHead(status, {
            'Content-Type': up.headers['content-type'] || 'text/plain',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(buf);
        }
      });
    });
    upstream.on('error', err => {
      log(`routines fire upstream error: ${err.message}`);
      sendJson(res, 502, { error: `upstream error: ${err.message}` });
    });
    upstream.on('timeout', () => {
      upstream.destroy(new Error('upstream timeout'));
      sendJson(res, 504, { error: 'upstream timeout (15s)' });
    });
    if (payload) upstream.write(payload);
    upstream.end();
  } catch (err) {
    log(`POST /api/routines/fire error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

// --- static file serving ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.map':  'application/json',
};

function serveStatic(res, urlPath) {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Dashboard not built. Run: cd dashboard && npm install && npm run build');
  }
  let relPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(STATIC_DIR, relPath);
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback to index.html
    const idx = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return fs.createReadStream(idx).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// --- CSRF / cross-origin defense for POST endpoints ---
//
// Threat: the dashboard serves on PORT with zero auth — a malicious website
// opened in the same browser could POST to /api/panes/:id/kill etc via
// fetch() and kill panes, inject prompts, exfiltrate handoffs, etc.
//
// Browsers ALWAYS send an `Origin` header on cross-origin requests with
// non-trivial methods (POST with Content-Type: application/json is one).
// Same-origin requests from our own dashboard HTML set Origin to the host
// they loaded from. Curl/CLI requests omit Origin entirely — we allow
// those (no browser = no CSRF vector).
//
// Allowed origins are computed at boot: localhost + 127.0.0.1 + every
// non-internal IPv4/IPv6 address assigned to a local network interface.
// This means phones/tablets/other devices on the LAN can hit the
// dashboard at http://<machine-lan-ip>:PORT/ and POST actions will
// succeed (same-origin from their perspective). DHCP rotations require
// a dashboard restart.
const os = require('os');

function computeAllowedOrigins() {
  const origins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`,
  ]);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (addr.internal) continue;
        if (addr.family === 'IPv4' || addr.family === 4) {
          origins.add(`http://${addr.address}:${PORT}`);
        } else if (addr.family === 'IPv6' || addr.family === 6) {
          // IPv6 literal in URL requires brackets
          origins.add(`http://[${addr.address.replace(/%.*$/, '')}]:${PORT}`);
        }
      }
    }
  } catch (e) { log(`networkInterfaces() failed: ${e.message}`); }
  return origins;
}

const ALLOWED_ORIGINS = computeAllowedOrigins();

function isOriginAllowed(req) {
  const origin = req.headers.origin;
  // No Origin header: non-browser request (curl, node http, etc). Allow.
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin.toLowerCase());
}

// --- server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // CSRF defense: reject POSTs with a mismatched Origin. Only state-changing
  // methods are gated — GETs on the API are idempotent and read-only.
  if (method === 'POST' && !isOriginAllowed(req)) {
    log(`CSRF: rejected POST ${pathname} from Origin: ${req.headers.origin}`);
    return sendJson(res, 403, { error: 'origin not allowed' });
  }

  // API routes
  if (pathname === '/api/panes' && method === 'GET') return handleGetPanes(req, res);
  if (pathname === '/api/sessions' && method === 'GET') return handleGetSessions(req, res);
  if (pathname === '/api/projects' && method === 'GET') return handleGetProjects(req, res);
  if (pathname === '/api/browse' && method === 'GET') return handleGetBrowse(req, res, url.searchParams.get('path'));
  if (pathname === '/api/broadcast' && method === 'POST') return handlePostBroadcast(req, res);
  if (pathname === '/api/a2a/pending' && method === 'GET') return handleGetA2APending(req, res);
  if (pathname === '/api/grades' && method === 'GET') return handleGetGrades(req, res);
  if (pathname === '/api/grade' && method === 'POST') return handlePostGrade(req, res);
  if (pathname === '/api/a2a/handoff' && method === 'POST') return handlePostA2AHandoff(req, res);
  if (pathname === '/api/handoffs' && method === 'GET') return handleGetHandoffs(req, res, url.searchParams.get('pane'));
  if (pathname === '/api/routines/fire' && method === 'POST') return handlePostRoutinesFire(req, res);
  if (pathname === '/api/personas' && method === 'GET') return handleGetPersonas(req, res);
  if (pathname === '/api/worktrees' && method === 'GET') return handleGetWorktrees(req, res);
  if (pathname === '/api/agency/prds' && method === 'GET') return handleGetPRDs(req, res);
  if (pathname === '/api/agency/teams' && method === 'GET') return handleGetTeams(req, res);
  if (pathname === '/api/agency/bootstrap' && method === 'POST') return handlePostBootstrap(req, res);
  if (pathname === '/api/auto-handoff/pending' && method === 'GET') return handleGetAutoHandoffPending(req, res);
  if (pathname === '/api/auto-handoff/suppress' && method === 'POST') return handlePostAutoHandoffSuppress(req, res);
  if (pathname === '/api/tasks' && method === 'GET') return handleGetTasks(res);
  if (pathname === '/api/events' && method === 'GET') return handleEvents(req, res);
  if (pathname === '/api/spawn' && method === 'POST') return handlePostSpawn(req, res);

  // Worktree action routes: /api/worktrees/:paneId/cleanup and /api/worktrees/:paneId/merge
  const wtMatch = pathname.match(/^\/api\/worktrees\/(\d+)\/(cleanup|merge)$/);
  if (wtMatch && method === 'POST') {
    const wtPaneId = parseInt(wtMatch[1], 10);
    if (wtMatch[2] === 'cleanup') return handlePostWorktreeCleanup(req, res, wtPaneId);
    if (wtMatch[2] === 'merge') return handlePostWorktreeMerge(req, res, wtPaneId);
  }

  const paneMatch = pathname.match(/^\/api\/(panes|sessions)\/(\d+)(\/(output|prompt|key|kill|auto-handoff))?$/);
  if (paneMatch) {
    const paneId = parseInt(paneMatch[2], 10);
    const sub = paneMatch[4];
    if (sub === 'output' && method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      return handleGetPaneOutput(res, paneId, lines);
    }
    if (sub === 'prompt' && method === 'POST') return handlePostPrompt(req, res, paneId);
    if (sub === 'key' && method === 'POST')    return handlePostKey(req, res, paneId);
    if (sub === 'kill' && method === 'POST')   return handlePostKill(res, paneId);
    if (sub === 'auto-handoff' && method === 'POST') return handlePostAutoHandoff(req, res, paneId);
  }

  // Static fallthrough (assets from dashboard/dist, if built)
  if (method === 'GET') return serveStatic(res, pathname);

  sendJson(res, 404, { error: 'not found' });
});

// --- v2.6 Auto-handoff monitor daemon ---
const AUTO_HANDOFF_SUGGEST = parseInt(process.env.AUTO_HANDOFF_SUGGEST_THRESHOLD || '30', 10);
const AUTO_HANDOFF_URGENT = parseInt(process.env.AUTO_HANDOFF_URGENT_THRESHOLD || '50', 10);
const AUTO_HANDOFF_COOLDOWN = parseInt(process.env.AUTO_HANDOFF_COOLDOWN_MS || String(15 * 60 * 1000), 10);

const autoHandoffSuggested = new Map(); // paneId -> lastSuggestedAt
const pendingAutoHandoffEvents = [];

// 2026-04-19 rate-reduction: skip the tick entirely if no SSE client is
// connected. No one to broadcast to = nothing to deliver, so spending a
// wezterm CLI call on collectPanes() is pure waste. Also skip if all panes
// are already in cooldown (their Ctx status doesn't change faster than that).
// Cuts ~6 wezterm CLI calls/min when the dashboard tab is closed.
setInterval(() => {
  try {
    if (sseClients.size === 0) return;
    const panes = collectPanes();
    for (const p of panes) {
      if (!p.is_claude) continue;
      if (p.ctx == null || p.ctx < AUTO_HANDOFF_SUGGEST) continue;
      if (p.status === 'working') continue;

      // Cooldown check
      const lastSuggested = autoHandoffSuggested.get(p.pane_id) || 0;
      if (Date.now() - lastSuggested < AUTO_HANDOFF_COOLDOWN) continue;

      // Determine event type
      const eventType = p.ctx >= AUTO_HANDOFF_URGENT ? 'autoHandoffUrgent' : 'autoHandoffSuggest';
      const cancelToken = Math.random().toString(36).slice(2, 10);
      const event = {
        type: eventType,
        event: eventType,
        timestamp: new Date().toISOString(),
        pane_id: p.pane_id,
        project: p.project_name,
        ctx: p.ctx,
        cancel_token: cancelToken,
      };

      log(`[auto-handoff] ${eventType}: pane-${p.pane_id} (${p.project_name}) at ${p.ctx}% Ctx`);

      pendingAutoHandoffEvents.push(event);
      if (pendingAutoHandoffEvents.length > 20) pendingAutoHandoffEvents.shift();

      // Broadcast to all connected SSE clients so dashboard.html's
      // autoHandoffSuggest / autoHandoffUrgent listeners (line ~2889) fire
      // in real time. Before this, the daemon only populated the polling
      // array and the dashboard had no poll code, so the whole 🤖
      // suggest/enforce toggle was silent end-to-end. Fixed 2026-04-17.
      broadcastSSE(event);

      autoHandoffSuggested.set(p.pane_id, Date.now());
    }
  } catch (e) { log(`[auto-handoff] monitor error: ${e.message}`); }
}, 10000);

async function handleGetAutoHandoffPending(req, res) {
  sendJson(res, 200, { events: pendingAutoHandoffEvents });
}

async function handlePostAutoHandoffSuppress(req, res) {
  try {
    const body = await parseBody(req);
    const paneId = parseInt(body.pane_id, 10);
    if (!Number.isFinite(paneId)) return sendJson(res, 400, { error: 'pane_id must be an integer' });
    const durationMs = parseInt(body.duration_ms, 10) || AUTO_HANDOFF_COOLDOWN;
    // Extend cooldown by setting lastSuggested to now + (duration - cooldown), so
    // the next eligibility window is now + durationMs.
    autoHandoffSuggested.set(paneId, Date.now() - AUTO_HANDOFF_COOLDOWN + durationMs);
    sendJson(res, 200, { ok: true, pane_id: paneId, suppressed_until: new Date(Date.now() + durationMs).toISOString() });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// Log allowed origins on boot so the user sees what LAN addresses work.
log(`allowed origins (CSRF): ${Array.from(ALLOWED_ORIGINS).join(', ')}`);

server.listen(PORT, () => {
  log(`theorchestra dashboard server listening on http://localhost:${PORT}`);
  log(`API: /api/panes, /api/tasks, /api/events (SSE)`);
  log(`Static: ${fs.existsSync(STATIC_DIR) ? STATIC_DIR : '(dashboard not built yet)'}`);
  // Task #5: A2A heartbeat SLA watcher — emits a2a_silent SSE when an
  // active corr goes >5min without a progress/ack/result beat.
  a2aHeartbeat.startWatcher({
    a2aState,
    broadcastSSE,
    intervalMs: 60 * 1000,
    thresholdMs: 5 * 60 * 1000,
    log,
  });
  log('a2a-heartbeat watcher armed (5min silent threshold, 60s scan)');
  // v3.4: session-snapshot watcher — captures cmdline of every AI pane
  // every N seconds so `scripts/restore-session.cjs` can re-spawn them
  // after a wezterm crash. v3.4.1: default ON. Opt OUT with
  // WEZBRIDGE_SESSION_SNAPSHOT=0. Set to a number > 1 to override interval.
  const snapEnv = process.env.WEZBRIDGE_SESSION_SNAPSHOT;
  if (snapEnv !== '0') {
    const intervalMs = (snapEnv && Number(snapEnv) > 1 ? Number(snapEnv) : 60) * 1000;
    sessionSnapshot.startWatcher({
      listPanes: () => wez.listPanes(),
      intervalMs,
      log,
    });
    log(`session-snapshot watcher armed (${intervalMs / 1000}s tick)`);
  }
  // Task #6: replay teams.jsonl into in-memory registries on boot so
  // they survive dashboard restart.
  try {
    const restored = teamManifest.replay();
    for (const [name, t] of restored.teams) teamsRegistry.set(name, t);
    for (const [paneId, wt] of restored.worktrees) worktreeRegistry.set(paneId, wt);
    if (restored.teams.size || restored.worktrees.size) {
      log(`team-manifest replay: ${restored.teams.size} teams, ${restored.worktrees.size} worktrees restored`);
    }
  } catch (e) {
    log(`team-manifest replay failed: ${e.message}`);
  }
});

process.on('SIGTERM', () => { log('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('SIGINT'); server.close(() => process.exit(0)); });
