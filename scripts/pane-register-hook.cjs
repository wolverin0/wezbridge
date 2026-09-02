#!/usr/bin/env node
'use strict';
/**
 * pane-register-hook.cjs — SessionStart/SessionEnd hook: la sesion declara su ROL (T-0322).
 *
 * Escribe <registro>/<WEZTERM_PANE>.json = { role, project, cwd, pid, agent, started_at }
 * (registro: ~/.local/share/wezterm/panes, override WEZBRIDGE_PANE_REGISTRY).
 * poke-pane --role <r> resuelve por ese archivo y lo valida contra el mux.
 *
 * Como hook de Claude Code (stdin JSON con cwd / hook_event_name / source):
 *   SessionStart -> registra (startup|resume|clear|compact: re-registra el mismo pane)
 *   SessionEnd   -> borra el registro
 * Como comando (Codex u otro launcher, sin stdin):
 *   node scripts/pane-register-hook.cjs --agent codex [--role r] [--cwd dir]
 *   node scripts/pane-register-hook.cjs --end
 *
 * El rol sale de: --role > $WEZBRIDGE_ROLE > <cwd>/.wezbridge-role (primera linea)
 * > basename(cwd). El pid es el del padre (la sesion), no el del hook.
 * Unicidad: si OTRO pane vivo ya tiene ese rol en ese cwd, NO se escribe, se
 * explica en stderr y sale 1 (un hook nunca frena la sesion: exit 2 no se usa).
 * Sin WEZTERM_PANE (no es un pane de wezterm) no hay que registrar: exit 0.
 * Test seam: WEZBRIDGE_PANE_LIST_JSON reemplaza a `wezterm cli list`.
 */
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/pane-registry.cjs');

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (k === 'end') { o.end = true; continue; }
    o[k] = argv[i + 1]; i += 1;
  }
  return o;
}
function roleFor(cwd, explicit) {
  if (explicit) return String(explicit).trim();
  if (process.env.WEZBRIDGE_ROLE) return process.env.WEZBRIDGE_ROLE.trim();
  try {
    const first = fs.readFileSync(path.join(cwd, '.wezbridge-role'), 'utf8').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* no file */ }
  return path.basename(String(cwd).replace(/[/\\]+$/, '')).toLowerCase();
}
function livePanes() {
  if (process.env.WEZBRIDGE_PANE_LIST_JSON) {
    try { return JSON.parse(process.env.WEZBRIDGE_PANE_LIST_JSON); } catch { return null; }
  }
  try { return require('../src/wezterm.cjs').listPanes(); } catch { return null; }
}

function main() {
  const o = args(process.argv.slice(2));
  const payload = readStdinJson();
  const paneId = process.env.WEZTERM_PANE;
  if (!/^\d+$/.test(String(paneId || ''))) return 0; // no es un pane de wezterm: nada que registrar
  const event = String(payload.hook_event_name || '');
  if (o.end || event === 'SessionEnd') {
    registry.unregister({ paneId: Number(paneId) });
    return 0;
  }
  const cwd = o.cwd || payload.cwd || process.cwd();
  const agent = o.agent || (process.env.CLAUDECODE ? 'claude' : (process.env.CODEX_HOME || process.env.CODEX_SANDBOX ? 'codex' : 'shell'));
  try {
    const r = registry.register({
      role: roleFor(cwd, o.role), cwd, pid: process.ppid, agent, paneId: Number(paneId), list: livePanes(),
    });
    if (r.unverified) process.stderr.write(`pane-register: wezterm unreachable, registered pane ${paneId} as "${r.entry.role}" without uniqueness check\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`pane-register: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = { roleFor, main };
