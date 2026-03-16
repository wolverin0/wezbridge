#!/usr/bin/env node
/**
 * WezBridge Local Dashboard — standalone web UI for managing all Claude sessions.
 *
 * No Telegram dependency. Just pane-discovery + wezterm CLI.
 *
 * Usage:
 *   node src/dashboard.cjs              # Start on port 4200
 *   node src/dashboard.cjs --port 3000  # Custom port
 *   node src/dashboard.cjs --open       # Auto-open browser
 *
 * Features:
 *   - See all Claude sessions across WezTerm panes (auto-refresh)
 *   - Read terminal output from any session
 *   - Send prompts to idle sessions
 *   - Send keys (y/n/enter/ctrl+c) for permission prompts
 *   - Spawn new Claude sessions for any project
 *   - Kill sessions
 *   - Project scanner: discovers all projects on disk
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const discovery = require('./pane-discovery.cjs');
const wez = require('./wezterm.cjs');
const projectScanner = require('./project-scanner.cjs');

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let PORT = 4200;
let autoOpen = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) PORT = parseInt(args[++i], 10);
  if (args[i] === '--open') autoOpen = true;
}

// ─── Live Event System ───────────────────────────────────────────────────────
// Polls panes and emits SSE events when status changes (working→idle, etc.)

const sseClients = new Set();
const prevStatus = new Map(); // paneId → { status, lastLine }
const eventLog = [];          // last 50 events for new SSE clients

function emitEvent(event) {
  event.timestamp = new Date().toISOString();
  eventLog.push(event);
  if (eventLog.length > 50) eventLog.shift();

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
}

// Poll loop: detect status transitions
setInterval(() => {
  try {
    const panes = discovery.discoverPanes().filter(p => p.isClaude);

    for (const pane of panes) {
      const prev = prevStatus.get(pane.paneId);
      const prevSt = prev?.status;
      const currSt = pane.status;

      if (!prev) {
        // First time seeing this pane
        prevStatus.set(pane.paneId, { status: currSt });
        continue;
      }

      // Detect transitions
      if (prevSt !== currSt) {
        const lastLines = pane.lastLines.split('\n').filter(l => l.trim()).slice(-8).join('\n');

        if (prevSt === 'working' && currSt === 'idle') {
          // Task completed!
          let output = '';
          try { output = wez.getFullText(pane.paneId, 40); } catch {}
          emitEvent({
            type: 'completed',
            pane_id: pane.paneId,
            project: pane.projectName,
            output: output.split('\n').filter(l => l.trim()).slice(-15).join('\n'),
          });
        } else if (currSt === 'permission') {
          emitEvent({
            type: 'permission',
            pane_id: pane.paneId,
            project: pane.projectName,
            output: lastLines,
          });
        } else if (prevSt === 'idle' && currSt === 'working') {
          emitEvent({
            type: 'started',
            pane_id: pane.paneId,
            project: pane.projectName,
          });
        } else {
          emitEvent({
            type: 'status_change',
            pane_id: pane.paneId,
            project: pane.projectName,
            from: prevSt,
            to: currSt,
          });
        }

        prevStatus.set(pane.paneId, { status: currSt });
      }
    }

    // Detect removed panes
    for (const [paneId] of prevStatus) {
      if (!panes.find(p => p.paneId === paneId)) {
        emitEvent({ type: 'removed', pane_id: paneId });
        prevStatus.delete(paneId);
      }
    }
  } catch { /* ignore poll errors */ }
}, 3000);

// ─── API Routes ──────────────────────────────────────────────────────────────

