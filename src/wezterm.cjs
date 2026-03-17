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

/**
 * Find the live GUI socket by matching gui-sock-* files to running wezterm-gui PIDs.
 * On Windows, WezTerm creates gui-sock-{PID} files but the CLI defaults to the
 * last-created one which may be stale. We find the correct one by checking tasklist.
 *
 * Returns the WEZTERM_UNIX_SOCKET path for the best GUI socket, or null to use default.
 */
let _cachedGuiSocket = undefined; // undefined = not yet checked, null = use default
let _socketCacheTime = 0;
const SOCKET_CACHE_TTL = 30000; // re-check socket every 30s
function findGuiSocket() {
  // Re-check after TTL expires (handles WezTerm restarts/crashes)
  if (_cachedGuiSocket !== undefined && (Date.now() - _socketCacheTime) < SOCKET_CACHE_TTL) return _cachedGuiSocket;

  if (process.platform !== 'win32') {
    _cachedGuiSocket = null;
    return null;
  }

  const fs = require('fs');
  const sockDir = require('path').join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.local', 'share', 'wezterm'
  );

  try {
    // Get running wezterm-gui PIDs
    const tasks = execFileSync('tasklist', ['/fi', 'imagename eq wezterm-gui.exe', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
    });
    const pids = [];
    for (const line of tasks.split('\n')) {
      const match = line.match(/"wezterm-gui\.exe","(\d+)"/i);
      if (match) pids.push(match[1]);
    }

    if (pids.length === 0) {
      _cachedGuiSocket = null;
      return null;
    }

    // Find gui-sock files matching running PIDs, pick the one with most panes
    const sockFiles = fs.readdirSync(sockDir).filter(f => f.startsWith('gui-sock-'));
    let bestSocket = null;
    let bestPaneCount = 0;

    for (const pid of pids) {
      const sockName = `gui-sock-${pid}`;
      if (sockFiles.includes(sockName)) {
        const sockPath = require('path').join(sockDir, sockName);
        try {
          const out = execFileSync(WEZTERM, ['cli', 'list', '--format', 'json'], {
            encoding: 'utf-8', timeout: 5000, windowsHide: true,
            env: { ...process.env, WEZTERM_UNIX_SOCKET: sockPath },
          });
          const paneCount = JSON.parse(out).length;
          if (paneCount > bestPaneCount) {
            bestPaneCount = paneCount;
            bestSocket = sockPath;
          }
        } catch { /* this socket didn't work, try next */ }
      }
    }

    if (bestSocket) {
      _cachedGuiSocket = bestSocket;
      _socketCacheTime = Date.now();
      return bestSocket;
    }
  } catch { /* tasklist or fs failed */ }

  _cachedGuiSocket = null;
  _socketCacheTime = Date.now();
  return null;
}

