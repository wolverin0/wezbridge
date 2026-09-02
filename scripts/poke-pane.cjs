#!/usr/bin/env node
/**
 * poke-pane — send text to a pane, resolved BY PROJECT, from a scheduled task.
 *
 * There is no model in this path. Finding the pane that owns a project and
 * typing into it is a deterministic transform, so it is plain code: no MCP, no
 * `claude -p`, no API call, nothing to rate-limit and nothing to hallucinate.
 *
 *   node scripts/poke-pane.cjs --project brlite --text "do the thing"
 *   node scripts/poke-pane.cjs --project brlite --file msg.txt
 *   node scripts/poke-pane.cjs --project brlite --text "..." --dry-run
 *
 * WHY BY PROJECT AND NOT BY PANE ID: pane ids are reused and reassigned. A
 * scheduled job holding a stored id eventually poked a completely unrelated
 * project (2026-08-12: a whatsappbot job landed in the brlite lane). Resolution
 * happens at fire time, every time.
 *
 * AMBIGUITY IS A FAILURE, NOT A COIN FLIP: if two panes match the project, this
 * exits non-zero and names both rather than guessing. Guessing is how the wrong
 * agent gets a payment-adjacent task.
 *
 * Exit codes:  0 submitted · 2 bad usage · 3 wezterm unreachable · 4 no match ·
 *              5 ambiguous · 6 send failed · 7 submit remained stuck
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WEZTERM = process.env.WEZTERM_BIN || 'wezterm';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);

function die(code, msg) {
  // One line, always, on every path. A scheduled job that fails silently is
  // indistinguishable from one that ran and found nothing to do — that is the
  // failure mode this whole script exists to avoid.
  console.log(`${new Date().toISOString()} poke-pane FAIL(${code}): ${msg}`);
  process.exit(code);
}

const project = arg('project');
// --tab-title is the BEST selector for a machine that must find one specific
// pane: the operator names the tab (LEADER-free, just rename it) and the name
// is his, stable, and survives pane renumbering. Six panes currently share the
// cwd basename "whatsappbot-final"; exactly one is named "wabot".
const tabTitle = arg('tab-title');
const text = arg('file') ? fs.readFileSync(arg('file'), 'utf8') : arg('text');
if (require.main === module && ((!project && !tabTitle) || !text)) {
  die(2, 'usage: (--project <name> | --tab-title <exact-name> | both) (--text "..." | --file <path>) [--dry-run]');
}

// T-0260 (2026-09-02): UN solo espacio de pane_id, el del mux. Medido: el mismo
// pane era 11 en `sock` y 4 en un gui-sock, y la GUI se reemplazo 17+ veces en
// un dia; resolver contra la GUI viva del minuto produjo 4 misroutes reales.
// `--prefer-mux` solo no alcanza si WEZTERM_UNIX_SOCKET apunta a un gui-sock,
// asi que el env del mux fija el socket y borra WEZTERM_PANE. Las GUIs quedan
// como fallback SOLO para una pane que no exista en el mux (spawneada fuera del
// dominio), y la salida lo dice.
const CLI_BASE = ['cli', '--prefer-mux', '--no-auto-start'];
const SOCKET_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'share', 'wezterm');
function muxEnvironment() {
  const env = { ...process.env };
  delete env.WEZTERM_PANE;
  // `sock` es un AF_UNIX socket: fs.existsSync dice false en Windows; readdirSync lo lista.
  let hasMux = false;
  try { hasMux = fs.readdirSync(SOCKET_DIR).includes('sock'); } catch { hasMux = false; }
  if (hasMux) env.WEZTERM_UNIX_SOCKET = path.join(SOCKET_DIR, 'sock');
  env._space = 'mux';
  return env;
}
function guiSocketEnvironments() {
  if (process.platform !== 'win32') return [];
  try {
    const tasks = execFileSync('tasklist', ['/fi', 'imagename eq wezterm-gui.exe', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const socketNames = new Set(fs.readdirSync(SOCKET_DIR));
    return [...tasks.matchAll(/"wezterm-gui\.exe","(\d+)"/gi)]
      .map((match) => `gui-sock-${match[1]}`)
      .filter((name) => socketNames.has(name))
      .map((name) => ({ ...process.env, WEZTERM_UNIX_SOCKET: path.join(SOCKET_DIR, name), _space: 'gui' }));
  } catch { return []; }
}
function liveSocketEnvironments() {
  if (process.env.WEZBRIDGE_PREFER_MUX === '0') return [...guiSocketEnvironments(), muxEnvironment()];
  return [muxEnvironment(), ...guiSocketEnvironments()];
}

/**
 * Elige el pane destino entre las filas listadas. Pura, para testearla.
 *  - --project: basename del cwd, igualdad case-insensitive.
 *  - --tab-title: igualdad EXACTA case-insensitive (T-0260 item 3: antes era
 *    substring, y "infra" matcheaba "infra-old"; la ambiguedad tiene que ser
 *    error, nunca "el primero").
 *  - Espacio: si hay matches en el mux, las filas de GUI se ignoran (son la
 *    misma pane con otro id); las filas de GUI solo cuentan cuando NINGUNA del
 *    mux matchea (pane gui-only).
 * Devuelve { matches, space }.
 */