function handleApi(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSON helper
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Read POST body
  const readBody = () => new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });

  try {
    // GET /api/sessions — all panes with Claude detection
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const panes = discovery.discoverPanes();
      const sessions = panes.map(p => ({
        pane_id: p.paneId,
        is_claude: p.isClaude,
        status: p.status,
        project: p.project,
        project_name: p.projectName,
        title: p.title,
        workspace: p.workspace,
        confidence: p.confidence,
        last_line: p.lastLines.split('\n').filter(l => l.trim()).slice(-3).join('\n'),
      }));
      return json({ total: sessions.length, sessions });
    }

    // GET /api/sessions/:paneId/output — read terminal output
    if (pathname.match(/^\/api\/sessions\/(\d+)\/output$/) && req.method === 'GET') {
      const paneId = parseInt(pathname.match(/(\d+)\/output/)[1], 10);
      const lines = parseInt(url.searchParams.get('lines') || '100', 10);
      const text = wez.getFullText(paneId, Math.min(lines, 500));
      return json({ pane_id: paneId, output: text });
    }

    // POST /api/sessions/:paneId/prompt — send text to pane
    if (pathname.match(/^\/api\/sessions\/(\d+)\/prompt$/) && req.method === 'POST') {
      const paneId = parseInt(pathname.match(/(\d+)\/prompt/)[1], 10);
      return readBody().then(body => {
        if (!body.text?.trim()) return json({ error: 'empty text' }, 400);
        wez.sendText(paneId, body.text);
        json({ ok: true, pane_id: paneId });
      });
    }

    // POST /api/sessions/:paneId/key — send special key
    if (pathname.match(/^\/api\/sessions\/(\d+)\/key$/) && req.method === 'POST') {
      const paneId = parseInt(pathname.match(/(\d+)\/key/)[1], 10);
      return readBody().then(body => {
        const key = (body.key || '').toLowerCase();
        switch (key) {
          case 'enter': wez.sendText(paneId, ''); break;
          case 'ctrl+c': case 'ctrl-c': wez.sendTextNoEnter(paneId, '\x03'); break;
          case 'y': case 'n': wez.sendTextNoEnter(paneId, key); break;
          default: wez.sendTextNoEnter(paneId, body.key || ''); break;
        }
        json({ ok: true, pane_id: paneId, key });
      });
    }

    // POST /api/sessions/:paneId/kill — kill pane
    if (pathname.match(/^\/api\/sessions\/(\d+)\/kill$/) && req.method === 'POST') {
      const paneId = parseInt(pathname.match(/(\d+)\/kill/)[1], 10);
      try { wez.sendTextNoEnter(paneId, '\x03'); } catch {}
      wez.killPane(paneId);
      return json({ ok: true, killed: paneId });
    }

    // POST /api/spawn — spawn new Claude session
    if (pathname === '/api/spawn' && req.method === 'POST') {
      return readBody().then(body => {
        const cwd = body.cwd || body.project || process.cwd();
        const yolo = body.yolo || body.dangerously_skip_permissions || false;

        const newPaneId = wez.spawnPane({ cwd });

        // Give shell time to start, then type `claude --continue`
        setTimeout(() => {
          const resume = body.continue !== false; // default: resume last session
          let cmd = 'claude';
          if (resume) cmd += ' --continue';
          if (yolo) cmd += ' --dangerously-skip-permissions';
          wez.sendText(newPaneId, cmd);

          // If initial prompt provided, wait for Claude to boot then send it
          if (body.prompt) {
            setTimeout(() => {
              wez.sendText(newPaneId, body.prompt);
            }, 8000);
          }
        }, 2000);

        json({ ok: true, pane_id: newPaneId, cwd });
      });
    }

    // GET /api/projects — scan for projects on disk
    if (pathname === '/api/projects' && req.method === 'GET') {
      const raw = projectScanner.scanAll();
      // Clean up: use real path to derive friendly name, filter out non-project dirs
      const projects = raw
        .filter(p => p.path && !p.path.includes('.claude'))  // skip .claude internal dirs
        .map(p => {
          const realPath = (p.projectRoot || p.path || '').replace(/\\/g, '/').replace(/\/$/, '');
          const name = realPath.split('/').filter(Boolean).pop() || p.name;
          return { ...p, name, path: p.projectRoot || p.path };
        });
      return json(projects);
    }

    // GET /api/events — SSE stream for live events
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // Send recent events as catchup
      for (const event of eventLog) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return; // Keep connection open
    }

    // GET /api/summary — quick overview
    if (pathname === '/api/summary' && req.method === 'GET') {
      const summary = discovery.getSummary();
      return json(summary);
    }

    // Fallback: serve static dashboard
    return serveStatic(req, res, url);

  } catch (err) {
    json({ error: err.message }, 500);
  }
}

// ─── Static File Server ──────────────────────────────────────────────────────

const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');

function serveStatic(req, res, url) {
  const pathname = url.pathname === '/' ? '/dashboard.html' : url.pathname;

  // Only serve dashboard.html
  if (pathname === '/dashboard.html') {
    if (fs.existsSync(DASHBOARD_HTML)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(DASHBOARD_HTML, 'utf-8'));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

// ─── Start Server ────────────────────────────────────────────────────────────

const server = http.createServer(handleApi);

server.listen(PORT, () => {
  const c = { reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', dim: '\x1b[2m' };
  console.log(`\n${c.bold}${c.cyan}WezBridge Dashboard${c.reset}`);
  console.log(`${c.green}http://localhost:${PORT}${c.reset}\n`);
  console.log(`${c.dim}API endpoints:${c.reset}`);
  console.log(`  GET  /api/sessions             — list all panes`);
  console.log(`  GET  /api/sessions/:id/output   — read terminal output`);
  console.log(`  POST /api/sessions/:id/prompt   — send prompt`);
  console.log(`  POST /api/sessions/:id/key      — send key (y/n/enter/ctrl+c)`);
  console.log(`  POST /api/sessions/:id/kill     — kill pane`);
  console.log(`  POST /api/spawn                 — spawn new Claude session`);
  console.log(`  GET  /api/projects              — scan projects on disk`);
  console.log(`  GET  /api/summary               — quick overview\n`);

  if (autoOpen) {
    try {
      const { exec } = require('child_process');
      const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${cmd} http://localhost:${PORT}`);
    } catch {}
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Try --port <number>`);
    process.exit(1);
  }
  throw err;
});
