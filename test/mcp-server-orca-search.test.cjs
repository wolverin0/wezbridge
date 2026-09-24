'use strict';
/**
 * mcp-server-orca-search.test.cjs — T-0576: wiring of the `orca_search` MCP tool
 * in src/mcp-server.cjs (registration, input validation, and CLI-absence
 * tolerance through the real server subprocess). Flag pass-through and the
 * disabled-index message are covered exhaustively with an injected runOrcaFn in
 * test/orca-search.test.cjs — this file only proves the tool is wired up and
 * degrades safely, not the real `orca` binary (never invoked here).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('orca_search is registered in tools/list with query required and scope/sort enums', async () => {
  const result = await callMcp('tools/list');
  const tool = result.tools.find((t) => t.name === 'orca_search');
  assert.ok(tool, 'orca_search must be registered');
  assert.deepEqual(tool.inputSchema.required, ['query']);
  assert.deepEqual(tool.inputSchema.properties.scope.enum, ['conversation', 'all']);
  assert.deepEqual(tool.inputSchema.properties.sort.enum, ['relevance', 'newest']);
});

test('orca_search rejects a missing query without invoking the CLI', async () => {
  const result = await callMcpTool('orca_search', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query is required/);
});

test('orca_search rejects an invalid scope', async () => {
  const result = await callMcpTool('orca_search', { query: 'hello', scope: 'bogus' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid scope/);
});

test('orca_search rejects an invalid sort', async () => {
  const result = await callMcpTool('orca_search', { query: 'hello', sort: 'bogus' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid sort/);
});

test('orca_search rejects a query over the byte cap', async () => {
  const result = await callMcpTool('orca_search', { query: 'a'.repeat(2 * 1024 + 1) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query exceeds 2048 byte limit/);
});

test('orca_search: CLI absent degrades to an isError result, never crashes the server', async () => {
  const result = await callMcpTool('orca_search', { query: 'hello world', scope: 'all', limit: 3 },
    { ORCA_CLI: path.join(os.tmpdir(), 'no-such-orca-xyz.exe') });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /orca cli:/);
});

// ─── harness (same pattern as test/mcp-server-redaction.test.cjs / mcp-server-input-caps.test.cjs) ──

function callMcp(method, params, env = {}) {
  return callMcpRaw({ jsonrpc: '2.0', id: 1, method, params }, env).then((r) => r.result ?? r);
}

function callMcpTool(name, args, env = {}) {
  return callMcpRaw({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, env)
    .then((r) => r.result ?? r);
}

function callMcpRaw(payload, env = {}) {
  const setupPath = createMockSetup();
  const serverPath = path.resolve(__dirname, '..', 'src', 'mcp-server.cjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      WEZBRIDGE_INTEL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-intel-test-')),
      ...env,
      NODE_OPTIONS: `--require=${setupPath.replace(/\\/g, '/')}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(JSON.stringify(payload) + '\n');
  child.stdin.end();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP call timed out. stdout=${stdout} stderr=${stderr}`));
    }, 8000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(Boolean);
      if (!line) return reject(new Error(`MCP call produced no stdout. stderr=${stderr}`));
      const message = JSON.parse(line);
      if (message.error) return reject(new Error(`MCP JSON-RPC error: ${JSON.stringify(message.error)}`));
      resolve(message);
    });
  });
}

let setupPath;
function createMockSetup() {
  if (setupPath) return setupPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-orca-search-test-'));
  const markerPath = path.join(dir, 'wezterm-bin');
  const mockPath = path.join(dir, 'wezterm-mock.cjs');
  setupPath = path.join(dir, 'setup.cjs');
  fs.writeFileSync(markerPath, '', 'utf8');
  fs.writeFileSync(mockPath, `
'use strict';
const args = process.argv.slice(2).filter(arg => arg !== '--no-auto-start' && arg !== '--prefer-mux');
const subcommand = args[0] === 'cli' ? args[1] : args[0];
if (subcommand === '--version') {
  process.stdout.write('wezterm 20230408-112425-69ae8472');
} else if (subcommand === 'list') {
  process.stdout.write(JSON.stringify([{ pane_id: 1, paneid: 1, cwd: '/tmp', title: 'mock', workspace: 'default' }]));
} else {
  process.stdout.write('');
}
`, 'utf8');
  fs.writeFileSync(setupPath, `
'use strict';
const childProcess = require('node:child_process');
const markerPath = ${JSON.stringify(markerPath)};
const mockPath = ${JSON.stringify(mockPath)};
process.env.WEZBRIDGE_WEZTERM_BIN = markerPath;
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function execFileSync(file, args, options) {
  if (file === 'tasklist') return '';
  if (file === markerPath) return realExecFileSync.call(this, process.execPath, [mockPath, ...(args || [])], options);
  return realExecFileSync.apply(this, arguments);
};
`, 'utf8');
  return setupPath;
}
