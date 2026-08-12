const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const MODULE_PATH = path.resolve(__dirname, '..', 'src', 'wezterm.cjs');

test('explicit mux mode bypasses GUI socket discovery for reads and sends', () => {
  const originalExecFileSync = childProcess.execFileSync;
  const originalPreferMux = process.env.WEZBRIDGE_PREFER_MUX;
  const originalSocket = process.env.WEZTERM_UNIX_SOCKET;
  const originalBinary = process.env.WEZBRIDGE_WEZTERM_BIN;
  const calls = [];

  process.env.WEZBRIDGE_PREFER_MUX = '1';
  process.env.WEZTERM_UNIX_SOCKET = 'C:/stable/wezterm/sock';
  process.env.WEZBRIDGE_WEZTERM_BIN = 'wezterm-test-bin';
  childProcess.execFileSync = (file, args, options = {}) => {
    calls.push({ file, args, options });
    assert.notEqual(file, 'tasklist', 'mux mode must not inspect GUI process IDs');
    if (args.includes('list')) return '[]';
    return '';
  };

  try {
    delete require.cache[MODULE_PATH];
    const wezterm = require(MODULE_PATH);
    assert.deepEqual(wezterm.listPanes(), []);
    wezterm.sendTextNoEnter(17, 'scheduled-proof');

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 3), ['cli', '--prefer-mux', '--no-auto-start']);
      assert.equal(call.options.env.WEZTERM_UNIX_SOCKET, 'C:/stable/wezterm/sock');
      assert.equal(call.args.some((arg) => /^gui-sock-/i.test(arg)), false);
    }
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    if (originalPreferMux === undefined) delete process.env.WEZBRIDGE_PREFER_MUX;
    else process.env.WEZBRIDGE_PREFER_MUX = originalPreferMux;
    if (originalSocket === undefined) delete process.env.WEZTERM_UNIX_SOCKET;
    else process.env.WEZTERM_UNIX_SOCKET = originalSocket;
    if (originalBinary === undefined) delete process.env.WEZBRIDGE_WEZTERM_BIN;
    else process.env.WEZBRIDGE_WEZTERM_BIN = originalBinary;
    delete require.cache[MODULE_PATH];
  }
});
