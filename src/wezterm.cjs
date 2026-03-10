/**
 * WezTerm CLI wrapper — low-level pane management and text injection.
 * All interaction with WezTerm happens through its CLI (`wezterm cli`).
 */
const { execFileSync, execFile, spawn } = require('child_process');

// Node.js on Windows needs Windows-style paths (C:/...) not MSYS2 paths (/c/...)
// Convert /c/... to C:/... for Node's execFileSync
function msysToWin(p) {
  return p.replace(/^\/([a-zA-Z])\//, (_, drive) => `${drive.toUpperCase()}:/`);
}

function findWezterm() {
  if (process.env.WEZTERM_PATH) return process.env.WEZTERM_PATH;
  const fs = require('fs');
  // Check all known locations: Windows native, Git Bash (/c/), WSL (/mnt/c/)
  const candidates = [
    'C:/Program Files/WezTerm/wezterm.exe',
    '/mnt/c/Program Files/WezTerm/wezterm.exe',
    '/c/Program Files/WezTerm/wezterm.exe',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  // Try which (Git Bash / Linux / macOS) and convert MSYS2 path
  const { execSync } = require('child_process');
  try {
    const p = execSync('which wezterm', { encoding: 'utf-8', timeout: 3000, windowsHide: true }).trim();
    if (p) return msysToWin(p);
  } catch {}
  // Try where (native Windows cmd)
  try {
    const p = execSync('where wezterm.exe', { encoding: 'utf-8', timeout: 3000, windowsHide: true }).trim().split('\n')[0];
    if (p) return p;
  } catch {}
  // Try wezterm.exe via Windows interop (WSL)
  try {
    const p = execSync('which wezterm.exe', { encoding: 'utf-8', timeout: 3000, windowsHide: true }).trim();
    if (p) return p;
  } catch {}
  return 'wezterm'; // hope it's in PATH
}
const WEZTERM = findWezterm();
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
    // Fallback: parse the text table
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
  // Check if mux is already reachable by listing panes
  try {
    const result = execFileSync(WEZTERM, ['cli', '--prefer-mux', 'list'], {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
    });
    if (result && result.includes('PANEID')) {
      guiLaunched = true;
      return;
    }
  } catch { /* mux not reachable */ }
  // Also check tasklist for the GUI process
  try {
    const { execSync } = require('child_process');
    const tasks = execSync('tasklist', { encoding: 'utf-8', windowsHide: true });
    if (tasks.includes('wezterm-gui.exe')) {
      guiLaunched = true;
      return;
    }
  } catch { /* ignore */ }
  // Launch GUI connected to the unix mux domain (makes panes visible)
  try {
    const child = spawn(WEZTERM, ['connect', 'unix'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', () => {}); // Prevent unhandled error crash
    child.unref();
    guiLaunched = true;
    // Give the GUI a moment to connect
    // Wait for GUI to connect — use sleep (bash) or timeout (Windows)
    try { execFileSync('sleep', ['3'], { windowsHide: true, stdio: 'ignore' }); }
    catch { try { execFileSync('timeout', ['/t', '3', '/nobreak'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  } catch {
    // GUI launch failed but mux may still work — mark as launched to avoid retrying
    guiLaunched = true;
  }
}

/** Spawn a new pane. Returns the pane ID (number). */
function spawnPane({ cwd, program, args: spawnArgs, splitFrom, splitDirection } = {}) {
  ensureGui();
  const cmdArgs = ['spawn'];

  // Reference an existing pane so the mux knows the context
  const panes = listPanes();
  if (splitFrom !== undefined) {
    cmdArgs.push('--pane-id', String(splitFrom));
    if (splitDirection === 'horizontal') {
      cmdArgs.push('--horizontal');
    } else if (splitDirection === 'vertical') {
      cmdArgs.push('--vertical');  // not actually a flag, splits default vertical
    }
  } else if (panes.length > 0) {
    // Spawn as a new tab in the same window (not a new window)
    cmdArgs.push('--pane-id', String(panes[0].pane_id || panes[0].paneid || 0));
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
  } catch {
    // Pane may already be dead
  }
}

/** Activate (focus) a pane. */
function activatePane(paneId) {
  try {
    wezCmd(['activate-pane', '--pane-id', String(paneId)]);
  } catch {
    // ignore
  }
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
