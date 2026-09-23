'use strict';

const childProcess = require('child_process');
const path = require('path');

const mockPath = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
// T-0400: respect a caller-provided WEZBRIDGE_WEZTERM_BIN instead of always
// clobbering it — a handful of tests spawn mcp-server.cjs/poke-pane.cjs as a
// CHILD process with a DIFFERENT .cjs double (e.g. wezterm-echo-mock.cjs, a
// per-test fragmented-composer fixture) to observe real delivery outcomes
// that the default static mock cannot produce. Every other test still gets
// the default mock, unchanged.
if (!process.env.WEZBRIDGE_WEZTERM_BIN) process.env.WEZBRIDGE_WEZTERM_BIN = mockPath;
// T-0525: daemons started by the suite must not poll the operator's real Orca.
if (process.env.WEZBRIDGE_ORCA_CENSUS === undefined) process.env.WEZBRIDGE_ORCA_CENSUS = '0';

// Quote the path — NODE_OPTIONS splits on spaces, and this repo lives under
// "Py Apps" (child test processes died with MODULE_NOT_FOUND 'G:/.../Py').
const requireArg = `--require="${__filename.replace(/\\/g, '/')}"`;
if (!process.env.NODE_OPTIONS || !process.env.NODE_OPTIONS.includes(requireArg)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, requireArg].filter(Boolean).join(' ');
}

function mockCommand(file, args) {
  // T-0400: was `file !== mockPath` (only the ONE default double). Generalized
  // to "any .cjs double that exists" so a test can point WEZBRIDGE_WEZTERM_BIN
  // / WEZTERM_BIN at its OWN fixture mock (e.g. wezterm-echo-mock.cjs, a
  // per-test fragmented-composer script) and still have it routed through
  // node — .cjs files have no shebang association on Windows and would
  // otherwise fail to spawn directly. The default mockPath keeps working
  // exactly as before; this only widens what else is ALSO recognized.
  if (typeof file !== 'string' || !file.endsWith('.cjs') || !path.isAbsolute(file)) return null;
  try { if (!require('fs').existsSync(file)) return null; } catch { return null; }
  return { file: process.execPath, args: [file, ...(args || [])] };
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
