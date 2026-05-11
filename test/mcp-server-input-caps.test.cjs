'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('send_prompt rejects prompt over 16 KB', async () => {
  const result = await callMcpTool('send_prompt', { pane_id: 1, text: 'a'.repeat(16 * 1024 + 1) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /prompt exceeds 16384 byte limit/);
});

test('send_key rejects key over 64 bytes', async () => {
  const result = await callMcpTool('send_key', { pane_id: 1, key: 'x'.repeat(65) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /key exceeds 64 byte limit/);
});

test('auto_handoff rejects focus over 256 bytes', async () => {
  const result = await callMcpTool('auto_handoff', { pane_id: 1, focus: 'f'.repeat(257) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /focus exceeds 256 byte limit/);
});

test('split_pane rejects args JSON over 4 KB', async () => {
  const result = await callMcpTool('split_pane', { pane_id: 1, args: ['a'.repeat(4096)] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /args exceeds 4096 byte limit/);
});

test('valid capped inputs are accepted', async () => {
  const prompt = await callMcpTool('send_prompt', { pane_id: 1, text: 'a'.repeat(16 * 1024) });
  assert.equal(prompt.isError, undefined);
  assert.match(prompt.content[0].text, /Prompt sent to pane 1/);

  const key = await callMcpTool('send_key', { pane_id: 1, key: 'x'.repeat(64) });
  assert.equal(key.isError, undefined);
  assert.match(key.content[0].text, /Key ".+" sent to pane 1/);

  const split = await callMcpTool('split_pane', { pane_id: 1, args: ['ok'] });
  assert.equal(split.isError, undefined);
  assert.match(split.content[0].text, /pane_id/);
});

function callMcpTool(name, args, env = {}) {
  const setupPath = createMockSetup();
  const serverPath = path.resolve(__dirname, '..', 'src', 'mcp-server.cjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: `--require=${setupPath.replace(/\\/g, '/')}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }) + '\n');
  child.stdin.end();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP call timed out. stdout=${stdout} stderr=${stderr}`));
    }, 5000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(Boolean);
      if (!line) return reject(new Error(`MCP call produced no stdout. stderr=${stderr}`));
      const message = JSON.parse(line);
      if (message.error) return reject(new Error(`MCP JSON-RPC error: ${JSON.stringify(message.error)}`));
      resolve(message.result);
    });
  });
}

let setupPath;
function createMockSetup() {
  if (setupPath) return setupPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-input-test-'));
  const markerPath = path.join(dir, 'wezterm-bin');
  const mockPath = path.join(dir, 'wezterm-mock.cjs');
  setupPath = path.join(dir, 'setup.cjs');
  fs.writeFileSync(markerPath, '', 'utf8');
  fs.writeFileSync(mockPath, `
'use strict';
const args = process.argv.slice(2).filter(arg => arg !== '--no-auto-start');
const subcommand = args[0] === 'cli' ? args[1] : args[0];
if (subcommand === '--version') {
  process.stdout.write('wezterm 20230408-112425-69ae8472');
} else if (subcommand === 'list') {
  process.stdout.write(JSON.stringify([{ pane_id: 1, paneid: 1, cwd: '/tmp', title: 'mock', workspace: 'default' }]));
} else if (subcommand === 'split-pane' || subcommand === 'spawn') {
  process.stdout.write('2');
} else if (subcommand === 'get-text') {
  process.stdout.write('Claude Code\\n$');
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
