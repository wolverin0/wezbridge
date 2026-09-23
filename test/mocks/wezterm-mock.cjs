#!/usr/bin/env node
'use strict';

const panes = {
  1: {
    id: '1',
    pane_id: 1,
    paneid: 1,
    tab_id: 1,
    window_id: 1,
    title: 'mock',
    cwd: '/tmp',
    is_active: true,
    pid: 12345,
  },
};
let nextPaneId = 2;

function write(value) {
  if (value !== undefined) process.stdout.write(value);
}

// T-0400: optional, OFF by default — records every invocation's argv (after
// list/cli/no-auto-start/prefer-mux would still be VISIBLE, they're only
// dropped from dispatch routing below) to a file, so a test can assert on the
// REAL argv that reached "wezterm" (e.g. that --prefer-mux was actually
// present) instead of grepping the caller's source for the literal. Inert
// unless WEZBRIDGE_MOCK_ARGV_LOG is set; every other test is unaffected.
if (process.env.WEZBRIDGE_MOCK_ARGV_LOG) {
  try {
    require('fs').appendFileSync(process.env.WEZBRIDGE_MOCK_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
  } catch { /* best effort — must never break the mock */ }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function createPane(args) {
  const paneId = nextPaneId++;
  const cwd = optionValue(args, '--cwd') || '/tmp';
  panes[paneId] = {
    id: String(paneId),
    pane_id: paneId,
    paneid: paneId,
    tab_id: 1,
    window_id: Number(optionValue(args, '--window-id')) || 1,
    title: 'mock',
    cwd,
    is_active: true,
    pid: 12345 + paneId,
  };
  return paneId;
}

function withoutGlobalOptions(args) {
  return args.filter((arg) => arg !== '--no-auto-start' && arg !== '--prefer-mux');
}

const args = withoutGlobalOptions(process.argv.slice(2));
const subcommand = args[0] === 'cli' ? args[1] : args[0];
const subArgs = args.slice(args[0] === 'cli' ? 2 : 1);

switch (subcommand) {
  case 'list-clients':
    write(JSON.stringify([{ client_id: 1, pid: 12345, executable: 'wezterm' }]));
    break;

  case 'list':
    write(JSON.stringify(Object.values(panes)));
    break;

  case 'split-pane':
  case 'spawn': {
    const paneId = createPane(subArgs);
    write(JSON.stringify({ pane_id: paneId }));
    break;
  }

  case 'send-text':
    process.stdin.resume();
    process.stdin.on('end', () => write(''));
    break;

  case 'get-text':
    write('mock output\n$');
    break;

  case 'kill-pane': {
    const paneId = optionValue(subArgs, '--pane-id');
    if (paneId) delete panes[paneId];
    break;
  }

  default:
    write('{}');
    break;
}
