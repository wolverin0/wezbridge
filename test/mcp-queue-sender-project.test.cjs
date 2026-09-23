'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function invoke(t, mode) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-sender-'));
  const cwd = path.join(temporary, 'producer');
  const intel = path.join(temporary, '_intel');
  fs.mkdirSync(cwd);
  t.after(() => { assert.equal(path.dirname(temporary), os.tmpdir()); fs.rmSync(temporary, { recursive: true, force: true }); });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/queue-sender-preload.cjs'), path.join(ROOT, 'src/mcp-server.cjs')], {
      cwd, env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel, QUEUE_SENDER_TEST_MODE: mode },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${errors}`)); }, 15000);
    child.on('error', reject);
    child.stderr.on('data', (data) => { errors += data; });
    child.stdout.on('data', (data) => { output += data; });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve({ response: JSON.parse(output.trim()).result, intel }); } catch (error) { reject(new Error(`${error.message}: ${errors}`)); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'a2a_send', arguments: { from_pane: 1, to_project: 'consumer', corr: 'queue-sender-probe', type: 'progress', body: 'synthetic sender retention probe' },
    } }) + '\n');
  });
}

for (const mode of ['queued', 'delivered', 'truncated', 'transport-error', 'unknown-sender']) {
  test(`MCP ${mode}: durable queue keeps the resolved sender, not a volatile pane alone`, async (t) => {
    const { response, intel } = await invoke(t, mode);
    const rows = fs.readFileSync(path.join(intel, 'queues/consumer.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].from_project, mode === 'unknown-sender' ? null : 'producer');
    assert.equal(rows[0].from_pane, 1);
    assert.equal(rows[0].body, 'synthetic sender retention probe');
    assert.equal(rows[0].ok, mode === 'delivered' || mode === 'unknown-sender');
    assert.equal(Boolean(response.isError), mode === 'transport-error');
  });
}
