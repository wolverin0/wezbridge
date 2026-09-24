#!/usr/bin/env node
'use strict';
// orca-mock.cjs — T-0596: fake `orca` CLI for mcp-server integration tests,
// same spirit as wezterm-mock.cjs. Mirrors the three subcommands wezbridge
// actually calls: `terminal list --json`, `terminal send ... --json`, and
// `terminal read --screen --json`.
//
// Config (all via env, since execFile spawns a fresh process per call so
// nothing survives in memory across invocations):
//   ORCA_MOCK_TERMINALS  — path to a JSON file: array of {handle, title, worktreePath, connected}
//   ORCA_MOCK_STATE      — dir to persist per-handle "screen" state across calls
//   ORCA_MOCK_FAIL_HANDLE — optional: `terminal send` to this handle returns ok:false

const fs = require('fs');
const path = require('path');

function write(v) { process.stdout.write(v); }

function optionValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

function stateFile(handle) {
  return path.join(process.env.ORCA_MOCK_STATE, `${handle}.json`);
}

function loadState(handle) {
  try { return JSON.parse(fs.readFileSync(stateFile(handle), 'utf8')); } catch { return { tail: [], retryIds: [] }; }
}

function saveState(handle, s) {
  fs.mkdirSync(process.env.ORCA_MOCK_STATE, { recursive: true });
  fs.writeFileSync(stateFile(handle), JSON.stringify(s));
}

const args = process.argv.slice(2);
const [cmd, sub] = args;

if (cmd === 'terminal' && sub === 'list') {
  let terminals = [];
  try { terminals = JSON.parse(fs.readFileSync(process.env.ORCA_MOCK_TERMINALS, 'utf8')); } catch { /* empty census */ }
  write(JSON.stringify({ ok: true, result: { terminals } }));
} else if (cmd === 'terminal' && sub === 'send') {
  const handle = optionValue(args, '--terminal');
  const text = optionValue(args, '--text');
  const retryId = optionValue(args, '--retry-request');
  if (process.env.ORCA_MOCK_FAIL_HANDLE && handle === process.env.ORCA_MOCK_FAIL_HANDLE) {
    write(JSON.stringify({ ok: false, error: { message: 'mock: terminal not writable' } }));
  } else {
    const s = loadState(handle);
    if (!retryId || !s.retryIds.includes(retryId)) {
      s.tail.push(text);
      if (retryId) s.retryIds.push(retryId);
    }
    saveState(handle, s);
    write(JSON.stringify({ ok: true, result: { accepted: true } }));
  }
} else if (cmd === 'terminal' && sub === 'read') {
  const handle = optionValue(args, '--terminal');
  const s = loadState(handle);
  write(JSON.stringify({ ok: true, result: { terminal: { handle, status: 'running', tail: s.tail.slice(-40), source: 'screen' } } }));
} else {
  write(JSON.stringify({ ok: false, error: `orca-mock: unhandled ${args.join(' ')}` }));
}
