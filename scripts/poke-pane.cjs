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
if ((!project && !tabTitle) || !text) {
  die(2, 'usage: (--project <name> | --tab-title <substr> | both) (--text "..." | --file <path>) [--dry-run]');
}

function liveSocketEnvironments() {
  if (process.env.WEZTERM_UNIX_SOCKET || process.platform !== 'win32') return [process.env];
  const socketDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'share', 'wezterm');
  try {
    const tasks = execFileSync('tasklist', ['/fi', 'imagename eq wezterm-gui.exe', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const socketNames = new Set(fs.readdirSync(socketDir));
    const sockets = [...tasks.matchAll(/"wezterm-gui\.exe","(\d+)"/gi)]
      .map((match) => `gui-sock-${match[1]}`)
      .filter((name) => socketNames.has(name))
      .map((name) => path.join(socketDir, name));
    if (sockets.length) {
      return sockets.map((socket) => ({ ...process.env, WEZTERM_UNIX_SOCKET: socket }));
    }
  } catch { /* the normal retry/failure path below records a distinct failure */ }
  return [process.env];
}

// ---------- resolve, at fire time, never from a stored id ----------
// `wezterm cli list` goes through the mux and keeps working when a per-GUI
// socket is unhappy, so it is the reliable half. Retry anyway: it ETIMEDOUTs
// under load (16 panes running test suites is enough).
let list = [];
let lastErr = '';
for (const socketEnv of liveSocketEnvironments()) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const panes = JSON.parse(execFileSync(WEZTERM, ['cli', '--no-auto-start', 'list', '--format', 'json'], {
        encoding: 'utf8', timeout: 20000, env: socketEnv, windowsHide: true,
      }));
      list.push(...panes.map((pane) => ({ ...pane, _socketEnv: socketEnv })));
      break;
    } catch (e) { lastErr = String(e.message || e).split('\n')[0]; }
  }
}
if (!list.length) die(3, `wezterm unreachable after 3 attempts: ${lastErr}`);

const wantedProject = project ? String(project).toLowerCase() : null;
const wantedTab = tabTitle ? String(tabTitle).toLowerCase() : null;
const seen = new Set();
const matches = [];
for (const p of list) {
  const socketKey = `${p._socketEnv.WEZTERM_UNIX_SOCKET || 'default'}:${p.pane_id}`;
  if (seen.has(socketKey)) continue;
  seen.add(socketKey);
  const cwd = decodeURIComponent(String(p.cwd || '')).replace(/^file:\/\/[^/]*/, '');
  const name = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
  if (wantedProject && name.toLowerCase() !== wantedProject) continue;
  // tab_title is the operator's own label; title is whatever the program set.
  if (wantedTab && !String(p.tab_title || '').toLowerCase().includes(wantedTab)) continue;
  matches.push({ ...p, cwd, name });
}

const criteria = [project && `project "${project}"`, tabTitle && `tab-title "${tabTitle}"`].filter(Boolean).join(' + ');
if (!matches.length) die(4, `no pane matching ${criteria}`);
if (matches.length > 1) {
  die(5, `ambiguous — ${matches.length} panes match ${criteria}: ${
    matches.map((m) => `pane ${m.pane_id} (win${m.window_id}/tab${m.tab_id}, "${(m.title || '').slice(0, 30)}")`).join(' | ')
  }. Refusing to guess.`);
}

const target = matches[0];
if (has('dry-run')) {
  console.log(`${new Date().toISOString()} poke-pane DRY-RUN: would send ${text.length} chars to pane ${target.pane_id} (win${target.window_id}/tab${target.tab_id}, ${target.cwd})`);
  process.exit(0);
}

function sendViaStdin(paneId, payload, socketEnv, { noPaste = true } = {}) {
  const args = ['cli', '--no-auto-start', 'send-text', '--pane-id', String(paneId)];
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
    ['cli', '--no-auto-start', 'get-text', '--pane-id', String(target.pane_id), '--start-line', '-40'],
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
