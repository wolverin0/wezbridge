'use strict';

const childProcess = require('child_process');
const path = require('path');

const mockPath = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
process.env.WEZBRIDGE_WEZTERM_BIN = mockPath;

const requireArg = `--require=${__filename.replace(/\\/g, '/')}`;
if (!process.env.NODE_OPTIONS || !process.env.NODE_OPTIONS.includes(requireArg)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, requireArg].filter(Boolean).join(' ');
}

function mockCommand(file, args) {
  if (file !== mockPath) return null;
  return { file: process.execPath, args: [mockPath, ...(args || [])] };
}

const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function execFileSync(file, args, options) {
  const command = mockCommand(file, args);
  if (command) return realExecFileSync.call(this, command.file, command.args, options);
  return realExecFileSync.apply(this, arguments);
};

const realExecFile = childProcess.execFile;
childProcess.execFile = function execFile(file, args, options, callback) {
  const command = mockCommand(file, args);
  if (command) return realExecFile.call(this, command.file, command.args, options, callback);
  return realExecFile.apply(this, arguments);
};

const realSpawn = childProcess.spawn;
childProcess.spawn = function spawn(file, args, options) {
  const command = mockCommand(file, args);
  if (command) return realSpawn.call(this, command.file, command.args, options);
  return realSpawn.apply(this, arguments);
};
