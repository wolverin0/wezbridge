// v3.5.0 tool surface: a2a_send validation, spawn_session agent/fresh-default
// validation, and (gated) a LIVE end-to-end pass against a real WezTerm pane.
//
// The live block only runs with WEZBRIDGE_E2E=1 — it spawns a throwaway shell
// pane, proves verified prompt submission actually executes a command, walks
// the read_output cursor delta, sends an A2A envelope, and kills the pane.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.cjs');
const E2E = process.env.WEZBRIDGE_E2E === '1';

// Generous per-call budget: each call boots a fresh mcp-server (socket
// discovery: tasklist + probe, version probe) and competes with the live
// daemon's pane polling — worst-case spawn under contention is ~25s
// (10s timeout + 10s retry + shell-init sleep).
function callTool(name, args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
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

function resultText(res) {
  return res.result.content[0].text;
}

// ─── a2a_send validation (no wezterm touched — fail-fast paths) ────────────

test('a2a_send rejects missing to_pane', async () => {
  const res = await callTool('a2a_send', { body: 'hi' });
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /to_pane/i);
});

test('a2a_send rejects invalid type', async () => {
  const res = await callTool('a2a_send', { to_pane: 99999, body: 'hi', type: 'shout' });
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /invalid type/i);
});

test('a2a_send rejects malformed corr', async () => {
  const res = await callTool('a2a_send', { to_pane: 99999, body: 'hi', corr: 'bad corr with spaces!!' });
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /corr/i);
});

test('a2a_send requires from_pane when WEZTERM_PANE is unset', async () => {
  const res = await callTool('a2a_send', { to_pane: 99999, body: 'hi' }, { WEZTERM_PANE: '' });
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /from_pane|WEZTERM_PANE/i);
});

// ─── spawn_session validation ───────────────────────────────────────────────

test('spawn_session rejects invalid agent', async () => {
  const res = await callTool('spawn_session', { agent: 'gemini' });
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /invalid agent/i);
});

test('spawn_session rejects claude-only flags on non-claude agents', async () => {
  const res = await callTool('spawn_session', { agent: 'codex', persona: 'coder' });
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /only apply to agent "claude"/i);
});

// ─── LIVE e2e (WEZBRIDGE_E2E=1): real pane, real submission proof ──────────

test('LIVE e2e: spawn shell pane → verified send executes → cursor delta → a2a_send → kill', { skip: !E2E }, async () => {
  // 1. Spawn a throwaway shell pane (no CLI typed into it)
  const spawned = await callTool('spawn_session', { agent: 'shell', cwd: path.join(__dirname, '..') });
  assert.ok(!spawned.result.isError, `spawn failed: ${resultText(spawned)}`);
  const info = JSON.parse(resultText(spawned));
  const paneId = info.pane_id;
  assert.ok(Number.isInteger(paneId), 'spawn returned a pane id');
  assert.equal(info.agent, 'shell');

  try {
    // 2. send_prompt a marker echo — submission verified means it EXECUTED
    const marker = 'WZB_E2E_MARKER_' + process.pid;
    const sent = await callTool('send_prompt', { pane_id: paneId, text: 'echo ' + marker });
    assert.ok(!sent.result.isError, `send failed: ${resultText(sent)}`);
    const sendRes = JSON.parse(resultText(sent));
    assert.notEqual(sendRes.submitted, 'stuck', 'prompt must not be stuck');

    // 3. read_output with cursor — the marker must have been ECHOED (enter worked)
    await new Promise((r) => setTimeout(r, 1500));
    const read1 = await callTool('read_output', { pane_id: paneId, lines: 50, with_cursor: true });
    const r1 = JSON.parse(resultText(read1));
    assert.ok(r1.new_output.includes(marker), `marker not in pane output — enter did not submit. Output:\n${r1.new_output}`);
    assert.ok(typeof r1.cursor === 'string' && r1.cursor.length > 0, 'cursor returned');

    // 4. second command, then delta read: only NEW lines should come back
    const marker2 = 'WZB_E2E_SECOND_' + process.pid;
    await callTool('send_prompt', { pane_id: paneId, text: 'echo ' + marker2 });
    await new Promise((r) => setTimeout(r, 1500));
    const read2 = await callTool('read_output', { pane_id: paneId, lines: 50, since: r1.cursor });
    const r2 = JSON.parse(resultText(read2));
    assert.equal(r2.cursor_found, true, 'cursor should still match');
    assert.ok(r2.new_output.includes(marker2), 'delta contains the new marker');

    // 5. a2a_send lands a well-formed envelope in the pane
    const a2a = await callTool('a2a_send', { to_pane: paneId, body: 'e2e ping', type: 'request', from_pane: 999, corr: 'e2e-test-1' });
    assert.ok(!a2a.result.isError, `a2a_send failed: ${resultText(a2a)}`);
    const a2aRes = JSON.parse(resultText(a2a));
    assert.equal(a2aRes.corr, 'e2e-test-1');
    await new Promise((r) => setTimeout(r, 1200));
    const read3 = await callTool('read_output', { pane_id: paneId, lines: 30 });
    assert.match(resultText(read3), /A2A from pane-999 to pane-\d+ \| corr=e2e-test-1 \| type=request/, 'envelope visible in pane');
  } finally {
    // 6. always kill the throwaway pane
    const killed = await callTool('kill_session', { pane_id: paneId });
    assert.ok(!killed.result.isError, `kill failed: ${resultText(killed)}`);
  }
});
