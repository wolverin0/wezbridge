try { require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') }); } catch {}
/**
 * WezBridge HTTP Server — REST API for managing Claude Code sessions via WezTerm.
 *
 * Endpoints:
 *   GET    /sessions              — list all sessions
 *   GET    /sessions/:id          — get session details + current output
 *   POST   /sessions              — spawn a new Claude session
 *   POST   /sessions/:id/prompt   — inject a prompt into a session
 *   POST   /sessions/:id/kill     — kill a session
 *   GET    /sessions/:id/output   — read pane output
 *   GET    /panes                 — list raw WezTerm panes
 *   POST   /panes/:id/send        — send raw text to any pane
 *   GET    /health                — health check
 *   POST   /poll                  — manually trigger completion poll
 *   GET    /clawtrol/tasks        — fetch pending ClawTrol tasks
 *   POST   /clawtrol/sync         — auto-spawn sessions for pending tasks
 *   GET    /api/tasks             — task board (all tasks, optional ?status= filter)
 *   POST   /api/tasks/:id/claim   — claim a task from dashboard
 *   POST   /api/tasks/:id/complete — complete a task from dashboard
 */
const http = require('http');
const url = require('url');
const fs = require('fs');
const pathModule = require('path');
const crypto = require('crypto');
const sm = require('./session-manager.cjs');
const wez = require('./wezterm.cjs');
const clawtrol = require('./clawtrol-sync.cjs');
const ps = require('./project-scanner.cjs');

const WEBAPP_DIR = pathModule.join(__dirname, 'webapp');

// --- Telegram WebApp initData validation ---
function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const sorted = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const user = params.get('user');
    return user ? JSON.parse(user) : { authenticated: true };
  } catch { return null; }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Allowed user IDs (set via env, or allow all if not configured)
const ALLOWED_USERS = process.env.WEBAPP_ALLOWED_USERS
  ? process.env.WEBAPP_ALLOWED_USERS.split(',').map(Number)
  : [];
const API_KEY = process.env.WEZBRIDGE_API_KEY || null;
const CORS_ORIGIN = process.env.WEZBRIDGE_CORS_ORIGIN || 'http://localhost:4200';
const START_TIME = Date.now();

const PORT = parseInt(process.env.WEZ_BRIDGE_PORT || '4200', 10);
const POLL_INTERVAL = parseInt(process.env.WEZ_BRIDGE_POLL_MS || '5000', 10);

// Completion callback registry
const completionCallbacks = [];

function onCompletion(cb) {
  completionCallbacks.push(cb);
}

// Background poller
let pollTimer = null;

function startPoller() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const newlyWaiting = sm.pollAll();
    for (const session of newlyWaiting) {
      console.log(`[poll] Session ${session.id} (${session.name}) is now waiting for input`);

      // Notify ClawTrol
      if (session.taskId) {
        await clawtrol.notifyWaiting(session, session.lastLines);
      }

      // Fire callbacks
      for (const cb of completionCallbacks) {
        try { cb(session); } catch {}
      }
    }
  }, POLL_INTERVAL);
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// HTTP helpers
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('Request body too large')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS_ORIGIN });
  res.end(JSON.stringify(data));
}

function cors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Telegram-Init-Data',
  });
  res.end();
}

