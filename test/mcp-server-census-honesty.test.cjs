'use strict';

// Regression for the 2026-07-28 oversight blind spot: `discover_sessions` with
// its default only_claude=true returned 8 panes while the machine had 17, and
// the response advertised only `total: 8` — so a filtered subset read as the
// whole fleet and 34 oversight passes ran without seeing the codex executor
// under active supervision or the daemon pane. The fix is not the default; it
// is that a filtered count must SAY it is filtered and state the real total.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let setupPath = null;

// Two panes: pane 1 looks like Claude Code, pane 2 looks like a plain shell.
// only_claude=true must therefore drop exactly one.
function createMockSetup() {
  if (setupPath) return setupPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-census-test-'));
  const markerPath = path.join(dir, 'wezterm-bin');
  const mockPath = path.join(dir, 'wezterm-mock.cjs');
  setupPath = path.join(dir, 'setup.cjs');
  fs.writeFileSync(markerPath, '', 'utf8');
  fs.writeFileSync(mockPath, `
'use strict';
const args = process.argv.slice(2).filter(a => a !== '--no-auto-start');
const sub = args[0] === 'cli' ? args[1] : args[0];
if (sub === '--version') {
  process.stdout.write('wezterm 20230408-112425-69ae8472');
} else if (sub === 'list') {
  process.stdout.write(JSON.stringify([1, 2].map(id => ({
    id: String(id), pane_id: id, paneid: id, tab_id: id, window_id: 1,
    title: id === 1 ? 'claude' : 'shell',
    cwd: '/tmp/repo', workspace: 'default', is_active: id === 1, pid: 1000 + id,
  }))));
} else if (sub === 'get-text') {
  const i = args.indexOf('--pane-id');
  const pane = i === -1 ? '1' : args[i + 1];
  // Pane 1: Claude indicators. Pane 2: a bare shell prompt, no agent markers.
  process.stdout.write(pane === '1'
    ? 'Claude Code\\n? for shortcuts\\nContext left until auto-compact: 40%\\n'
    : 'pauol@wolverin0 MINGW64 /tmp/repo\\n$ \\n');
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

function callMcpTool(name, args, env = {}) {
  const setup = createMockSetup();
  const serverPath = path.resolve(__dirname, '..', 'src', 'mcp-server.cjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env, NODE_OPTIONS: `--require=${setup.replace(/\\/g, '/')}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }) + '\n');
  child.stdin.end();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout. stderr=${stderr}`)); }, 8000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(Boolean);
      if (!line) return reject(new Error(`no stdout. stderr=${stderr}`));
      const msg = JSON.parse(line);
      if (msg.error) return reject(new Error(`rpc error ${JSON.stringify(msg.error)}`));
      resolve(msg.result);
    });
  });
}

test('census honesty: a filtered discover_sessions declares itself filtered and states the real total', async () => {
  const res = await callMcpTool('discover_sessions', {}); // default only_claude=true
  const body = JSON.parse(res.content[0].text);

  // The bug: this used to be the ONLY count in the response.
  assert.equal(body.total, 1, 'only the Claude pane survives the default filter');

  // The fix: the response must not let that stand as the fleet size.
  assert.equal(body.filtered, true, 'a response that dropped panes must say so');
  assert.equal(body.total_unfiltered, 2, 'the real pane count must be stated');
  assert.equal(body.omitted, 1);
  assert.match(body.omitted_note, /only_claude/, 'must name the cause and the remedy');
});

test('census honesty: an unfiltered census reports filtered:false and equal totals', async () => {
  const res = await callMcpTool('discover_sessions', { only_claude: false });
  const body = JSON.parse(res.content[0].text);

  assert.equal(body.total, 2, 'both panes returned');
  assert.equal(body.filtered, false, 'nothing was dropped');
  assert.equal(body.total_unfiltered, 2);
  assert.equal(body.omitted, undefined, 'omitted only appears when something was actually omitted');
  // The whole point: an oversight pass reading only `total` is now correct.
  assert.equal(body.total, body.total_unfiltered);
});
