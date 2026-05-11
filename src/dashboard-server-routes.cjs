#!/usr/bin/env node
'use strict';

require('./guard-bootstrap.cjs');

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { createHandlers } = require('./handlers/index.cjs');

const PORT = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
const STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'dist');

function getCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  return /^http:\/\/localhost(?::\d+)?$/i.test(origin) ? origin : null;
}

function corsHeaders(res) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (res._corsOrigin) headers['Access-Control-Allow-Origin'] = res._corsOrigin;
  return headers;
}

function hasValidBearerToken(req) {
  const token = process.env.WEZBRIDGE_API_TOKEN;
  // AXIS-4: fail-closed — deny-all when token is unset (see startup abort in production)
  if (!token) return false;
  const expected = `Bearer ${token}`;
  const actual = req.headers.authorization || '';
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    ...corsHeaders(res),
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, err) {
  sendJson(res, err.statusCode || 500, { error: err.message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let rejected = false;
    req.on('data', chunk => {
      buf += chunk;
      if (!rejected && buf.length > 1e6) {
        rejected = true;
        const err = Object.assign(new Error('Request body too large'), { statusCode: 413 });
        reject(err);
        req.destroy(err);
      }
    });
    req.on('end', () => {
      if (rejected) return;
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function log(msg) { process.stderr.write(`[dashboard] ${new Date().toISOString()} ${msg}\n`); }

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


const handlers = createHandlers({ sendJson, sendError, parseBody, log, corsHeaders });

// --- server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';
  res._corsOrigin = getCorsOrigin(req);

  if (method === 'OPTIONS') {
    if (req.headers.origin && !res._corsOrigin) {
      return sendJson(res, 403, { error: 'origin not allowed' });
    }
    res.writeHead(204, {
      ...corsHeaders(res),
    });
    return res.end();
  }

  if (!hasValidBearerToken(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  // CSRF defense: reject POSTs with a mismatched Origin. Only state-changing
  // methods are gated — GETs on the API are idempotent and read-only.
  if (method === 'POST' && !isOriginAllowed(req)) {
    log(`CSRF: rejected POST ${pathname} from Origin: ${req.headers.origin}`);
    return sendJson(res, 403, { error: 'origin not allowed' });
  }

  // API routes
  if (pathname === '/api/panes' && method === 'GET') return handlers.handleGetPanes(req, res);
  if (pathname === '/api/sessions' && method === 'GET') return handlers.handleGetSessions(req, res);
  if (pathname === '/api/projects' && method === 'GET') return handlers.handleGetProjects(req, res);
  if (pathname === '/api/browse' && method === 'GET') return handlers.handleGetBrowse(req, res, url.searchParams.get('path'));
  if (pathname === '/api/broadcast' && method === 'POST') return handlers.handlePostBroadcast(req, res);
  if (pathname === '/api/a2a/pending' && method === 'GET') return handlers.handleGetA2APending(req, res);
  if (pathname === '/api/grades' && method === 'GET') return handlers.handleGetGrades(req, res);
  if (pathname === '/api/grade' && method === 'POST') return handlers.handlePostGrade(req, res);
  if (pathname === '/api/a2a/handoff' && method === 'POST') return handlers.handlePostA2AHandoff(req, res);
  if (pathname === '/api/handoffs' && method === 'GET') return handlers.handleGetHandoffs(req, res, url.searchParams.get('pane'));
  if (pathname === '/api/routines/fire' && method === 'POST') return handlers.handlePostRoutinesFire(req, res);
  if (pathname === '/api/personas' && method === 'GET') return handlers.handleGetPersonas(req, res);
  if (pathname === '/api/worktrees' && method === 'GET') return handlers.handleGetWorktrees(req, res);
  if (pathname === '/api/agency/prds' && method === 'GET') return handlers.handleGetPRDs(req, res);
  if (pathname === '/api/agency/teams' && method === 'GET') return handlers.handleGetTeams(req, res);
  if (pathname === '/api/agency/bootstrap' && method === 'POST') return handlers.handlePostBootstrap(req, res);
  if (pathname === '/api/auto-handoff/pending' && method === 'GET') return handlers.handleGetAutoHandoffPending(req, res);
  if (pathname === '/api/auto-handoff/suppress' && method === 'POST') return handlers.handlePostAutoHandoffSuppress(req, res);
  if (pathname === '/api/tasks' && method === 'GET') return handlers.handleGetTasks(res);
  if (pathname === '/api/events' && method === 'GET') return handlers.handleEvents(req, res);
  if (pathname === '/api/spawn' && method === 'POST') return handlers.handlePostSpawn(req, res);

  // Worktree action routes: /api/worktrees/:paneId/cleanup and /api/worktrees/:paneId/merge
  const wtMatch = pathname.match(/^\/api\/worktrees\/(\d+)\/(cleanup|merge)$/);
  if (wtMatch && method === 'POST') {
    const wtPaneId = parseInt(wtMatch[1], 10);
    if (wtMatch[2] === 'cleanup') return handlers.handlePostWorktreeCleanup(req, res, wtPaneId);
    if (wtMatch[2] === 'merge') return handlers.handlePostWorktreeMerge(req, res, wtPaneId);
  }

  const paneMatch = pathname.match(/^\/api\/(panes|sessions)\/(\d+)(\/(output|prompt|key|kill|auto-handoff))?$/);
  if (paneMatch) {
    const paneId = parseInt(paneMatch[2], 10);
    const sub = paneMatch[4];
    if (sub === 'output' && method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      return handlers.handleGetPaneOutput(res, paneId, lines);
    }
    if (sub === 'prompt' && method === 'POST') return handlers.handlePostPrompt(req, res, paneId);
    if (sub === 'key' && method === 'POST')    return handlers.handlePostKey(req, res, paneId);
    if (sub === 'kill' && method === 'POST')   return handlers.handlePostKill(res, paneId);
    if (sub === 'auto-handoff' && method === 'POST') return handlers.handlePostAutoHandoff(req, res, paneId);
  }

  // Static fallthrough (assets from dashboard/dist, if built)
  if (method === 'GET') return serveStatic(res, pathname);

  sendJson(res, 404, { error: 'not found' });
});


function startServer() {
  // AXIS-4: abort startup in production if WEZBRIDGE_API_TOKEN is unset.
  // hasValidBearerToken already returns false when token is absent, but
  // an explicit startup abort prevents silent misconfiguration in production.
  if (process.env.NODE_ENV === 'production' && !process.env.WEZBRIDGE_API_TOKEN) {
    process.stderr.write('[dashboard] FATAL: WEZBRIDGE_API_TOKEN must be set in production. Aborting.\n');
    process.exit(1);
  }
  log(`allowed origins (CSRF): ${Array.from(ALLOWED_ORIGINS).join(', ')}`);
  handlers.startAutoHandoffMonitor();
  server.listen(PORT, () => {
    log(`theorchestra dashboard server listening on http://localhost:${PORT}`);
    log('API: /api/panes, /api/tasks, /api/events (SSE)');
    log(`Static: ${fs.existsSync(STATIC_DIR) ? STATIC_DIR : '(dashboard not built yet)'}`);
    handlers.startBackgroundServices();
  });
  process.on('SIGTERM', () => { log('SIGTERM'); server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { log('SIGINT'); server.close(() => process.exit(0)); });
  return server;
}

module.exports = { startServer, server };