// Route handler
async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const method = req.method;

  // CORS headers for Mini App
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // --- Auth check for dashboard API routes ---
    if (path.startsWith('/api/')) {
      const initData = req.headers['x-telegram-init-data'] || parsed.query.initData;
      if (BOT_TOKEN && ALLOWED_USERS.length > 0) {
        const user = validateTelegramInitData(initData, BOT_TOKEN);
        if (!user || (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(user.id))) {
          return json(res, 401, { error: 'Unauthorized' });
        }
      }
      // If no ALLOWED_USERS configured, allow all (dev mode)
    }

    // Auth check for management endpoints (non-/api/ routes)
    if (API_KEY && path !== '/health' && !path.startsWith('/api/') && !path.startsWith('/static/')) {
      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${API_KEY}`) {
        return json(res, 401, { error: 'Unauthorized — set Authorization: Bearer <key>' });
      }
    }

    // GET /health
    if (method === 'GET' && path === '/health') {
      const panes = wez.listPanes();
      return json(res, 200, {
        status: 'ok',
        sessions: sm.listSessions().length,
        panes: panes.length,
        polling: !!pollTimer,
        uptime: process.uptime(),
      });
    }

    // GET /panes
    if (method === 'GET' && path === '/panes') {
      return json(res, 200, wez.listPanes());
    }

    // POST /panes/:id/send
    const paneSendMatch = path.match(/^\/panes\/(\d+)\/send$/);
    if (method === 'POST' && paneSendMatch) {
      const paneId = parseInt(paneSendMatch[1], 10);
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text is required' });
      wez.sendText(paneId, body.text);
      return json(res, 200, { ok: true, paneId, sent: body.text });
    }

    // GET /sessions
    if (method === 'GET' && path === '/sessions') {
      return json(res, 200, sm.listSessions());
    }

    // POST /sessions
    if (method === 'POST' && path === '/sessions') {
      const body = await readBody(req);
      if (!body.project) return json(res, 400, { error: 'project path is required' });
      const session = sm.spawnSession({
        project: body.project,
        name: body.name,
        initialPrompt: body.prompt,
        continueSession: body.continue || false,
        dangerouslySkipPermissions: false,
        taskId: body.taskId || null,
      });
      return json(res, 201, session);
    }

    // GET /sessions/:id
    const sessionMatch = path.match(/^\/sessions\/(wez-\d+)$/);
    if (method === 'GET' && sessionMatch) {
      const session = sm.getSession(sessionMatch[1]);
      if (!session) return json(res, 404, { error: 'Session not found' });
      // Also read current output
      try { session.currentOutput = sm.readOutput(sessionMatch[1]); } catch {}
      return json(res, 200, session);
    }

    // POST /sessions/:id/prompt
    const promptMatch = path.match(/^\/sessions\/(wez-\d+)\/prompt$/);
    if (method === 'POST' && promptMatch) {
      const body = await readBody(req);
      if (!body.prompt) return json(res, 400, { error: 'prompt is required' });
      const session = sm.sendPrompt(promptMatch[1], body.prompt);
      return json(res, 200, { ok: true, session });
    }

    // GET /sessions/:id/output
    const outputMatch = path.match(/^\/sessions\/(wez-\d+)\/output$/);
    if (method === 'GET' && outputMatch) {
      const output = sm.readOutput(outputMatch[1]);
      return json(res, 200, { output });
    }

    // POST /sessions/:id/kill
    const killMatch = path.match(/^\/sessions\/(wez-\d+)\/kill$/);
    if (method === 'POST' && killMatch) {
      sm.killSession(killMatch[1]);
      return json(res, 200, { ok: true });
    }

    // POST /poll
    if (method === 'POST' && path === '/poll') {
      const waiting = sm.pollAll();
      return json(res, 200, { waiting });
    }

    // GET /clawtrol/tasks
    if (method === 'GET' && path === '/clawtrol/tasks') {
      const tasks = await clawtrol.getPendingTasks();
      return json(res, 200, tasks);
    }

    // POST /clawtrol/sync — auto-create sessions for pending tasks
    if (method === 'POST' && path === '/clawtrol/sync') {
      const body = await readBody(req);
      const tasks = await clawtrol.getPendingTasks();
      const spawned = [];

      for (const task of tasks) {
        // Map task to project path
        const projectPath = body.projectMap?.[task.board] || body.defaultProject;
        if (!projectPath) continue;

        await clawtrol.claimTask(task.id);
        const session = sm.spawnSession({
          project: projectPath,
          name: task.title || task.id,
          initialPrompt: task.description || task.title,
          dangerouslySkipPermissions: false,
          taskId: task.id,
        });
        spawned.push(session);
      }

      return json(res, 200, { spawned: spawned.length, sessions: spawned });
    }

    // --- Mini App Dashboard (V3) ---

    // GET /api/sessions — dashboard-friendly session list
    if (method === 'GET' && path === '/api/sessions') {
      const sessions = sm.listSessions();
      const result = sessions.map(s => {
        const projectShort = s.project
          ? s.project.replace(/\\/g, '/').split('/').filter(Boolean).pop()
          : 'unknown';
        const uptimeMs = Date.now() - new Date(s.createdAt || Date.now()).getTime();
        return {
          id: s.id,
          name: s.name || s.id,
          project: s.project,
          projectShort,
          paneId: s.paneId,
          status: s.status || 'unknown',
          lastActivity: s.lastActivity || s.createdAt,
          promptType: s.promptType || null,
          uptime: formatUptime(uptimeMs),
        };
      });
      return json(res, 200, result);
    }

    // GET /api/status — bot health
    if (method === 'GET' && path === '/api/status') {
      const sessions = sm.listSessions();
      const working = sessions.filter(s => s.status === 'running').length;
      return json(res, 200, {
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        uptimeStr: formatUptime(Date.now() - START_TIME),
        sessions: sessions.length,
        working,
        idle: sessions.length - working,
        version: '3.0.0',
      });
    }

    // POST /api/session/:id/action/:action — trigger actions from dashboard
    const actionMatch = path.match(/^\/api\/session\/([^/]+)\/action\/([^/]+)$/);
    if (method === 'POST' && actionMatch) {
      const session = sm.getSession(actionMatch[1]);
      if (!session) return json(res, 404, { error: 'Session not found' });
      const action = actionMatch[2];
      const actionMap = {
        continue: '',
        tests: 'run tests',
        commit: '/commit',
        compact: '/compact',
        review: '/review',
        diff: '!git diff --stat',
      };
      if (action === 'kill') {
        sm.killSession(actionMatch[1]);
        return json(res, 200, { ok: true, action: 'kill' });
      }
      if (actionMap[action] !== undefined) {
        const text = actionMap[action];
        try {
          if (text) {
            wez.sendText(session.paneId, text);
          } else {
            // 'continue' — send Enter to resume
            wez.sendText(session.paneId, '\n');
          }
          session.status = 'running';
          session._stabilityCount = 0;
          session._lastScrollbackHash = null;
        } catch (err) {
          return json(res, 500, { error: 'Pane unreachable: ' + (err.message || err) });
        }
        return json(res, 200, { ok: true, action });
      }
      return json(res, 400, { error: `Unknown action: ${action}` });
    }

    // GET /api/projects — list all Claude projects
    if (method === 'GET' && path === '/api/projects') {
      const projects = ps.scanProjects().map(p => ({
        ...p,
        // Derive friendly name from projectRoot or path (last segment)
        friendlyName: (p.projectRoot || p.path || p.name || '')
          .replace(/\\/g, '/').split('/').filter(Boolean).pop() || p.name,
      }));
      return json(res, 200, projects);
    }

    // GET /api/projects/:name/sessions — list sessions for a project
    if (method === 'GET' && path.match(/^\/api\/projects\/([^/]+)\/sessions$/)) {
      const name = decodeURIComponent(path.match(/^\/api\/projects\/([^/]+)\/sessions$/)[1]);
      const projects = ps.scanProjects();
      const project = projects.find(p => p.name === name || p.encodedName === name);
      if (!project) return json(res, 404, { error: 'Project not found' });
      const sessions = ps.scanSessions(project.dir);
      return json(res, 200, sessions);
    }

    // GET /api/costs — cost summary
    if (method === 'GET' && path === '/api/costs') {
      const fmt = s => ({ usd: s.totalUsd, input: s.totalInput, output: s.totalOutput, sessions: s.sessionCount });
      const today = fmt(ps.getCostSummary('today'));
      const week = fmt(ps.getCostSummary('week'));
      const all = fmt(ps.getCostSummary('all'));
      return json(res, 200, { today, week, all });
    }

    // GET /api/session/:id/stream — SSE endpoint for live terminal output
    const streamMatch = path.match(/^\/api\/session\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const sessionId = decodeURIComponent(streamMatch[1]);
      const session = sm.getSession(sessionId);
      if (!session) return json(res, 404, { error: 'Session not found' });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': CORS_ORIGIN,
      });

      let lastOutput = '';
      const interval = setInterval(() => {
        try {
          const output = sm.readOutput(sessionId);
          if (output !== lastOutput) {
            const newContent = output.slice(lastOutput.length);
            lastOutput = output;
            res.write('data: ' + JSON.stringify({ delta: newContent, full: false }) + '\n\n');
          }
        } catch {
          clearInterval(interval);
          res.end();
        }
      }, 1000);

      req.on('close', () => clearInterval(interval));
      return; // Don't end response — SSE stays open
    }

    // GET /api/session/:id/output — session terminal output for live viewer
    const outputApiMatch = path.match(/^\/api\/session\/([^/]+)\/output$/);
    if (method === 'GET' && outputApiMatch) {
      const output = sm.readOutput(outputApiMatch[1]);
      return json(res, 200, { output });
    }

    // POST /api/spawn — spawn a new session from dashboard
    if (method === 'POST' && path === '/api/spawn') {
      const body = await readBody(req);
      if (!body.project) return json(res, 400, { error: 'project path required' });
      // Resolve project: body.project could be encodedName or real path
      const projects = ps.scanProjects();
      const proj = projects.find(p =>
        p.encodedName === body.project || p.name === body.project ||
        p.projectRoot === body.project || p.path === body.project
      );
      const realPath = proj?.projectRoot || proj?.path || body.project;
      const friendlyName = body.name || (realPath.replace(/\\/g, '/').split('/').filter(Boolean).pop()) || body.project;
      const session = sm.spawnSession({
        project: realPath,
        name: friendlyName,
        continueSession: true,
        dangerouslySkipPermissions: false,
      });
      // Notify bot to create Telegram topic for this session
      sm.events.emit('session:spawned-api', { session, projectName: friendlyName });
      return json(res, 201, session);
    }

    // GET /api/tasks — ClawTrol task board
    if (method === 'GET' && path === '/api/tasks') {
      try {
        const query = parsed.query || {};
        const statusFilter = query.status || '';
        const endpoint = statusFilter ? `/tasks?status=${statusFilter}` : '/tasks';
        const result = await clawtrol.clawtrolRequest('GET', endpoint);
        const raw = Array.isArray(result.data) ? result.data : (result.data?.tasks || []);
        const tasks = raw.map(t => ({
          id: t.id,
          title: t.title || t.name || t.id,
          status: t.status || 'unknown',
          priority: t.priority || 'normal',
          assignee: t.assignee || t.agent || null,
          createdAt: t.createdAt || t.created_at || null,
          board: t.board || t.project || null,
        }));
        return json(res, 200, tasks);
      } catch (err) {
        return json(res, 502, { error: 'ClawTrol unreachable: ' + (err.message || err) });
      }
    }

    // POST /api/tasks/:id/claim — claim a task from dashboard
    const taskClaimMatch = path.match(/^\/api\/tasks\/([^/]+)\/claim$/);
    if (method === 'POST' && taskClaimMatch) {
      const taskId = decodeURIComponent(taskClaimMatch[1]);
      const result = await clawtrol.claimTask(taskId);
      if (!result) return json(res, 502, { error: 'Failed to claim task' });
      return json(res, 200, { ok: true, taskId, status: result.status, data: result.data });
    }

    // POST /api/tasks/:id/complete — complete a task from dashboard
    const taskCompleteMatch = path.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (method === 'POST' && taskCompleteMatch) {
      const taskId = decodeURIComponent(taskCompleteMatch[1]);
      try {
        const body = await readBody(req);
        const result = await clawtrol.clawtrolRequest('PATCH', `/tasks/${taskId}`, {
          status: 'completed',
          result: {
            completedAt: new Date().toISOString(),
            source: 'wez-bridge-dashboard',
            note: body.note || '',
          },
        });
        return json(res, 200, { ok: true, taskId, status: result.status, data: result.data });
      } catch (err) {
        return json(res, 502, { error: 'Failed to complete task: ' + (err.message || err) });
      }
    }

    // GET /api/files — list changed files (git status) for a project
    if (method === 'GET' && path === '/api/files') {
      const projectPath = (parsed.query || {}).project;
      if (!projectPath) return json(res, 400, { error: 'project query param required' });
      try {
        const { execFileSync } = require('child_process');
        // Get git status with porcelain format
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf-8', timeout: 5000 });
        const numstat = execFileSync('git', ['diff', '--numstat'], { cwd: projectPath, encoding: 'utf-8', timeout: 5000 });
        const statMap = {};
        for (const line of numstat.split('\n')) {
          const parts = line.trim().split('\t');
          if (parts.length >= 3) {
            statMap[parts[2]] = { insertions: parseInt(parts[0]) || 0, deletions: parseInt(parts[1]) || 0 };
          }
        }
        const files = status.split('\n').filter(Boolean).map(line => {
          const code = line.substring(0, 2).trim();
          const file = line.substring(3);
          const st = code.includes('A') || code === '??' ? 'added' : code.includes('D') ? 'deleted' : 'modified';
          const stats = statMap[file] || {};
          return { file, status: st, insertions: stats.insertions || 0, deletions: stats.deletions || 0 };
        });
        return json(res, 200, files);
      } catch (err) {
        return json(res, 200, []); // Empty if not a git repo or error
      }
    }

    // GET /api/files/diff — get diff for a specific file
    if (method === 'GET' && path === '/api/files/diff') {
      const q = parsed.query || {};
      if (!q.project || !q.file) return json(res, 400, { error: 'project and file params required' });
      try {
        const { execFileSync } = require('child_process');
        const diff = execFileSync('git', ['diff', '--', q.file], {
          cwd: q.project, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024,
        });
        return json(res, 200, { diff: diff || '(no changes)' });
      } catch (err) {
        // Try staged diff
        try {
          const { execFileSync } = require('child_process');
          const diff = execFileSync('git', ['diff', '--cached', '--', q.file], {
            cwd: q.project, encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024,
          });
          return json(res, 200, { diff: diff || '(no changes — may be untracked)' });
        } catch {
          return json(res, 200, { diff: '(unable to get diff)' });
        }
      }
    }

    // Serve static files from webapp/
    if (method === 'GET' && path.startsWith('/static/')) {
      const filePath = pathModule.join(WEBAPP_DIR, path.replace('/static/', ''));
      const resolved = pathModule.resolve(filePath);
      if (!resolved.startsWith(pathModule.resolve(WEBAPP_DIR))) return json(res, 403, { error: 'Forbidden' });
      try {
        const content = fs.readFileSync(resolved);
        const ext = pathModule.extname(resolved);
        const mimeTypes = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': CORS_ORIGIN });
        return res.end(content);
      } catch {
        return json(res, 404, { error: 'Not found' });
      }
    }

    // Serve Mini App static files (/ and /index.html)
    if (method === 'GET' && (path === '/' || path === '/app' || path === '/index.html')) {
      try {
        const html = fs.readFileSync(pathModule.join(WEBAPP_DIR, 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return json(res, 404, { error: 'Dashboard not found' });
      }
    }

    return json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error('[server] Error:', err);
    return json(res, 500, { error: err.message });
  }
}

// Start
function start() {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`[wez-bridge] Server running on http://localhost:${PORT}`);
    console.log(`[wez-bridge] Endpoints:`);
    console.log(`  GET    /health              — health check`);
    console.log(`  GET    /panes               — list WezTerm panes`);
    console.log(`  POST   /panes/:id/send      — send text to a pane`);
    console.log(`  GET    /sessions            — list Claude sessions`);
    console.log(`  POST   /sessions            — spawn new session`);
    console.log(`  POST   /sessions/:id/prompt — inject prompt`);
    console.log(`  GET    /sessions/:id/output — read pane output`);
    console.log(`  POST   /sessions/:id/kill   — kill session`);
    console.log(`  GET    /clawtrol/tasks      — pending ClawTrol tasks`);
    console.log(`  POST   /clawtrol/sync       — auto-spawn for tasks`);
    console.log(`  GET    /api/tasks           — task board`);
    console.log(`  POST   /api/tasks/:id/claim — claim task`);
    console.log(`  POST   /api/tasks/:id/complete — complete task`);
    if (!BOT_TOKEN || ALLOWED_USERS.length === 0) {
      console.log('[wez-bridge] WARNING: No WEBAPP_ALLOWED_USERS set — dashboard auth is disabled (dev mode)');
    }
    startPoller();
    console.log(`[wez-bridge] Polling every ${POLL_INTERVAL}ms for session completion`);
  });

  return server;
}

// Run if called directly
if (require.main === module) {
  start();
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

module.exports = { start, onCompletion, startPoller, stopPoller };
