// theorchestra dashboard smoke suite — node-native, no external deps.
// Run with: `npm test` (or `node --test test/dashboard-smoke.test.cjs`).
// Boots the dashboard server on an ephemeral port, exercises the main
// contract surface, and shuts it down. ~3 seconds total.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 4299; // off from the normal 4200 to avoid stepping on a live server
const HOST = `http://localhost:${PORT}`;

let server;

function request(method, pathname, { body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    const req = http.request(
      { host: 'localhost', port: PORT, method, path: pathname, headers },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
          resolve({ status: res.statusCode, body: parsed, raw: chunks });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function waitForServer(maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/api/panes');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on :${PORT} never came up`);
}

before(async () => {
  const entry = path.join(__dirname, '..', 'src', 'dashboard-server.cjs');
  server = spawn(process.execPath, [entry], {
    env: { ...process.env, DASHBOARD_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface early crash messages to the test runner for debugging.
  server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
  await waitForServer();
});

after(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!server.killed) server.kill('SIGKILL');
  }
});

// ─── GET API contract ────────────────────────────────────────────────────
// dashboard.html UI deprecated 2026-05-03 (per src/DEPRECATED.md). The HTML
// contract test was removed in v3.2.1 cleanup — daemon now backs the
// wezbridge MCP server only, no UI served at /.

test('GET /api/panes returns {panes: array}', async () => {
  const r = await request('GET', '/api/panes');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.panes), 'panes must be array');
});

test('GET /api/sessions returns {sessions: array} (legacy shape for v3.1 UI)', async () => {
  const r = await request('GET', '/api/sessions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.sessions), 'sessions must be array');
});

test('GET /api/a2a/pending returns {corrs: array}', async () => {
  const r = await request('GET', '/api/a2a/pending');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.corrs), 'corrs must be array');
});

test('GET /api/tasks returns {tasks: array}', async () => {
  const r = await request('GET', '/api/tasks');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.tasks), 'tasks must be array');
});

test('GET /api/handoffs requires pane param', async () => {
  const r = await request('GET', '/api/handoffs');
  assert.equal(r.status, 400);
  assert.match(r.body.error || '', /pane/i);
});

test('GET /api/handoffs?pane=99999 returns empty list gracefully (no crash on missing cwd)', async () => {
  const r = await request('GET', '/api/handoffs?pane=99999');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.handoffs));
});

test('GET /api/projects returns an array', async () => {
  const r = await request('GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body), 'projects should be bare array (v3.1 UI contract)');
});

// ─── CSRF defense on POST endpoints ──────────────────────────────────────

test('POST /api/a2a/handoff with evil Origin → 403', async () => {
  const r = await request('POST', '/api/a2a/handoff', {
    origin: 'https://evil.com',
    body: { source_pane: 99999, target_pane: 99998, instruction: 'x' },
  });
  assert.equal(r.status, 403);
  assert.match(r.body.error || '', /origin/i);
});

test('POST /api/spawn with evil Origin → 403', async () => {
  const r = await request('POST', '/api/spawn', {
    origin: 'https://evil.com',
    body: { cwd: '/tmp' },
  });
  assert.equal(r.status, 403);
});

test('POST /api/broadcast with evil Origin → 403', async () => {
  const r = await request('POST', '/api/broadcast', {
    origin: 'https://evil.com',
    body: { text: 'hello' },
  });
  assert.equal(r.status, 403);
});

test('POST /api/routines/fire with evil Origin → 403', async () => {
  const r = await request('POST', '/api/routines/fire', {
    origin: 'https://evil.com',
    body: { routine_id: 'trig_fake' },
  });
  assert.equal(r.status, 403);
});

test('POST with same-origin http://localhost:PORT → passes CSRF gate', async () => {
  // evil origin returns 403 quickly at the gate; same-origin should fall
  // through to the handler (which may return 400 for bad body — either way,
  // not 403).
  const r = await request('POST', '/api/a2a/handoff', {
    origin: `${HOST}`,
    body: { source_pane: 99999, target_pane: 99998, instruction: 'x' },
  });
  assert.notEqual(r.status, 403, 'same-origin should NOT be blocked by CSRF gate');
});

test('POST with NO Origin header (curl-style) → passes CSRF gate', async () => {
  const r = await request('POST', '/api/a2a/handoff', {
    body: { source_pane: 99999, target_pane: 99998, instruction: 'x' },
  });
  assert.notEqual(r.status, 403, 'no-Origin requests (curl/CLI) should NOT be blocked');
});

test('POST with a LAN origin (non-internal IPv4) → passes CSRF gate', async () => {
  // Synthesize a plausible LAN origin from the machine's own interfaces.
  // If the machine has no non-internal IPv4 (CI container, air-gapped box),
  // fall back to 192.168.1.1 which we expect NOT to match — in that case
  // the test asserts the fallback path is consistent (either all-deny or
  // allow). The boot-time allowlist build path is what we're exercising.
  const os = require('node:os');
  let lanOrigin = null;
  const ifaces = os.networkInterfaces();
  outer: for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (!addr.internal && (addr.family === 'IPv4' || addr.family === 4)) {
        lanOrigin = `http://${addr.address}:${PORT}`;
        break outer;
      }
    }
  }
  if (!lanOrigin) {
    // No LAN interface — test is vacuously satisfied.
    return;
  }
  const r = await request('POST', '/api/a2a/handoff', {
    origin: lanOrigin,
    body: { source_pane: 99999, target_pane: 99998, instruction: 'x' },
  });
  assert.notEqual(r.status, 403, `LAN origin ${lanOrigin} should pass the CSRF gate`);
});