function selectPane(list, { project = null, tabTitle = null } = {}) {
  const wantedProject = project ? String(project).toLowerCase() : null;
  const wantedTab = tabTitle ? String(tabTitle).trim().toLowerCase() : null;
  const seen = new Set();
  const all = [];
  for (const p of list) {
    const space = (p._socketEnv && p._socketEnv._space) || 'mux';
    const socketKey = `${(p._socketEnv && p._socketEnv.WEZTERM_UNIX_SOCKET) || 'default'}:${p.pane_id}`;
    if (seen.has(socketKey)) continue;
    seen.add(socketKey);
    const cwd = decodeURIComponent(String(p.cwd || '')).replace(/^file:\/\/[^/]*/, '');
    const name = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    if (wantedProject && name.toLowerCase() !== wantedProject) continue;
    if (wantedTab && String(p.tab_title || '').trim().toLowerCase() !== wantedTab) continue;
    all.push({ ...p, cwd, name, _space: space });
  }
  const mux = all.filter((m) => m._space === 'mux');
  if (mux.length) return { matches: mux, space: 'mux' };
  return { matches: all, space: all.length ? 'gui-only' : 'none' };
}

module.exports = { selectPane, CLI_BASE };
if (require.main !== module) return;

// ---------- resolve, at fire time, never from a stored id ----------
// `wezterm cli list` goes through the mux and keeps working when a per-GUI
// socket is unhappy, so it is the reliable half. Retry anyway: it ETIMEDOUTs
// under load (16 panes running test suites is enough).
let list = [];
let lastErr = '';
for (const socketEnv of liveSocketEnvironments()) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const panes = JSON.parse(execFileSync(WEZTERM, [...CLI_BASE, 'list', '--format', 'json'], {
        encoding: 'utf8', timeout: 20000, env: socketEnv, windowsHide: true,
      }));
      list.push(...panes.map((pane) => ({ ...pane, _socketEnv: socketEnv })));
      break;
    } catch (e) { lastErr = String(e.message || e).split('\n')[0]; }
  }
}
if (!list.length) die(3, `wezterm unreachable after 3 attempts: ${lastErr}`);

const { matches, space } = selectPane(list, { project, tabTitle });