// Note: execFileSync blocks the event loop. For N sessions, pollAll blocks N * timeout_ms.
// TODO: Consider async execFile for high session counts.
function wezCmd(args, opts = {}) {
  try {
    const guiSocket = findGuiSocket();
    const env = guiSocket
      ? { ...process.env, WEZTERM_UNIX_SOCKET: guiSocket }
      : process.env;

    // Connect to GUI only — do NOT fall back to mux (prevents zombie mux-servers)
    const cliArgs = ['cli', ...args];

    const result = execFileSync(WEZTERM, cliArgs, {
      encoding: 'utf-8',
      timeout: opts.timeout || 10000,
      windowsHide: true,
      env,
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
    // Give the GUI a moment to connect to the mux server.
    // Note: This blocks the event loop for 3s. A non-blocking alternative would require
    // making ensureGui async, which ripples into spawnPane and all callers.
    // The blocking sleep is acceptable here because ensureGui only runs once per process.
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
  const guiSocket = findGuiSocket();
  const cliArgs = guiSocket
    ? ['cli', 'send-text', '--pane-id', String(paneId), '--no-paste']
    : ['cli', '--prefer-mux', 'send-text', '--pane-id', String(paneId), '--no-paste'];
  const env = guiSocket ? { ...process.env, WEZTERM_UNIX_SOCKET: guiSocket } : process.env;
  execFileSync(WEZTERM, cliArgs, {
    input: text + '\r',
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
    env,
  });
}

/** Send text WITHOUT pressing Enter (for partial input). */
function sendTextNoEnter(paneId, text) {
  const guiSocket = findGuiSocket();
  const cliArgs = guiSocket
    ? ['cli', 'send-text', '--pane-id', String(paneId), '--no-paste']
    : ['cli', '--prefer-mux', 'send-text', '--pane-id', String(paneId), '--no-paste'];
  const env = guiSocket ? { ...process.env, WEZTERM_UNIX_SOCKET: guiSocket } : process.env;
  execFileSync(WEZTERM, cliArgs, {
    input: text,
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
    env,
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

/** Set the tab title for a pane. */
function setTabTitle(paneId, title) {
  try {
    wezCmd(['set-tab-title', '--pane-id', String(paneId), title]);
  } catch {
    // ignore
  }
}

/** Split an existing pane horizontally (side by side). Returns new pane ID. */
function splitHorizontal(paneId, { cwd, program, args: spawnArgs } = {}) {
  const cmdArgs = ['split-pane', '--pane-id', String(paneId), '--horizontal'];
  if (cwd) cmdArgs.push('--cwd', cwd);
  if (program) {
    cmdArgs.push('--');
    cmdArgs.push(program);
    if (spawnArgs) cmdArgs.push(...spawnArgs);
  }
  const newId = wezCmd(cmdArgs);
  return parseInt(newId, 10);
}

/** Split an existing pane vertically (top/bottom). Returns new pane ID. */
function splitVertical(paneId, { cwd, program, args: spawnArgs } = {}) {
  const cmdArgs = ['split-pane', '--pane-id', String(paneId)];
  // No --horizontal flag = vertical split (default)
  if (cwd) cmdArgs.push('--cwd', cwd);
  if (program) {
    cmdArgs.push('--');
    cmdArgs.push(program);
    if (spawnArgs) cmdArgs.push(...spawnArgs);
  }
  const newId = wezCmd(cmdArgs);
  return parseInt(newId, 10);
}

/** Move focus to a specific direction from current pane. */
function activatePaneDirection(paneId, direction) {
  // direction: 'Up', 'Down', 'Left', 'Right'
  try {
    wezCmd(['activate-pane-direction', '--pane-id', String(paneId), direction]);
  } catch { /* ignore */ }
}

/** List all workspaces. */
function listWorkspaces() {
  try {
    const raw = wezCmd(['list', '--format', 'json']);
    if (!raw) return [];
    const panes = JSON.parse(raw);
    const workspaces = new Set();
    for (const p of panes) {
      if (p.workspace) workspaces.add(p.workspace);
    }
    return [...workspaces];
  } catch {
    return [];
  }
}

/** Switch to a workspace (creates it if it doesn't exist). */
function switchWorkspace(name) {
  try {
    // WezTerm doesn't have a direct "switch workspace" CLI command,
    // but we can set the workspace when spawning a new pane
    wezCmd(['switch-to-workspace', '--name', name]);
  } catch {
    // Older versions may not support this — ignore
  }
}

/** Spawn a pane in a specific workspace. */
function spawnInWorkspace(workspace, { cwd, program, args: spawnArgs } = {}) {
  ensureGui();
  const cmdArgs = ['spawn', '--workspace', workspace];
  if (cwd) cmdArgs.push('--cwd', cwd);
  if (program) {
    cmdArgs.push('--');
    cmdArgs.push(program);
    if (spawnArgs) cmdArgs.push(...spawnArgs);
  }
  const paneId = wezCmd(cmdArgs);
  return parseInt(paneId, 10);
}

/** Spawn a pane via an SSH domain. Returns pane ID. */
function spawnSshDomain(domainName, { cwd, program, args: spawnArgs } = {}) {
  ensureGui();
  const cmdArgs = ['spawn', '--domain-name', domainName];
  if (cwd) cmdArgs.push('--cwd', cwd);
  if (program) {
    cmdArgs.push('--');
    cmdArgs.push(program);
    if (spawnArgs) cmdArgs.push(...spawnArgs);
  }
  const paneId = wezCmd(cmdArgs);
  return parseInt(paneId, 10);
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
  setTabTitle,
  ensureGui,
  splitHorizontal,
  splitVertical,
  activatePaneDirection,
  listWorkspaces,
  switchWorkspace,
  spawnInWorkspace,
  spawnSshDomain,
  WEZTERM,
};
