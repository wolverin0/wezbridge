// Cover the bridge_health tool and spawn_session model validation added in the
// 2026-07-02 review remediation. Uses the same JSON-RPC-over-stdio harness as
// the persona test: boot mcp-server, send one request, read one response line.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function callTool(name, args, env = {}) {
  return new Promise((resolve, reject) => {
    const entry = path.join(__dirname, '..', 'src', 'mcp-server.cjs');
    const child = spawn(process.execPath, [entry], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, 8000);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      const line = stdout.slice(0, nl).trim();
      child.stdin.end();
      child.kill('SIGTERM');
      try { resolve(JSON.parse(line)); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}; stdout=${stdout}; stderr=${stderr}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

test('bridge_health returns a structured health blob', async () => {
  // Point the daemon probe at a dead port so the test is deterministic
  // regardless of whether a real :4200 daemon is running.
  const res = await callTool('bridge_health', {}, { DASHBOARD_PORT: '4288' });
  assert.equal(res.jsonrpc, '2.0');
  assert.ok(res.result && !res.result.isError, 'health call should not be an error');
  const health = JSON.parse(res.result.content[0].text);
  assert.ok('wezbridge_version' in health, 'has version');
  assert.ok(health.wezterm && typeof health.wezterm.reachable === 'boolean', 'wezterm.reachable is boolean');
  assert.ok(health.daemon && typeof health.daemon.up === 'boolean', 'daemon.up is boolean');
  assert.equal(health.daemon.up, false, 'daemon on the dead port 4288 must report down');
  assert.ok(typeof health.session_snapshot_armed === 'boolean', 'snapshot flag is boolean');
});

test('bridge_health reports session_snapshot disabled when WEZBRIDGE_SESSION_SNAPSHOT=0', async () => {
  const res = await callTool('bridge_health', {}, { DASHBOARD_PORT: '4288', WEZBRIDGE_SESSION_SNAPSHOT: '0' });
  const health = JSON.parse(res.result.content[0].text);
  assert.equal(health.session_snapshot_armed, false);
});

test('spawn_session rejects an invalid model string', async () => {
  const res = await callTool('spawn_session', { cwd: path.join(__dirname, '..'), model: 'evil; rm -rf /' });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /invalid model/i);
});
