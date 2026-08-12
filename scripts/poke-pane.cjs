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
 * Exit codes:  0 sent · 2 bad usage · 3 wezterm unreachable · 4 no match ·
 *              5 ambiguous · 6 send failed
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

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

// ---------- resolve, at fire time, never from a stored id ----------
// `wezterm cli list` goes through the mux and keeps working when a per-GUI
// socket is unhappy, so it is the reliable half. Retry anyway: it ETIMEDOUTs
// under load (16 panes running test suites is enough).
let list = null;
let lastErr = '';
for (let i = 0; i < 3; i += 1) {
  try {
    list = JSON.parse(execFileSync(WEZTERM, ['cli', 'list', '--format', 'json'],
      { encoding: 'utf8', timeout: 20000 }));
    break;
  } catch (e) { lastErr = String(e.message || e).split('\n')[0]; }
}
if (!list) die(3, `wezterm unreachable after 3 attempts: ${lastErr}`);

const wantedProject = project ? String(project).toLowerCase() : null;
const wantedTab = tabTitle ? String(tabTitle).toLowerCase() : null;
const seen = new Set();
const matches = [];
for (const p of list) {
  if (seen.has(p.pane_id)) continue;
  seen.add(p.pane_id);
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

// ---------- send ----------
// --no-paste: bracketed paste makes some TUIs hold the text without accepting
// it. The CR is a SEPARATE call for the same reason — a trailing \r inside the
// payload is swallowed by composers that treat the paste as one atom.
try {
  execFileSync(WEZTERM, ['cli', 'send-text', '--pane-id', String(target.pane_id), '--no-paste', text],
    { encoding: 'utf8', timeout: 20000 });
  execFileSync(WEZTERM, ['cli', 'send-text', '--pane-id', String(target.pane_id), '--no-paste', '\r'],
    { encoding: 'utf8', timeout: 20000 });
} catch (e) {
  die(6, `send to pane ${target.pane_id} failed: ${String(e.message || e).split('\n')[0]}`);
}

// ---------- verify, and be honest when we cannot ----------
// A send returning success is NOT proof of delivery. If the read-back fails we
// say UNVERIFIED rather than claiming it landed.
let verified = 'UNVERIFIED (read-back unavailable)';
try {
  const tail = execFileSync(WEZTERM, ['cli', 'get-text', '--pane-id', String(target.pane_id), '--start-line', '-40'],
    { encoding: 'utf8', timeout: 20000 });
  // A TUI WRAPS the text it received, so a contiguous substring match fails on
  // every message longer than the pane is wide — which reported UNVERIFIED for
  // a message sitting visibly in the composer. Collapse all whitespace on both
  // sides first; then wrapping, indentation and the composer's gutter stop
  // mattering. A verifier that cries wolf on healthy sends gets ignored, which
  // is worse than not having one.
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const probe = flat(text).slice(0, 60);
  verified = probe && flat(tail).includes(probe)
    ? 'VERIFIED (echo found in pane)'
    : 'UNVERIFIED (echo not found)';
} catch { /* leave as unavailable */ }

console.log(`${new Date().toISOString()} poke-pane OK: ${text.length} chars -> pane ${target.pane_id} (${target.name}, win${target.window_id}/tab${target.tab_id}) — ${verified}`);
