#!/usr/bin/env node
'use strict';
/**
 * wezterm-echo-mock.cjs — a WEZBRIDGE_WEZTERM_BIN double that ECHOES back
 * whatever text was last pasted into a pane, as plain scrollback (no `❯`
 * composer marker).
 *
 * WHY: test/mocks/wezterm-mock.cjs's `get-text` is a static
 * "mock output\n$" — good enough for tests that only need a live pane to
 * exist, useless for anything that must observe a VERIFIED delivery
 * (src/verified-send.cjs's composerHoldsTail() checks that the pane's
 * rendered text contains the tail of what was just sent; a static mock can
 * never satisfy that, so `delivered` is always 'truncated' against it).
 *
 * This mock makes that path real: a bracketed-paste `send-text` (no
 * `--no-paste`) with non-blank stdin is recorded as "the pane's content";
 * subsequent `get-text` calls echo it back with no `❯` marker (so
 * inputBoxContent() sees no composer line — verifyPromptSubmission reads
 * that as NOT stuck, i.e. 'submitted'). A bare Enter/unstick write
 * (`--no-paste`) does NOT overwrite the recorded text — an Enter clears a
 * composer in real wezterm, it does not retroactively un-echo the scrollback.
 *
 * State is a JSON file at WEZBRIDGE_MOCK_ECHO_STATE (required) because each
 * `wezterm cli ...` call is a FRESH node process — nothing here persists
 * in-memory across invocations.
 */
const fs = require('fs');

const STATE_FILE = process.env.WEZBRIDGE_MOCK_ECHO_STATE;

function readState() {
  if (!STATE_FILE) return { text: '' };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { text: '' }; }
}
function writeState(s) {
  if (!STATE_FILE) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* best effort */ }
}

function write(value) {
  if (value !== undefined) process.stdout.write(value);
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
      { id: '1', pane_id: 1, paneid: 1, tab_id: 1, window_id: 1, title: 'mock', cwd: '/tmp', is_active: true, pid: 1 },
    ]));
    break;

  case 'send-text': {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      // A bracketed paste (no --no-paste) with real content is "typed into
      // the pane" and becomes what get-text echoes. A bare Enter/unstick
      // write (--no-paste, blank or '\r') must NOT overwrite it — that is
      // exactly the distinction verifyPromptSubmission/composerHoldsTail rely
      // on (paste lands, THEN a separate Enter submits it).
      if (!hasNoPaste && input.trim().length > 0) writeState({ text: input });
      write('');
    });
    break;
  }

  case 'get-text': {
    const state = readState();
    write(`${state.text || ''}\n$ `);
    break;
  }

  case 'kill-pane':
    break;

  default:
    write('{}');
    break;
}
