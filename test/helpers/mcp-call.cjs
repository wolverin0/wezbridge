'use strict';
/**
 * mcp-call.cjs — shared helper to spawn a REAL src/mcp-server.cjs child
 * process, send ONE tools/call over stdio, and resolve with the response.
 *
 * Extracted from test/a2a-send-spills-before-refusing.test.cjs and
 * test/mcp-server-v35-tools.test.cjs (T-0400) — both files had their own
 * copy of this spawn-and-JSON-RPC boilerplate. `callTool` matches the
 * mcp-server-v35-tools shape (resolves the full JSON-RPC response, defaults
 * WEZTERM_PANE to '1'); `callA2aSend` matches the a2a-send-spills shape
 * (resolves only `.result`, defaults WEZTERM_PANE to '' — no self-identity).
 * Both are kept as distinct exports rather than unified, on purpose: unifying
 * their env defaults would change either file's existing behavior, and this
 * extraction must not (see T-0400 brief AC1).
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', '..', 'src', 'mcp-server.cjs');
const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * Spawn mcp-server.cjs, send `tools/call` for `name`, and resolve with the
 * FULL JSON-RPC response object ({ jsonrpc, id, result }).
 * Default env: WEZTERM_PANE='1' (overridable via `env`, or by process.env —
 * matches the original mcp-server-v35-tools merge order exactly).
 */
function callTool(name, args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: REPO_ROOT,
      env: { WEZTERM_PANE: '1', ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, timeoutMs);
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

/**
 * a2a_send convenience wrapper matching the original
 * a2a-send-spills-before-refusing helper: WEZTERM_PANE defaults to '' (no
 * from-pane self-identity — callers pass from_pane explicitly), and resolves
 * to just `.result` (not the full JSON-RPC envelope).
 */
function callA2aSend(args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, WEZTERM_PANE: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      try { resolve(JSON.parse(stdout.slice(0, nl).trim()).result); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}; stdout=${stdout}; stderr=${stderr}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a2a_send', arguments: args } }) + '\n');
  });
}

/** Text of a FULL JSON-RPC response's first content block (pairs with callTool). */
function resultText(res) {
  return res.result.content[0].text;
}

/** Joined text of a bare `.result` object's content blocks (pairs with callA2aSend). */
function textOf(result) {
  return result.content.map((block) => block.text || '').join('\n');
}

/**
 * A throwaway WEZBRIDGE_INTEL_DIR, cleaned up after the test. `prefix` keeps
 * dirs identifiable under a shared os.tmpdir() when several suites run
 * concurrently. The dirname(dir) === os.tmpdir() assert is a deliberate
 * belt-and-suspenders check before the recursive rmSync (carried over from
 * the original a2a-send-spills-before-refusing fixture()).
 */
function fixture(t, prefix = 'mcp-call-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

module.exports = { callTool, callA2aSend, resultText, textOf, fixture, ENTRY };
