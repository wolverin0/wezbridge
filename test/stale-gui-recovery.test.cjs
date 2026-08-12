'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('workspace spawn opens a fresh GUI when the running GUI socket is stale', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-stale-gui-'));
  const socketDirectory = path.join(home, '.local', 'share', 'wezterm');
  const staleSocket = path.join(socketDirectory, 'gui-sock-999');
  const marker = path.join(home, 'wezterm-marker.exe');
  fs.mkdirSync(socketDirectory, { recursive: true });
  fs.writeFileSync(staleSocket, '', 'utf8');
  fs.writeFileSync(marker, '', 'utf8');

  const originalExecFileSync = childProcess.execFileSync;
  const originalSpawn = childProcess.spawn;
  const originalHome = process.env.USERPROFILE;
  const spawnCalls = [];
  process.env.USERPROFILE = home;
  process.env.WEZBRIDGE_WEZTERM_BIN = marker;

  childProcess.execFileSync = function patched(file, args, options) {
    if (file === 'tasklist') {
      return '"wezterm-gui.exe","999","Console","1","1,000 K"\n';
    }
    if (file === marker) {
      if ((args || []).includes('spawn')) return '42\n';
      throw new Error('stale gui socket');
    }
    if (file === 'sleep' || file === 'timeout') return '';
    return originalExecFileSync.apply(this, arguments);
  };
  childProcess.spawn = function patchedSpawn(file, args, options) {
    spawnCalls.push({ file, args: [...args], options });
    return { on() {}, unref() {} };
  };

  try {
    const wezterm = require('../src/wezterm.cjs');
    const paneId = wezterm.spawnInWorkspace('roadmap-autopilot');

    assert.equal(paneId, 42);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].file, marker);
    assert.deepEqual(spawnCalls[0].args, ['connect', 'unix']);
    assert.equal(spawnCalls[0].options.detached, true);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    childProcess.spawn = originalSpawn;
    if (originalHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalHome;
    delete process.env.WEZBRIDGE_WEZTERM_BIN;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
