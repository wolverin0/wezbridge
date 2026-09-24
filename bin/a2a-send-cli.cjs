#!/usr/bin/env node
'use strict';
/**
 * a2a-send-cli.cjs — T-0596 paso 2: ONE wezbridge entry point for a2a_send,
 * usable from a plain shell (Python's subprocess, cron, a human). Every fleet
 * control that lives in mcp-server.cjs's a2a_send handler — dispatch gate,
 * result-shape check, lease, durable queue, self-send guard, audit — applies
 * here too, because this spawns the REAL mcp-server.cjs (JSON-RPC over stdio,
 * one tools/call, one response) instead of reimplementing any of it. This is
 * what scripts/orchestration/{task_router,notify_orchestrator,foreman}.py
 * now call instead of shelling out to `orca terminal send` directly, which
 * bypassed every one of those controls.
 * Key terms: main, callA2ASend.
 * Read when: a Python (or shell) caller needs to dispatch to a pane/terminal
 * and must go through the SAME control plane as an MCP a2a_send call.
 *
 * Usage:
 *   node bin/a2a-send-cli.cjs --to-project <name> --body <text> [--type request]
 *     [--corr <id>] [--from-pane <n>] [--from-project <name>] [--body-file <path>] [--allow-long]
 *   node bin/a2a-send-cli.cjs --to-pane <id> --body <text> ...
 *
 * Exit codes: 0 = delivered or durably queued (ok:true OR queued:true);
 * 1 = refused (isError:true) or neither delivered nor queued. The JSON
 * response from a2a_send is always printed to stdout, whatever the outcome —
 * scripting callers should parse it, not just check the exit code.
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.cjs');

function parseArgs(argv) {
  const out = { type: 'request' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--to-project': out.to_project = next(); break;
      case '--to-pane': out.to_pane = parseInt(next(), 10); break;
      case '--type': out.type = next(); break;
      case '--corr': out.corr = next(); break;
      case '--from-pane': out.from_pane = parseInt(next(), 10); break;
      case '--from-project': out.from_project = next(); break;
      case '--body': out.body = next(); break;
      case '--body-file': out.body = fs.readFileSync(next(), 'utf8'); break;
      case '--expected-cwd': out.expected_cwd = next(); break;
      case '--allow-long': out.allow_long = true; break;
      default:
        process.stderr.write(`a2a-send-cli: unknown argument ${a}\n`);
        process.exit(2);
    }
  }
  return out;
}

/** Spawn the real mcp-server.cjs and make exactly one a2a_send tools/call. */
function callA2ASend(args, { entry = ENTRY, env = process.env, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`a2a-send-cli: mcp-server timed out after ${timeoutMs}ms; stderr=${stderr.slice(0, 500)}`));
    }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      const line = stdout.slice(0, nl).trim();
      child.stdin.end();
      child.kill('SIGTERM');
      try { resolve(JSON.parse(line)); }
      catch (err) { reject(new Error(`a2a-send-cli: invalid JSON from mcp-server: ${err.message}; stdout=${stdout}; stderr=${stderr.slice(0, 500)}`)); }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a2a_send', arguments: args } })}\n`);
  });
}

async function main(argv = process.argv.slice(2), { entry, env } = {}) {
  const args = parseArgs(argv);
  if (!args.body || !String(args.body).trim()) {
    process.stderr.write('a2a-send-cli: --body (or --body-file) is required\n');
    return 2;
  }
  if (!args.to_project && !Number.isInteger(args.to_pane)) {
    process.stderr.write('a2a-send-cli: pass --to-project <name> or --to-pane <id>\n');
    return 2;
  }
  const res = await callA2ASend(args, { entry, env });
  const content = res && res.result && res.result.content && res.result.content[0];
  const text = content ? content.text : JSON.stringify(res);
  process.stdout.write(`${text}\n`);
  if (res && res.result && res.result.isError) return 1;
  try {
    const payload = JSON.parse(text);
    return (payload.ok || payload.queued) ? 0 : 1;
  } catch { return 1; }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`a2a-send-cli: fatal: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, callA2ASend };
