'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('discover_sessions redacts home directory paths and truncates last-text by default', async () => {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const longText = 'x'.repeat(550);
  const result = await callMcpTool('discover_sessions', { only_claude: false }, {
    WEZTERM_MOCK_CWD: path.join(home, 'repo', 'wezbridge'),
    WEZTERM_MOCK_TEXT: `Claude Code\n${longText}`,
  });

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.sessions[0].project, '~/repo/wezbridge');
  assert.equal(body.sessions[0].last_line.length, 503);
  assert.equal(body.sessions[0].last_line.endsWith('...'), true);
});

test('get_status redacts home directory paths and truncates last-text by default', async () => {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const longText = 'y'.repeat(550);
  const result = await callMcpTool('get_status', { pane_id: 1 }, {
    WEZTERM_MOCK_CWD: path.join(home, 'repo', 'wezbridge'),
    WEZTERM_MOCK_TEXT: `Claude Code\n${longText}`,
  });

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.project, '~/repo/wezbridge');
  assert.equal(body.last_lines.length, 503);
  assert.equal(body.last_lines.endsWith('...'), true);
});

test('verbose discover_sessions restores full path and output', async () => {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const fullPath = path.join(home, 'repo', 'wezbridge');
  const longText = 'z'.repeat(550);
  const result = await callMcpTool('discover_sessions', { only_claude: false, verbose: true }, {
    WEZTERM_MOCK_CWD: fullPath,
    WEZTERM_MOCK_TEXT: `Claude Code\n${longText}`,
  });

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.sessions[0].project.replace(/\\/g, '/'), fullPath.replace(/\\/g, '/'));
  assert.match(body.sessions[0].last_line, new RegExp(`${longText}$`));
});

test('verbose get_status restores full path and output', async () => {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const fullPath = path.join(home, 'repo', 'wezbridge');
  const longText = 'v'.repeat(550);
  const result = await callMcpTool('get_status', { pane_id: 1, verbose: true }, {
    WEZTERM_MOCK_CWD: fullPath,
    WEZTERM_MOCK_TEXT: `Claude Code\n${longText}`,
  });

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.project.replace(/\\/g, '/'), fullPath.replace(/\\/g, '/'));
  assert.match(body.last_lines, new RegExp(`${longText}$`));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-redaction-test-'));
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
  process.stdout.write(JSON.stringify([{
    id: '1',
    pane_id: 1,
    paneid: 1,
    tab_id: 1,
    window_id: 1,
    title: 'mock',
    cwd: process.env.WEZTERM_MOCK_CWD || '/tmp',
    workspace: 'default',
    is_active: true,
    pid: 12345
  }]));
} else if (subcommand === 'get-text') {
  process.stdout.write(process.env.WEZTERM_MOCK_TEXT || 'Claude Code\\n$');
} else {
  process.stdout.write('{}');
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