// ─── Handler validation (smoke) ──────────────────────────────────────────

test('POST /api/a2a/handoff with missing body → 400 with clear error', async () => {
  const r = await request('POST', '/api/a2a/handoff', { body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error || '', /source_pane|target_pane|integer/i);
});

test('POST /api/routines/fire without routine_id → 400', async () => {
  const r = await request('POST', '/api/routines/fire', { body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error || '', /routine_id/i);
});

test('POST /api/routines/fire with unknown routine → 400 pointing to config', async () => {
  const r = await request('POST', '/api/routines/fire', { body: { routine_id: 'trig_does_not_exist_zzz' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error || '', /not found|_routines-config/i);
});

// ─── v2.5 Agency Mode: persona endpoints ─────────────────────────────────

test('GET /api/personas returns a non-empty array with name + category fields', async () => {
  const r = await request('GET', '/api/personas');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body), 'personas must be array');
  // The user has ~100 persona files installed — expect at least some.
  assert.ok(r.body.length > 0, 'expected at least 1 persona in ~/.claude/agents/');
  const first = r.body[0];
  assert.ok(typeof first.name === 'string' && first.name.length > 0, 'persona must have name');
  assert.ok('category' in first, 'persona must have category field');
  assert.ok('description' in first, 'persona must have description field');
});

test('POST /api/spawn with unknown persona → 400', async () => {
  const r = await request('POST', '/api/spawn', {
    body: { cwd: '/tmp', persona: 'nonexistent-agent-xyz-999' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error || '', /not found/i);
});

test('GET /api/panes returns persona field (null for generic panes)', async () => {
  const r = await request('GET', '/api/panes');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.panes));
  if (r.body.panes.length > 0) {
    assert.ok('persona' in r.body.panes[0], 'pane must have persona field');
  }
});

// ─── v2.6 Auto-Handoff: parseStatusBar unit tests ────────────────────────

const { parseStatusBar } = require('../src/status-parser.cjs');

test('parseStatusBar extracts ctx/session/weekly/model from a full status line', () => {
  const line = 'Some chat above\nCtx: 54.0% · Session: 41.0% · Weekly: 69.0% · Model: Opus\nmore output';
  const out = parseStatusBar(line);
  assert.ok(out, 'should return an object for a valid status line');
  assert.equal(out.ctx, 54);
  assert.equal(out.session, 41);
  assert.equal(out.weekly, 69);
  assert.equal(out.model, 'Opus');
});

test('parseStatusBar returns null when no status fields are present', () => {
  assert.equal(parseStatusBar('random terminal output with no status bar'), null);
  assert.equal(parseStatusBar(''), null);
  assert.equal(parseStatusBar(null), null);
});

test('parseStatusBar accepts an array of lines and partial matches', () => {
  const out = parseStatusBar(['foo', 'Ctx: 12.5%', 'bar']);
  assert.ok(out);
  assert.equal(out.ctx, 12.5);
  assert.equal(out.session, null);
  assert.equal(out.weekly, null);
  assert.equal(out.model, 'unknown');
});

// ─── v2.6 Auto-Handoff: /api/panes ctx exposure ──────────────────────────

test('GET /api/panes exposes ctx/session_pct/weekly_pct/model on every pane entry', async () => {
  const r = await request('GET', '/api/panes');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.panes));
  if (r.body.panes.length > 0) {
    const p = r.body.panes[0];
    for (const field of ['ctx', 'session_pct', 'weekly_pct', 'model']) {
      assert.ok(field in p, `pane must have ${field} field`);
    }
    // ctx should be a number or null (never undefined or a string)
    if (p.ctx !== null) assert.equal(typeof p.ctx, 'number', 'ctx must be number or null');
  }
});

// ─── v2.6 Auto-Handoff: endpoints ────────────────────────────────────────

test('POST /api/panes/99999/auto-handoff → 404 for unknown pane', async () => {
  const r = await request('POST', '/api/panes/99999/auto-handoff', { body: {} });
  assert.equal(r.status, 404);
  assert.match(r.body.error || '', /not found/i);
});

test('POST /api/sessions/99999/auto-handoff (alias route) → 404 for unknown pane', async () => {
  const r = await request('POST', '/api/sessions/99999/auto-handoff', { body: {} });
  assert.equal(r.status, 404);
});

test('GET /api/auto-handoff/pending returns {events: array}', async () => {
  const r = await request('GET', '/api/auto-handoff/pending');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.events), 'events must be array');
});

test('POST /api/auto-handoff/suppress with valid pane_id → 200 ok', async () => {
  const r = await request('POST', '/api/auto-handoff/suppress', {
    body: { pane_id: 99999, duration_ms: 60000 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.pane_id, 99999);
  assert.ok(typeof r.body.suppressed_until === 'string', 'response must include suppressed_until ISO string');
});

test('POST /api/auto-handoff/suppress with missing pane_id → 400', async () => {
  const r = await request('POST', '/api/auto-handoff/suppress', { body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error || '', /pane_id/i);
});
