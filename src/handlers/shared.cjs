'use strict';

const safetyPolicy = require('../safety-policy.cjs');
const a2aHeartbeat = require('../a2a-heartbeat.cjs');
const sessionSnapshot = require('../session-snapshot.cjs');
const teamManifest = require('../team-manifest.cjs');
const gradesRegistryFactory = require('../grades-registry.cjs');
const outcomeGrader = require('../../scripts/outcome-grader.cjs');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const ipc = require('../dashboard-server-ipc.cjs');
const wez = ipc.wez;
const { discoverPanes } = ipc;
const routinesConfig = require('../routines-config.cjs');
const { parseTasksFile } = (() => {
  try { return require('../task-parser.cjs'); }
  catch { return { parseTasksFile: () => ({ tasks: [], error: 'task-parser not available' }) }; }
})();
const { scanProjects } = (() => {
  try { return require('../project-scanner.cjs'); }
  catch { return { scanProjects: () => [] }; }
})();

const SRC_DIR = path.join(__dirname, '..');
const ACTIVE_TASKS_PATH = process.env.ACTIVE_TASKS_PATH
  || path.join(process.env.OMNICLAUDE_PATH || path.join(SRC_DIR, '..', '..', 'omniclaude'), 'active_tasks.md');

const NOISE_EVENTS = new Set(['heartbeat', 'metrics_summary', 'watcher_started', 'relaunch_me']);
const a2aState = new Map();
const A2A_MAX = 500;
const A2A_TTL_MS = 24 * 3600 * 1000;
const A2A_ENVELOPE_RE = /\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)/g;
const handoffRegistry = new Map();
const sseClients = new Set();
const worktreeRegistry = new Map();
const teamsRegistry = new Map();
const PRD_DIR = path.join(SRC_DIR, '..', 'docs', 'prd');

const _os = require('os');
const AGENTS_DIR = path.join(_os.homedir(), '.claude', 'agents');
let personasCache = null;
let personasCacheTs = 0;
const PERSONAS_CACHE_TTL = 60000;

function collectPanes() {
  return ipc.collectPanes();
}

function broadcastSSE(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch (e) { /* dead client - will be cleaned up on req.close */ }
  }
}

const gradesRegistry = gradesRegistryFactory.createRegistry({
  max: 100,
  broadcast: (e) => broadcastSSE(e),
});

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

    if (/^roles:\s*$/.test(line)) {
      inRoles = true;
      continue;
    }

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

    const roleItemMatch = line.match(/^\s+-\s+(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
    if (roleItemMatch && inRoles) {
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

    if (inRoles && /^\w/.test(line)) {
      inRoles = false;
      if (currentRole && currentRole.persona && currentRole.task) {
        result.roles.push(Object.assign({}, currentRole));
      }
      currentRole = null;
      const reMatch = line.match(/^(\w[\w_-]*):\s*"?([^"]*)"?\s*$/);
      if (reMatch) {
        if (reMatch[1] === 'scope') result.scope = reMatch[2].trim() || null;
        else if (reMatch[1] === 'deadline') result.deadline = reMatch[2].trim() || null;
      }
    }
  }

  if (currentRole && currentRole.persona && currentRole.task) {
    result.roles.push(Object.assign({}, currentRole));
  }

  if (!result.name || result.roles.length === 0) return null;
  return result;
}

function resolvePersona(name) {
  if (!name) return null;
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) return null;
  const flat = path.join(AGENTS_DIR, safe + '.md');
  if (fs.existsSync(flat)) return flat;
  try {
    const dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const nested = path.join(AGENTS_DIR, d.name, safe + '.md');
      if (fs.existsSync(nested)) return nested;
    }
  } catch { /* agents dir missing */ }
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

async function spawnAgentPane({ cwd, persona, permission_mode, worktree }, log) {
  return ipc.spawnAgentPane(
    { cwd, persona, permission_mode, worktree },
    { resolvePersona, worktreeRegistry, teamManifest, log }
  );
}

function a2aEvict() {
  const now = Date.now();
  for (const [corr, info] of a2aState) {
    if (now - (info.lastSeen || info.firstSeen) > A2A_TTL_MS) a2aState.delete(corr);
  }
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
  if (raw.event === 'peer_orphaned' && raw.corr) {
    a2aTouch(String(raw.corr), { status: 'orphaned' });
    return;
  }
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
      a2aTouch(corr, { from, to, lastProgressAt: _now, notified_silent: false });
    }
  }
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
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function createSharedContext(deps) {
  return {
    ...deps,
    safetyPolicy,
    a2aHeartbeat,
    sessionSnapshot,
    teamManifest,
    outcomeGrader,
    https,
    path,
    fs,
    spawn,
    execSync,
    ipc,
    wez,
    discoverPanes,
    routinesConfig,
    parseTasksFile,
    scanProjects,
    SRC_DIR,
    ACTIVE_TASKS_PATH,
    NOISE_EVENTS,
    a2aState,
    a2aEvict,
    a2aTouch,
    recordA2AFromRawEvent,
    handoffRegistry,
    sseClients,
    gradesRegistry,
    worktreeRegistry,
    teamsRegistry,
    PRD_DIR,
    AGENTS_DIR,
    PERSONAS_CACHE_TTL,
    get personasCache() { return personasCache; },
    set personasCache(value) { personasCache = value; },
    get personasCacheTs() { return personasCacheTs; },
    set personasCacheTs(value) { personasCacheTs = value; },
    collectPanes,
    broadcastSSE,
    parsePRD,
    resolvePersona,
    parsePersonaFrontmatter,
    spawnAgentPane: (args) => spawnAgentPane(args, deps.log),
    slugify,
    stripAnsi,
    isoForFilename,
    sleep,
  };
}

module.exports = { createSharedContext };