const criteria = [project && `project "${project}"`, tabTitle && `tab-title "${tabTitle}" (exact)`].filter(Boolean).join(' + ');
if (!matches.length) die(4, `no pane matching ${criteria}`);
if (matches.length > 1) {
  die(5, `ambiguous — ${matches.length} panes match ${criteria} in space ${space}: ${
    matches.map((m) => `pane ${m.pane_id} (win${m.window_id}/tab${m.tab_id}, tab_title "${m.tab_title || ''}", "${(m.title || '').slice(0, 30)}")`).join(' | ')
  }. Refusing to guess.`);
}

const target = matches[0];
if (space === 'gui-only') {
  console.log(`${new Date().toISOString()} poke-pane NOTE: pane ${target.pane_id} exists only on a GUI socket (not in the mux): id is NOT in the canonical space`);
}
if (has('dry-run')) {
  console.log(`${new Date().toISOString()} poke-pane DRY-RUN: would send ${text.length} chars to pane ${target.pane_id} [${space}] (win${target.window_id}/tab${target.tab_id}, ${target.cwd})`);
  process.exit(0);
}

function sendViaStdin(paneId, payload, socketEnv, { noPaste = true } = {}) {
  const args = [...CLI_BASE, 'send-text', '--pane-id', String(paneId)];
  if (noPaste) args.push('--no-paste');
  execFileSync(WEZTERM, args, {
    input: payload,
    encoding: 'utf8',
    timeout: 20000,
    env: socketEnv,
    windowsHide: true,
  });
}

function composerStillHolds(tail, payload) {
  const flat = (value) => String(value).replace(/\s+/g, ' ').trim().toLowerCase();
  const probe = flat(payload).slice(0, 60);
  if (!probe) return false;
  const lines = String(tail).split(/\r?\n/);
  const markers = lines.filter((line) => /^[\s│|]*[❯>›]/u.test(line));
  const last = markers.at(-1) || '';
  const content = flat(last.replace(/^[\s│|]*[❯>›]\s*/u, ''));
  return Boolean(content) && (
    probe.startsWith(content.slice(0, 40)) ||
    content.startsWith(probe.slice(0, 40)) ||
    (content.length >= 8 && flat(payload).includes(content.slice(0, 60))) ||
    /\[?pasted (text|content)|\+\s*\d+\s+lines?\]?/i.test(content)
  );
}

// ---------- send ----------
// --no-paste: bracketed paste makes some TUIs hold the text without accepting
// it. The CR is a SEPARATE stdin write for the same reason — on Windows a
// control character passed as an argv element can be swallowed before wezterm
// sees it. A successful send-text exit is not submission proof, so read the
// live composer and nudge Enter once more if the prompt is still sitting there.
try {
  sendViaStdin(target.pane_id, text, target._socketEnv);
  sendViaStdin(target.pane_id, '\r', target._socketEnv);
} catch (e) {
  die(6, `send to pane ${target.pane_id} failed: ${String(e.message || e).split('\n')[0]}`);
}

// ---------- verify actual submission, not mere echo ----------
const verified = 'VERIFIED (composer cleared)';
try {
  const readTail = () => execFileSync(
    WEZTERM,
    [...CLI_BASE, 'get-text', '--pane-id', String(target.pane_id), '--start-line', '-40'],
    { encoding: 'utf8', timeout: 20000, env: target._socketEnv, windowsHide: true },
  );
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  let tail = readTail();
  if (composerStillHolds(tail, text)) {
    sendViaStdin(target.pane_id, '\r', target._socketEnv);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
    tail = readTail();
  }
  if (composerStillHolds(tail, text)) {
    die(7, `prompt remained in pane ${target.pane_id} composer after two Enter writes`);
  }
} catch (e) {
  if (e && typeof e === 'object' && e.status === 7) process.exit(7);
  die(8, `composer verification unavailable for pane ${target.pane_id}: ${String(e.message || e).split('\n')[0]}`);
}

console.log(`${new Date().toISOString()} poke-pane OK: ${text.length} chars -> pane ${target.pane_id} (${target.name}, win${target.window_id}/tab${target.tab_id}) — ${verified}`);
