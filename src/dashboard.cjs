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
const prevStatus = new Map(); // paneId → { status, hash, stableCount }
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

// Simple hash for detecting content changes
function quickHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h;
}

// Stability threshold: content must be unchanged for N polls to be "idle"
const STABILITY_THRESHOLD = 2; // 2 polls × 3s = 6s of no change = idle
// Minimum working duration before emitting completed (avoids false cycles from cursor blink)
const MIN_WORKING_MS = 2000; // must be "working" for at least 2s to count

// Poll loop: detect status transitions via content hashing
// Instead of relying solely on regex patterns (which miss many working states),
// we track whether terminal content is changing. If it's changing → working.
// If stable for STABILITY_THRESHOLD polls → idle.
setInterval(() => {
  try {
    const panes = discovery.discoverPanes().filter(p => p.isClaude);

    for (const pane of panes) {
      let contentHash = 0;
      try {
        const text = wez.getFullText(pane.paneId, 30);
        contentHash = quickHash(text);
      } catch { continue; }

      const prev = prevStatus.get(pane.paneId);

      if (!prev) {
        prevStatus.set(pane.paneId, {
          status: 'idle',
          hash: contentHash,
          stableCount: STABILITY_THRESHOLD, // assume started idle
        });
        continue;
      }

      const contentChanged = contentHash !== prev.hash;
      let newStable = contentChanged ? 0 : prev.stableCount + 1;
      const wasIdle = prev.stableCount >= STABILITY_THRESHOLD;
      const isNowIdle = newStable >= STABILITY_THRESHOLD;

      // Override: permission/continuation prompts are always "idle-like" (waiting for input)
      const isPermission = pane.status === 'permission' || pane.status === 'continuation';

      // Determine effective status
      let effectiveStatus;
      if (isPermission) {
        effectiveStatus = pane.status;
        newStable = STABILITY_THRESHOLD; // treat as stable
      } else if (isNowIdle) {
        effectiveStatus = 'idle';
      } else {
        effectiveStatus = 'working';
      }

      const prevEffective = prev.effectiveStatus || prev.status;

      // Emit events on transitions
      if (prevEffective !== effectiveStatus) {
        if (prevEffective === 'working' && effectiveStatus === 'idle') {
          // Only emit "completed" if the session was working long enough
          const workingStart = prev.workingStartedAt || 0;
          const workingDuration = Date.now() - workingStart;

          if (workingDuration >= MIN_WORKING_MS) {
            let output = '';
            try { output = wez.getFullText(pane.paneId, 40); } catch {}
            const cleanOutput = output.split('\n').filter(l => l.trim()).slice(-15).join('\n');
            emitEvent({
              type: 'completed',
              pane_id: pane.paneId,
              project: pane.projectName,
              output: cleanOutput,
            });

            // Store completion summary for cross-session context
            storeCompletionSummary(pane.paneId, pane.projectName, output);

            // Auto-drain task queue: send next queued task
            setTimeout(() => drainQueue(pane.paneId), 1000);
          }
          // else: too short, was just a flicker — ignore
        } else if (effectiveStatus === 'permission' || effectiveStatus === 'continuation') {
          const lastLines = pane.lastLines.split('\n').filter(l => l.trim()).slice(-8).join('\n');
          emitEvent({
            type: 'permission',
            pane_id: pane.paneId,
            project: pane.projectName,
            output: lastLines,
          });
        } else if (effectiveStatus === 'working') {
          emitEvent({
            type: 'started',
            pane_id: pane.paneId,
            project: pane.projectName,
          });
        }
      }

      prevStatus.set(pane.paneId, {
        status: pane.status,
        effectiveStatus,
        hash: contentHash,
        stableCount: newStable,
        workingStartedAt: effectiveStatus === 'working'
          ? (prev.workingStartedAt || Date.now())
          : 0,
      });
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

// ─── Task Queues ─────────────────────────────────────────────────────────────
// Per-session prompt queues. When a session becomes idle, auto-send next task.

const taskQueues = new Map(); // paneId → [{ text, addedAt, status }]

function enqueueTask(paneId, text) {
  if (!taskQueues.has(paneId)) taskQueues.set(paneId, []);
  const task = { text, addedAt: new Date().toISOString(), status: 'pending' };
  taskQueues.get(paneId).push(task);
  return task;
}

function drainQueue(paneId) {
  const queue = taskQueues.get(paneId);
  if (!queue || queue.length === 0) return null;
  const next = queue.find(t => t.status === 'pending');
  if (!next) return null;

  try {
    wez.sendText(paneId, next.text);
    next.status = 'sent';
    next.sentAt = new Date().toISOString();
    emitEvent({
      type: 'queue_sent',
      pane_id: paneId,
      project: getProjectName(paneId),
      text: next.text.slice(0, 100),
    });
    return next;
  } catch {
    return null;
  }
}

function getProjectName(paneId) {
  try {
    const panes = discovery.discoverPanes();
    const p = panes.find(p => p.paneId === paneId);
    return p ? p.projectName : 'pane ' + paneId;
  } catch { return 'pane ' + paneId; }
}

// Auto-drain: when a session completes, send next queued task
// Hook into the completion event in the poll loop (patched below)

// ─── Cross-Session Context ───────────────────────────────────────────────────
// When a session completes, store a summary. Other sessions can be told about it.

const sessionSummaries = new Map(); // paneId → { project, summary, timestamp }

function storeCompletionSummary(paneId, project, output) {
  // Extract the last meaningful lines as a summary
  const lines = output.split('\n').filter(l => l.trim());
  const summary = lines.slice(-10).join('\n');
  sessionSummaries.set(paneId, {
    project,
    summary,
    timestamp: new Date().toISOString(),
  });
}

function buildContextBrief() {
  // Build a one-paragraph context of what all sessions have been doing
  const entries = [];
  for (const [paneId, info] of sessionSummaries) {
    const age = (Date.now() - new Date(info.timestamp).getTime()) / 60000;
    if (age < 30) { // only include recent (last 30 min)
      entries.push(info.project + ': ' + info.summary.split('\n').slice(-3).join(' ').slice(0, 150));
    }
  }
  return entries.length > 0
    ? 'Context from other sessions:\n' + entries.join('\n')
    : '';
}

// ─── Git Timeline ────────────────────────────────────────────────────────────
// Poll git log from each session's project dir, emit events for new commits.

const { execFileSync } = require('child_process');
const knownCommits = new Set();

function pollGitTimeline() {
  try {
    const panes = discovery.discoverPanes().filter(p => p.isClaude && p.project);
    const seenProjects = new Set();

    for (const pane of panes) {
      const project = pane.project.replace(/^\//, '').replace(/\//g, '\\');
      if (seenProjects.has(project)) continue;
      seenProjects.add(project);

      try {
        const log = execFileSync('git', [
          'log', '--oneline', '--no-walk', '--format=%H|%s|%an|%ai', '-5'
        ], {
          cwd: project,
          encoding: 'utf-8',
          timeout: 5000,
          windowsHide: true,
        }).trim();

        if (!log) continue;
        for (const line of log.split('\n')) {
          const [hash, message, author, date] = line.split('|');
          if (!hash || knownCommits.has(hash)) continue;
          knownCommits.add(hash);

          // Don't emit for initial load (first 50 commits are "known")
          if (knownCommits.size > panes.length * 5) {
            emitEvent({
              type: 'git_commit',
              project: pane.projectName,
              pane_id: pane.paneId,
              hash: hash.slice(0, 8),
              message,
              author,
              date,
            });
          }
        }
      } catch { /* not a git repo or git not available */ }
    }
  } catch { /* ignore */ }
}

// Poll git every 10s
setInterval(pollGitTimeline, 10000);
// Initial load (populate known commits without emitting events)
setTimeout(pollGitTimeline, 2000);

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
        // Normalize path: backslashes → forward slashes (WezTerm needs forward slashes)
        const rawCwd = body.cwd || body.project || process.cwd();
        const cwd = rawCwd.replace(/\\/g, '/');
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
          return { ...p, name, path: realPath };  // always forward slashes
        });
      return json(projects);
    }

    // ─── Task Queue endpoints ───

    // GET /api/sessions/:paneId/queue — get task queue
    if (pathname.match(/^\/api\/sessions\/(\d+)\/queue$/) && req.method === 'GET') {
      const paneId = parseInt(pathname.match(/(\d+)\/queue/)[1], 10);
      const queue = taskQueues.get(paneId) || [];
      return json({ pane_id: paneId, queue });
    }

    // POST /api/sessions/:paneId/queue — add task(s) to queue
    if (pathname.match(/^\/api\/sessions\/(\d+)\/queue$/) && req.method === 'POST') {
      const paneId = parseInt(pathname.match(/(\d+)\/queue/)[1], 10);
      return readBody().then(body => {
        const tasks = Array.isArray(body.tasks) ? body.tasks : body.text ? [body.text] : [];
        const added = tasks.map(t => enqueueTask(paneId, t));
        // If session is idle, drain immediately
        const prev = prevStatus.get(paneId);
        if (prev && prev.effectiveStatus === 'idle') {
          setTimeout(() => drainQueue(paneId), 500);
        }
        json({ ok: true, pane_id: paneId, added: added.length, queue_size: (taskQueues.get(paneId) || []).filter(t => t.status === 'pending').length });
      });
    }

    // DELETE /api/sessions/:paneId/queue — clear queue
    if (pathname.match(/^\/api\/sessions\/(\d+)\/queue$/) && req.method === 'DELETE') {
      const paneId = parseInt(pathname.match(/(\d+)\/queue/)[1], 10);
      taskQueues.delete(paneId);
      return json({ ok: true, pane_id: paneId });
    }

    // POST /api/broadcast — send same prompt to multiple sessions
    if (pathname === '/api/broadcast' && req.method === 'POST') {
      return readBody().then(body => {
        const text = body.text;
        const targets = body.pane_ids || 'all';
        if (!text) return json({ error: 'empty text' }, 400);
        const panes = discovery.discoverPanes().filter(p => p.isClaude);
        const sent = [];
        for (const p of panes) {
          if (targets !== 'all' && !targets.includes(p.paneId)) continue;
          enqueueTask(p.paneId, text);
          const prev = prevStatus.get(p.paneId);
          if (prev && prev.effectiveStatus === 'idle') {
            setTimeout(() => drainQueue(p.paneId), 500);
          }
          sent.push(p.paneId);
        }
        json({ ok: true, sent_to: sent, text: text.slice(0, 80) });
      });
    }

    // ─── Cross-Session Context endpoints ───

    // GET /api/context — get combined context from all recent sessions
    if (pathname === '/api/context' && req.method === 'GET') {
      const brief = buildContextBrief();
      const summaries = {};
      for (const [pid, info] of sessionSummaries) {
        summaries[pid] = info;
      }
      return json({ brief, summaries });
    }

    // POST /api/sessions/:paneId/inject-context — send context brief to a session
    if (pathname.match(/^\/api\/sessions\/(\d+)\/inject-context$/) && req.method === 'POST') {
      const paneId = parseInt(pathname.match(/(\d+)\/inject-context/)[1], 10);
      const brief = buildContextBrief();
      if (!brief) return json({ ok: false, reason: 'no recent context available' });
      wez.sendText(paneId, 'FYI — here is what the other sessions have been doing recently:\n' + brief);
      return json({ ok: true, pane_id: paneId, context_length: brief.length });
    }

    // ─── Git Timeline endpoint ───

    // GET /api/git-timeline — recent commits across all projects
    if (pathname === '/api/git-timeline' && req.method === 'GET') {
      const commits = eventLog.filter(e => e.type === 'git_commit').slice(-20);
      return json(commits);
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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
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
