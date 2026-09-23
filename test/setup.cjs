'use strict';

const childProcess = require('child_process');
const path = require('path');

const mockPath = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
const testDir = __dirname;
// T-0400 fix-up: WEZBRIDGE_WEZTERM_BIN is the SAME var production code reads
// (src/wezterm.cjs) — respecting an ambient value here would let a real
// wezterm.exe left in a dev's shell leak into `npm test` and get driven by a
// spawned mcp-server.cjs/poke-pane.cjs child. So it is ALWAYS overwritten to
// the default mock EXCEPT via the test-only WEZBRIDGE_TEST_WEZTERM_BIN,
// which must point at an existing .cjs double under test/ (never an ambient
// real binary) — used by the handful of tests that need a different double
// (e.g. wezterm-echo-mock.cjs) to observe outcomes the static default mock
// can't produce.
const testBin = process.env.WEZBRIDGE_TEST_WEZTERM_BIN;
if (testBin && testBin.endsWith('.cjs') && path.isAbsolute(testBin)
  && path.relative(testDir, testBin).split(path.sep)[0] !== '..'
  && require('fs').existsSync(testBin)) {
  process.env.WEZBRIDGE_WEZTERM_BIN = testBin;
} else {
  process.env.WEZBRIDGE_WEZTERM_BIN = mockPath;
}
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
  // to "any .cjs double under test/ that exists" so a test can point
  // WEZBRIDGE_WEZTERM_BIN / WEZTERM_BIN at its OWN fixture mock (e.g.
  // wezterm-echo-mock.cjs, a per-test fragmented-composer script) and still
  // have it routed through node — .cjs files have no shebang association on
  // Windows and would otherwise fail to spawn directly. Tightened (fix-up) to
  // require the path live under test/ — a test double, never an arbitrary
  // absolute .cjs — so this can't be used to smuggle a non-test binary.
  if (typeof file !== 'string' || !file.endsWith('.cjs') || !path.isAbsolute(file)) return null;
  if (path.relative(testDir, file).split(path.sep)[0] === '..') return null;
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
