'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('spawnInWorkspace opens a new window before selecting the workspace', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wezbridge-workspace-spawn-'));
  const marker = path.join(directory, 'wezterm-marker.exe');
  fs.writeFileSync(marker, '', 'utf8');
  const calls = [];
  const original = childProcess.execFileSync;
  process.env.WEZBRIDGE_WEZTERM_BIN = marker;

  childProcess.execFileSync = function patched(file, args, options) {
    if (file === marker) {
      calls.push([...(args || [])]);
      if ((args || []).includes('list')) return 'PANEID\n1\n';
      if ((args || []).includes('spawn')) return '42\n';
      return '';
    }
    return original.apply(this, arguments);
  };

  try {
    const wezterm = require('../src/wezterm.cjs');
    const paneId = wezterm.spawnInWorkspace('roadmap-autopilot', {
      cwd: 'C:/repo',
      program: 'cmd.exe',
      args: ['/d'],
    });
    const spawnCall = calls.find((args) => args.includes('spawn'));
    const spawnIndex = spawnCall.indexOf('spawn');

    assert.equal(paneId, 42);
    assert.deepEqual(spawnCall.slice(spawnIndex), [
      'spawn',
      '--new-window',
      '--workspace',
      'roadmap-autopilot',
      '--cwd',
      'C:/repo',
      '--',
      'cmd.exe',
      '/d',
    ]);
  } finally {
    childProcess.execFileSync = original;
    delete process.env.WEZBRIDGE_WEZTERM_BIN;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
