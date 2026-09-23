#!/usr/bin/env node
'use strict';
/**
 * wezterm-fragmented-mock.cjs — a WEZTERM_BIN double for poke-pane.cjs that
 * deterministically reproduces a FRAGMENTED paste landing.
 *
 * WHY: test/mocks/wezterm-mock.cjs's `get-text` is a static "mock output\n$"
 * — no composer marker at all, so scripts/composer-state.cjs's
 * pasteLandedIntact() always reads it as 'empty', never 'fragmented'. This
 * double instead: BEFORE the paste, shows a plain readable shell prompt (so
 * poke-pane's pre-write foreign-text guard does not refuse); AFTER the paste
 * lands, shows a composer line holding text that is NOT the payload's head
 * (an unrelated fragment — the exact shape a --no-paste-style per-line submit
 * or foreign text left behind produces), which is what forces 'fragmented'.
 *
 * One pane, tab_title 'wb-frag-test' (poke-pane is invoked with
 * --tab-title wb-frag-test in the paired test). State persists across
 * per-call subprocess boundaries via WEZBRIDGE_MOCK_STATE (required).
 */
const fs = require('fs');

const STATE_FILE = process.env.WEZBRIDGE_MOCK_STATE;
function readState() {
  if (!STATE_FILE) return { sent: false };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { sent: false }; }
}
function writeState(s) {
  if (!STATE_FILE) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* best effort */ }
}

function write(value) {
  if (value !== undefined) process.stdout.write(value);
}
function optionValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 || i + 1 >= args.length ? null : args[i + 1];
}
function withoutGlobalOptions(args) {
  return args.filter((arg) => arg !== '--no-auto-start' && arg !== '--prefer-mux');
}

const args = withoutGlobalOptions(process.argv.slice(2));
const subcommand = args[0] === 'cli' ? args[1] : args[0];
const subArgs = args.slice(args[0] === 'cli' ? 2 : 1);
const hasNoPaste = subArgs.includes('--no-paste');

switch (subcommand) {
  case 'list':
    write(JSON.stringify([
      { id: '1', pane_id: 1, paneid: 1, tab_id: 1, window_id: 1, title: 'mock', tab_title: 'wb-frag-test', cwd: '/tmp/wb-frag-test', is_active: true, pid: 1 },
    ]));
    break;

  case 'send-text': {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      if (!hasNoPaste && input.trim().length > 0) writeState({ sent: true });
      write('');
    });
    break;
  }

  case 'get-text': {
    const state = readState();
    if (!state.sent) {
      // Plain shell, no composer marker: the pre-write foreign-text guard
      // must see nothing held and let poke-pane proceed.
      write('C:\\Users\\mock> \n$');
    } else {
      // Composer holds something, but NOT the payload's head — every landing
      // after a bracketed paste ("intact"/"collapsed") shows the head or a
      // "[Pasted text ...]" placeholder; this line is neither, so
      // pasteLandedIntact() must read it as 'fragmented'.
      write('──────────────────────────────\n❯ unrelated leftover fragment, not the payload head\n──────────────────────────────');
    }
    break;
  }

  case 'kill-pane':
    break;

  default:
    write('{}');
    break;
}
