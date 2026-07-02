// SEC-2026-07-02: the daemon must bind loopback by default and must refuse to
// start on a non-loopback bind without an API token. Regression cover for the
// LAN-exposure finding in artifacts/2026-07-02-wezbridge-review.html.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const net = require('node:net');

const ENTRY = path.join(__dirname, '..', 'src', 'dashboard-server.cjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function bootServer(env) {
  return spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function get(host, port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path: pathname }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(host, port, maxMs = 6000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { const r = await get(host, port, '/api/panes'); if (r.status === 200) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// ── Pure helper unit test (no process spawn) ──────────────────────────────
test('isLoopbackBind classifies loopback vs LAN hosts', () => {
  const { isLoopbackBind, BIND_HOST } = require('../src/dashboard-server-routes.cjs');
  assert.equal(isLoopbackBind('127.0.0.1'), true);
  assert.equal(isLoopbackBind('::1'), true);
  assert.equal(isLoopbackBind('localhost'), true);
  assert.equal(isLoopbackBind('0.0.0.0'), false);
  assert.equal(isLoopbackBind('192.168.1.50'), false);
  // Default bind is loopback when WEZBRIDGE_BIND is unset in this test env.
  assert.equal(BIND_HOST, '127.0.0.1');
});

// ── Default bind is loopback: reachable on 127.0.0.1 ──────────────────────
test('daemon binds loopback by default (reachable on 127.0.0.1)', async () => {
  const port = await freePort();
  const srv = bootServer({ DASHBOARD_PORT: String(port) });
  try {
    const up = await waitFor('127.0.0.1', port);
    assert.ok(up, 'server should be reachable on 127.0.0.1');
  } finally {
    srv.kill('SIGKILL');
  }
});

// ── Non-loopback bind without token → refuses to start ────────────────────
test('daemon aborts when WEZBRIDGE_BIND is non-loopback and no token set', async () => {
  const port = await freePort();
  const srv = bootServer({ DASHBOARD_PORT: String(port), WEZBRIDGE_BIND: '0.0.0.0', WEZBRIDGE_API_TOKEN: '' });
  let stderr = '';
  srv.stderr.on('data', (c) => (stderr += c));
  const exitCode = await new Promise((resolve) => srv.on('exit', resolve));
  assert.equal(exitCode, 1, 'should exit(1) on wide bind without token');
  assert.match(stderr, /WEZBRIDGE_BIND=0\.0\.0\.0.*token|token.*WEZBRIDGE_BIND=0\.0\.0\.0/is);
});

// ── Non-loopback bind WITH token → does NOT abort ─────────────────────────
// (With a token set, read routes require auth, so we assert the process stays
// alive and never prints the FATAL bind-guard line — not an unauthenticated 200.)
test('daemon does not abort on non-loopback bind when a token is provided', async () => {
  const port = await freePort();
  const srv = bootServer({ DASHBOARD_PORT: String(port), WEZBRIDGE_BIND: '0.0.0.0', WEZBRIDGE_API_TOKEN: 'secret-xyz' });
  let stderr = '';
  srv.stderr.on('data', (c) => (stderr += c));
  let exited = false;
  srv.on('exit', () => { exited = true; });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(exited, false, 'server should keep running (token satisfies the bind guard)');
    assert.doesNotMatch(stderr, /FATAL/, 'no FATAL abort line when token is present');
  } finally {
    srv.kill('SIGKILL');
  }
});
