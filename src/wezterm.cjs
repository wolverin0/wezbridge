/**
 * WezTerm CLI wrapper — low-level pane management and text injection.
 * All interaction with WezTerm happens through its CLI (`wezterm cli`).
 */
const { execFileSync, spawn } = require('child_process');
const os = require('os');

// Auto-detect WezTerm path based on platform
function detectWezterm() {
  if (process.env.WEZTERM_PATH) return process.env.WEZTERM_PATH;
  switch (os.platform()) {
    case 'win32': return 'C:\\Program Files\\WezTerm\\wezterm.exe';
    case 'darwin': return '/Applications/WezTerm.app/Contents/MacOS/wezterm';
    default: return 'wezterm'; // Linux: assume in PATH
  }
}

const WEZTERM = detectWezterm();
let guiLaunched = false;

function wezCmd(args, opts = {}) {
  try {
    const result = execFileSync(WEZTERM, ['cli', '--prefer-mux', ...args], {
      encoding: 'utf-8',
      timeout: opts.timeout || 10000,
      windowsHide: true,
    });
    return result.trim();
  } catch (err) {
    throw new Error(`wezterm cli ${args.join(' ')} failed: ${err.message}`);
  }
}

/** List all panes with metadata */
function listPanes() {
  const raw = wezCmd(['list', '--format', 'json']);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].toLowerCase().split(/\s+/);
    return lines.slice(1).map(line => {
      const cols = line.split(/\s+/);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i]; });
      return obj;
    });
  }
}

/** Ensure a visible WezTerm GUI is connected to the mux. */
function ensureGui() {
  if (guiLaunched) return;

  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      const tasks = execSync('tasklist', { encoding: 'utf-8', windowsHide: true });
      if (tasks.includes('wezterm-gui.exe')) {
        guiLaunched = true;
        return;
      }
    } catch { /* ignore */ }
  } else {
    // On Unix, check if GUI process exists
    try {
      const { execSync } = require('child_process');
      execSync('pgrep -f wezterm-gui', { encoding: 'utf-8' });
      guiLaunched = true;
      return;
    } catch { /* not running */ }
  }

  // Launch GUI connected to the unix mux domain
  const child = spawn(WEZTERM, ['connect', 'unix'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  guiLaunched = true;

  // Give the GUI a moment to connect
  if (os.platform() === 'win32') {
    execFileSync('timeout', ['/t', '3', '/nobreak'], { windowsHide: true, stdio: 'ignore' });
  } else {
    execFileSync('sleep', ['3'], { stdio: 'ignore' });
  }
}

/** Spawn a new pane. Returns the pane ID (number). */
function spawnPane({ cwd, program, args: spawnArgs, splitFrom, splitDirection } = {}) {
  ensureGui();
  const cmdArgs = ['spawn'];

  const panes = listPanes();
  if (splitFrom !== undefined) {
    cmdArgs.push('--pane-id', String(splitFrom));
    if (splitDirection === 'horizontal') {
      cmdArgs.push('--horizontal');
    }
  } else if (panes.length > 0) {
    cmdArgs.push('--pane-id', String(panes[0].pane_id || panes[0].paneid || 0));
    cmdArgs.push('--new-window');
  }

  if (cwd) cmdArgs.push('--cwd', cwd);

  if (program) {
    cmdArgs.push('--');
    cmdArgs.push(program);
    if (spawnArgs) cmdArgs.push(...spawnArgs);
  }

  const paneId = wezCmd(cmdArgs);
  return parseInt(paneId, 10);
}

/** Send text to a pane (simulates typing + Enter). */
function sendText(paneId, text) {
  // Send text + \r via --no-paste. \r is the actual Enter keypress in terminals.
  execFileSync(WEZTERM, ['cli', '--prefer-mux', 'send-text', '--pane-id', String(paneId), '--no-paste'], {
    input: text + '\r',
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });
}

/** Send text WITHOUT pressing Enter (for partial input). */
function sendTextNoEnter(paneId, text) {
  execFileSync(WEZTERM, ['cli', '--prefer-mux', 'send-text', '--pane-id', String(paneId), '--no-paste'], {
    input: text,
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });
}

/** Read the visible text from a pane. */
function getText(paneId) {
  return wezCmd(['get-text', '--pane-id', String(paneId)]);
}

/** Read full scrollback from a pane (up to N lines back). */
function getFullText(paneId, scrollbackLines = 500) {
  return wezCmd(['get-text', '--pane-id', String(paneId), '--start-line', String(-scrollbackLines)]);
}

/** Kill a pane. */
function killPane(paneId) {
  try {
    wezCmd(['kill-pane', '--pane-id', String(paneId)]);
  } catch { /* Pane may already be dead */ }
}

/** Activate (focus) a pane. */
function activatePane(paneId) {
  try {
    wezCmd(['activate-pane', '--pane-id', String(paneId)]);
  } catch { /* ignore */ }
}

module.exports = {
  listPanes,
  spawnPane,
  sendText,
  sendTextNoEnter,
  getText,
  getFullText,
  killPane,
  activatePane,
  ensureGui,
  WEZTERM,
};
