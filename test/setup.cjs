'use strict';

const childProcess = require('child_process');
const path = require('path');

const mockPath = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
// T-0321: un test que arranca el daemon REAL con un wezterm.exe deliberadamente
// colgado (test/daemon-census-worker.test.cjs) necesita que su binario
// sobreviva a este preload, que tambien corre dentro del daemon hijo via
// NODE_OPTIONS y lo pisaba con el mock (medido: AC3/AC4 fallaban solo dentro
// de la suite completa). El marcador es explicito para que nadie lo herede sin querer.
if (process.env.WEZBRIDGE_TEST_KEEP_WEZTERM_BIN !== '1') {
  process.env.WEZBRIDGE_WEZTERM_BIN = mockPath;
}

// Quote the path — NODE_OPTIONS splits on spaces, and this repo lives under
// "Py Apps" (child test processes died with MODULE_NOT_FOUND 'G:/.../Py').
const requireArg = `--require="${__filename.replace(/\\/g, '/')}"`;
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
