'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('WezTerm version absent unregisters switch_workspace', async () => {
  const tools = await listTools({ WEZTERM_MOCK_VERSION: '' });
  assert.equal(tools.some(tool => tool.name === 'switch_workspace'), false);
});

test('WezTerm version before 20230408 unregisters switch_workspace', async () => {
  const tools = await listTools({ WEZTERM_MOCK_VERSION: 'wezterm 20230320-124340-559cb7b0' });
  assert.equal(tools.some(tool => tool.name === 'switch_workspace'), false);
});

test('WezTerm version 20230408 or newer registers switch_workspace', async () => {
  const tools = await listTools({ WEZTERM_MOCK_VERSION: 'wezterm 20230408-112425-69ae8472' });
  assert.equal(tools.some(tool => tool.name === 'switch_workspace'), true);
});

async function listTools(env) {
  const result = await callMcp('tools/list', undefined, env);
  return result.tools;
}

function callMcp(method, params, env = {}) {
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
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-version-test-'));
  const markerPath = path.join(dir, 'wezterm-bin');
  const mockPath = path.join(dir, 'wezterm-mock.cjs');
  setupPath = path.join(dir, 'setup.cjs');
  fs.writeFileSync(markerPath, '', 'utf8');
  fs.writeFileSync(mockPath, `
'use strict';
const args = process.argv.slice(2).filter(arg => arg !== '--no-auto-start');
const subcommand = args[0] === 'cli' ? args[1] : args[0];
if (subcommand === '--version') {
  process.stdout.write(process.env.WEZTERM_MOCK_VERSION || '');
} else if (subcommand === 'list') {
  process.stdout.write('[]');
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
  if (file === markerPath) return realExecFileSync.call(this, process.execPath, [mockPath, ...(args || [])], options);
  return realExecFileSync.apply(this, arguments);
};
`, 'utf8');
  return setupPath;
}
