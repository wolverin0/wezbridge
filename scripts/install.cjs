#!/usr/bin/env node
'use strict';

/**
 * wezbridge installer — one command to wire wezbridge into your AI CLIs.
 *
 * Registers the `mcp__wezbridge__*` server on Claude Code (and Codex if present),
 * sets the Windows crash-prevention env var, and (optionally) arms the :4200 daemon.
 * Zero dependencies. Idempotent — safe to re-run.
 *
 *   node scripts/install.cjs            full install
 *   node scripts/install.cjs --dry-run  preview, change nothing
 *   node scripts/install.cjs --no-codex skip Codex registration
 *   node scripts/install.cjs --no-daemon don't start / autostart the daemon
 *   node scripts/install.cjs --help
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const MCP = path.join(ROOT, 'src', 'mcp-server.cjs');
const DASHBOARD = path.join(ROOT, 'src', 'dashboard-server.cjs');
const IS_WIN = process.platform === 'win32';
const PORT = process.env.DASHBOARD_PORT || '4200';

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has('--dry-run');
const SKIP_CODEX = ARGS.has('--no-codex');
const SKIP_DAEMON = ARGS.has('--no-daemon');

const out = {
  head: (s) => console.log(`\n${s}`),
  ok: (s) => console.log(`  [ok]  ${s}`),
  warn: (s) => console.log(`  [!]   ${s}`),
  info: (s) => console.log(`        ${s}`),
  dry: (s) => console.log(`  [dry] ${s}`),
};

function hasCmd(cmd) {
  try {
    execFileSync(IS_WIN ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tryRun(cmd, argv) {
  try {
    return { ok: true, text: execFileSync(cmd, argv, { encoding: 'utf8' }) };
  } catch (err) {
    return { ok: false, text: `${err.stdout || ''}${err.stderr || ''}` || String(err.message || err) };
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function printHelp() {
  console.log(`wezbridge installer

Usage: node scripts/install.cjs [options]

  (no args)     register the MCP on Claude (+ Codex if present), set env, start the :4200 daemon
  --dry-run     show what would happen, change nothing
  --no-codex    skip Codex CLI registration
  --no-daemon   don't start or autostart the dashboard daemon
  --help        this message

Prereqs: Node 20+, WezTerm, and at least one AI CLI (claude and/or codex).`);
}

function checkPrereqs() {
  out.head('1. Prerequisites');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) out.warn(`Node ${process.versions.node} found — wezbridge needs Node 20+`);
  else out.ok(`Node ${process.versions.node}`);

  if (hasCmd('wezterm')) out.ok('wezterm on PATH');
  else out.warn('wezterm not found — install from https://wezfurlong.org/wezterm/ (mux is built in)');

  const claude = hasCmd('claude');
  const codex = hasCmd('codex');
  if (claude) out.ok('claude CLI on PATH');
  if (codex) out.ok('codex CLI on PATH');
  if (!claude && !codex) out.warn('no claude or codex CLI found — install at least one, then re-run');
  return { claude, codex };
}

function registerClaude(present) {
  out.head('2. Register wezbridge MCP on Claude Code');
  if (!present) {
    out.info('claude CLI not found — skipping. Later: claude mcp add wezbridge --scope user -- node ' + MCP);
    return;
  }
  const list = tryRun('claude', ['mcp', 'list']);
  if (list.ok && /wezbridge/i.test(list.text)) {
    out.ok('already registered (seen in `claude mcp list`)');
    return;
  }
  if (DRY) {
    out.dry(`claude mcp add wezbridge --scope user -- node "${MCP}"`);
    return;
  }
  const r = tryRun('claude', ['mcp', 'add', 'wezbridge', '--scope', 'user', '--', 'node', MCP]);
  if (r.ok) out.ok('registered at user scope (every Claude Code session)');
  else {
    out.warn('auto-register failed — run this yourself:');
    out.info(`claude mcp add wezbridge --scope user -- node "${MCP}"`);
  }
}

function registerCodex(present) {
  out.head('3. Register wezbridge MCP on Codex CLI');
  if (!present) {
    out.info('codex CLI not found — skipping (harmless; install Codex later if you want cross-LLM swarms)');
    return;
  }
  const cfg = path.join(os.homedir(), '.codex', 'config.toml');
  const existing = readFileSafe(cfg);
  if (/\[mcp_servers\.wezbridge\]/.test(existing)) {
    out.ok('already present in ~/.codex/config.toml');
    return;
  }
  const block = `\n[mcp_servers.wezbridge]\ncommand = "node"\nargs = ["${MCP.replace(/\\/g, '\\\\')}"]\n`;
  if (DRY) {
    out.dry(`append [mcp_servers.wezbridge] block to ${cfg}`);
    return;
  }
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.appendFileSync(cfg, block, 'utf8');
  out.ok(`added to ${cfg} (restart Codex to load)`);
}

function setWezLog() {
  out.head('4. Crash-prevention env var');
  if (!IS_WIN) {
    out.ok('not Windows — not needed');
    return;
  }
  if (/local=off/.test(process.env.WEZTERM_LOG || '')) {
    out.ok('WEZTERM_LOG already set');
    return;
  }
  if (DRY) {
    out.dry('setx WEZTERM_LOG "wezterm_mux_server_impl::local=off"');
    return;
  }
  const r = tryRun('setx', ['WEZTERM_LOG', 'wezterm_mux_server_impl::local=off']);
  if (r.ok) out.ok('WEZTERM_LOG set (restart WezTerm to apply)');
  else out.warn('could not set WEZTERM_LOG — set it manually in your environment');
}

function startDaemon() {
  out.head('5. Dashboard daemon (:4200 backend, required by the MCP tools)');
  if (SKIP_DAEMON) {
    out.info('skipped (--no-daemon). Start it with: npm run dashboard');
    return;
  }
  if (DRY) {
    out.dry(`autostart on login + spawn detached: node ${DASHBOARD}`);
    return;
  }
  if (IS_WIN) {
    const r = tryRun('cmd', ['/c', path.join(ROOT, 'scripts', 'install-autostart.cmd')]);
    if (r.ok) out.ok('daemon set to auto-launch on user login');
    else out.warn('autostart-on-login not configured (run `npm run install-autostart` manually)');
  } else {
    out.info('autostart: add `node src/dashboard-server.cjs` to your login items / a systemd user unit');
  }
  try {
    const child = spawn(process.execPath, [DASHBOARD], { detached: true, stdio: 'ignore', cwd: ROOT });
    child.unref();
    out.ok('daemon started in the background');
  } catch (err) {
    out.warn(`could not spawn daemon: ${err.message} — run \`npm run dashboard\` yourself`);
  }
}

function verify(done) {
  out.head('6. Verify');
  if (DRY) {
    out.dry(`GET http://localhost:${PORT}/api/panes`);
    return done();
  }
  const req = http.get(`http://localhost:${PORT}/api/panes`, { timeout: 4000 }, (res) => {
    if (res.statusCode === 200) out.ok(`daemon responding on :${PORT}/api/panes`);
    else out.warn(`daemon returned HTTP ${res.statusCode} on :${PORT}`);
    res.resume();
    done();
  });
  req.on('error', () => {
    out.warn(`daemon not reachable on :${PORT} yet — give it a few seconds, then: curl http://localhost:${PORT}/api/panes`);
    done();
  });
  req.on('timeout', () => {
    req.destroy();
    out.warn('daemon health check timed out');
    done();
  });
}

function summary() {
  out.head('Done.');
  console.log(`  Restart your AI CLIs to pick up the wezbridge MCP, then the
  mcp__wezbridge__* tools are live. Confirm with:  claude mcp list

  Optional add-ons (see README):
    - Telegram phone control  ->  docs/SETUP-omniclaude-telegram.md
    - Wezterm Lua plugin       ->  README, "Wezterm Lua plugin" (zero-click crash recovery)
    - Safety guards            ->  node scripts/install-hooks.cjs
`);
}

function main() {
  if (ARGS.has('--help') || ARGS.has('-h')) {
    printHelp();
    return;
  }
  console.log(`wezbridge installer${DRY ? '  (dry-run — nothing will change)' : ''}`);
  console.log(`  repo: ${ROOT}`);

  const found = checkPrereqs();
  registerClaude(found.claude);
  if (!SKIP_CODEX) registerCodex(found.codex);
  setWezLog();
  startDaemon();

  // give the freshly-spawned daemon a moment before the health check
  const delay = DRY || SKIP_DAEMON ? 0 : 1500;
  setTimeout(() => verify(summary), delay);
}

main();
