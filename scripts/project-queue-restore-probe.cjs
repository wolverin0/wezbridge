#!/usr/bin/env node
'use strict';
// T-0377 finite live proof. Own Unix socket, pid/log files and data-only PTYs.
// Config contract: https://wezterm.org/multiplexing.html#unix-domains
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { projectFromCwd } = require('../src/pane-identity.cjs');
const CLI = ['cli', '--prefer-mux', '--no-auto-start'];
const PROJECTS = ['bajoneando', 'whatsappbot-final', 'omniremote'];
let activeMux = null;

function prepare(root) {
  assert.equal(process.env.T0377_LIVE_PROBE, '1', 'explicit live probe opt-in required');
  assert.ok(!fs.existsSync(root), 'use a new owned output directory');
  fs.mkdirSync(root, { recursive: true });
  for (const project of PROJECTS) {
    fs.mkdirSync(path.join(root, project));
    fs.writeFileSync(path.join(root, project, 'T0377-OWNED'), 'data-only receiver');
  }
  const socket = path.join(root, 'sock'), config = path.join(root, 'config.lua');
  const quote = value => JSON.stringify(value.replace(/\\/g, '/'));
  fs.writeFileSync(config, `return {
    unix_domains={{name='t0377-probe',socket_path=${quote(socket)},no_serve_automatically=true}},
    daemon_options={pid_file=${quote(path.join(root, 'pid'))},stdout=${quote(path.join(root, 'stdout'))},stderr=${quote(path.join(root, 'stderr'))}},
    automatically_reload_config=false, ssh_domains={}
  }\n`);
  const env = { ...process.env, WEZTERM_UNIX_SOCKET: socket };
  delete env.WEZTERM_PANE; delete env.NODE_OPTIONS; delete env.WEZBRIDGE_WEZTERM_BIN;
  process.env.WEZBRIDGE_INTEL_DIR = path.join(root, 'advisory-intel');
  return { root, socket, config, env, token: crypto.randomUUID(), receiver: path.resolve(__dirname, 't0377-live-receiver.cjs'),
    wez: 'C:/Program Files/WezTerm/wezterm.exe', mux: 'C:/Program Files/WezTerm/wezterm-mux-server.exe' };
}

function cli(ctx, args, options = {}) {
  return execFileSync(ctx.wez, ['--config-file', ctx.config, ...CLI, ...args], {
    env: ctx.env, encoding: 'utf8', timeout: 5000, windowsHide: true, ...options }).trim();
}

function census(ctx) {
  return JSON.parse(cli(ctx, ['list', '--format', 'json'])).map(pane => ({ ...pane,
    paneId: pane.pane_id, project: pane.cwd, canonical: projectFromCwd(pane.cwd),
    agent: 'data-only-test-receiver', status: 'idle', tabTitle: pane.tab_title }));
}

async function until(predicate, message, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (predicate()) return; } catch { /* startup/PTY readiness may lag */ }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(message);
}

async function start(ctx, epoch, firstProject) {
  assert.equal(activeMux, null, 'one owned mux at a time');
  const stdout = fs.openSync(path.join(ctx.root, epoch + '-stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(ctx.root, epoch + '-stderr.log'), 'wx');
  activeMux = spawn(ctx.mux, ['--config-file', ctx.config, '--cwd', path.join(ctx.root, firstProject),
    process.execPath, ctx.receiver, '--t0377-run=' + ctx.token], { env: { ...ctx.env, T0377_EPOCH: epoch },
    windowsHide: true, stdio: ['ignore', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  await until(() => census(ctx).some(pane => pane.canonical === firstProject), 'owned mux did not become ready');
  fs.appendFileSync(path.join(ctx.root, 'observations.jsonl'), JSON.stringify({
    event: 'mux.started', epoch, pid: activeMux.pid, panes: census(ctx) }) + '\n');
  return activeMux.pid;
}

function live(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function receiverPids(ctx) {
  return PROJECTS.flatMap(project => fs.readdirSync(path.join(ctx.root, project))
    .filter(name => /^ready-\d+\.json$/.test(name)).map(name => {
      const record = JSON.parse(fs.readFileSync(path.join(ctx.root, project, name), 'utf8'));
      assert.equal(path.resolve(record.cwd), path.resolve(ctx.root, project));
      assert.equal(name, `ready-${record.pid}.json`);
      return record.pid;
    }));
}

function ownedReceiverPids(ctx) {
  // Windows can reuse exited PIDs. Match the unique launch token in the live
  // command line instead of killing a PID merely because an old receipt names it.
  const query = "@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { "
    + "$_.CommandLine -and $_.CommandLine.Contains($env:T0377_PROCESS_MARKER) "
    + "-and $_.CommandLine.Contains('t0377-live-receiver.cjs') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', query], {
    env: { ...ctx.env, T0377_PROCESS_MARKER: '--t0377-run=' + ctx.token },
    encoding: 'utf8', timeout: 7000, windowsHide: true }).trim();
  const parsed = output ? JSON.parse(output) : [];
  const ids = Array.isArray(parsed) ? parsed : [parsed];
  assert.ok(ids.every(id => Number.isInteger(id) && id > 0));
  return ids;
}

async function stop(ctx) {
  if (activeMux) {
    const proc = activeMux;
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await until(() => proc.exitCode !== null || proc.signalCode !== null, 'owned mux did not stop');
    fs.appendFileSync(path.join(ctx.root, 'observations.jsonl'), JSON.stringify({ event: 'mux.stopped', pid: proc.pid }) + '\n');
    activeMux = null;
  }
  // ConPTY EOF normally closes these children; only a live matching launch
  // token permits cleanup of a receiver that outlives its mux.
  for (const pid of ownedReceiverPids(ctx)) if (live(pid)) process.kill(pid, 'SIGKILL');
  await until(() => ownedReceiverPids(ctx).length === 0, 'owned receiver remained alive');
}

async function newPane(ctx, project) {
  const id = Number(cli(ctx, ['spawn', '--new-window', '--cwd', path.join(ctx.root, project),
    '--', process.execPath, ctx.receiver, '--t0377-run=' + ctx.token]));
  assert.ok(Number.isInteger(id));
  await until(() => census(ctx).some(pane => pane.paneId === id && pane.canonical === project), 'new receiver not ready');
  return id;
}

function received(ctx, project) {
  assert.ok(PROJECTS.includes(project), 'never read a foreign receiver directory');
  return fs.readdirSync(path.join(ctx.root, project)).filter(name => /^received-\d+\.jsonl$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(ctx.root, project, name), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line).line)).join('\n');
}

function sender(ctx, onSend = async () => {}) {
  let records = [], receipts = {};
  return { records: () => records.slice(),
    sendPromptDeferredEnter: async (paneId, text) => {
      const actual = census(ctx).find(pane => pane.paneId === paneId);
      assert.ok(actual && PROJECTS.includes(actual.canonical), 'target must be in the owned mux');
      cli(ctx, ['send-text', '--pane-id', String(paneId), '--no-paste'], { input: text.replace(/\r?\n/g, '\r') + '\r' });
      await until(() => received(ctx, actual.canonical).includes(text.trim()), 'receiver did not record complete envelope');
      const expected = text.match(/ to ([^|]+) \| corr=/)?.[1].trim();
      records = [...records, { paneId, expected, actual: actual.canonical,
        sha256: crypto.createHash('sha256').update(text).digest('hex') }];
      receipts = { ...receipts, [text]: true };
      await onSend(records.length);
      return 'ok';
    },
    verifyPromptSubmission: async (_paneId, text) => receipts[text] ? 'submitted' : 'stuck' };
}

function queue(pq, ctx, name, project, oldPane, bodies) {
  const base = path.join(ctx.root, name);
  for (const body of bodies) assert.equal(pq.enqueue({ project, resolved_pane: oldPane,
    from_project: 'T0377-live-probe', type: 'request', corr: 'T0377-' + body, ok: false,
    body: 'T0377 harmless marker: ' + body }, { base }).ok, true);
  return base;
}

function consumer(pq, ctx, base, project, send) {
  return pq.createConsumer({ base, project, discoverPanes: () => census(ctx), send,
    cooldownMs: 0, logAction: () => {},
    log: line => fs.appendFileSync(path.join(ctx.root, 'consumer.log'), line + '\n') });
}

async function restoredBatch(ctx, pq) {
  const beforePid = await start(ctx, 'before', 'bajoneando');
  await newPane(ctx, 'whatsappbot-final');
  const before = census(ctx);
  const oldBaja = before.find(pane => pane.canonical === 'bajoneando').paneId;
  const oldWabot = before.find(pane => pane.canonical === 'whatsappbot-final').paneId;
  const base = queue(pq, ctx, 'queued-before-restore', 'bajoneando', oldBaja, ['route-sweep', 'legal']);
  queue(pq, ctx, 'queued-before-restore', 'whatsappbot-final', oldWabot, ['vm-report']);
  await stop(ctx);
  const afterPid = await start(ctx, 'restored', 'omniremote');
  await newPane(ctx, 'omniremote');
  await newPane(ctx, 'bajoneando'); await newPane(ctx, 'whatsappbot-final');
  const after = census(ctx);
  assert.notEqual(beforePid, afterPid);
  for (const id of [oldBaja, oldWabot]) assert.equal(after.find(pane => pane.paneId === id).canonical, 'omniremote');
  const send = sender(ctx);
  await consumer(pq, ctx, base, 'bajoneando', send).drain();
  await consumer(pq, ctx, base, 'whatsappbot-final', send).drain();
  assert.equal(send.records().length, 3);
  assert.ok(send.records().every(record => record.actual === record.expected));
  assert.equal(received(ctx, 'omniremote'), '');
  return { beforePid, afterPid, before, after, deliveries: send.records() };
}

async function midBatchRestore(ctx, pq) {
  const initial = census(ctx).find(pane => pane.canonical === 'bajoneando').paneId;
  const base = queue(pq, ctx, 'queued-mid-batch', 'bajoneando', initial, ['batch-first', 'batch-second']);
  const send = sender(ctx, async count => {
    if (count !== 1) return;
    await stop(ctx); await start(ctx, 'mid-batch-restored', 'omniremote');
    await newPane(ctx, 'omniremote'); await newPane(ctx, 'omniremote');
    await newPane(ctx, 'bajoneando'); await newPane(ctx, 'whatsappbot-final');
    assert.equal(census(ctx).find(pane => pane.paneId === initial).canonical, 'omniremote');
  });
  await consumer(pq, ctx, base, 'bajoneando', send).drain();
  assert.equal(send.records().length, 2);
  assert.ok(send.records().every(record => record.actual === record.expected));
  assert.notEqual(send.records()[0].paneId, send.records()[1].paneId);
  assert.equal(received(ctx, 'omniremote'), '');
  return { deliveries: send.records(), after: census(ctx) };
}

async function missingProject(ctx, pq) {
  const base = queue(pq, ctx, 'queued-missing', 'missing-project', 0, ['never-deliver']);
  const send = sender(ctx);
  const result = await consumer(pq, ctx, base, 'missing-project', send).drain();
  const events = fs.readFileSync(path.join(base, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(result.dropped, 1); assert.equal(result.pending, 0);
  assert.equal(send.records().length, 0);
  assert.ok(events.some(event => event.event === 'queue.entry_dropped' && event.reason === 'project-not-live'));
  return { result, events };
}

async function main() {
  assert.ok(process.argv[2], 'usage: T0377_LIVE_PROBE=1 node scripts/project-queue-restore-probe.cjs <new-output-directory>');
  const ctx = prepare(path.resolve(process.argv[2]));
  const pq = require('../src/project-queue.cjs');
  let report = { startedAt: new Date().toISOString(), live: true, isolatedMux: true,
    sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../src/project-queue.cjs'))).digest('hex') };
  try {
    report = { ...report, restoredBatch: await restoredBatch(ctx, pq) };
    report = { ...report, midBatchRestore: await midBatchRestore(ctx, pq) };
    report = { ...report, missingProject: await missingProject(ctx, pq), pass: true, foreignDeliveries: 0 };
  } catch (error) { report = { ...report, pass: false, error: error.stack }; process.exitCode = 1; }
  finally {
    try {
      await stop(ctx);
      report = { ...report, cleanup: 'owned mux and receivers stopped', cleanupProof: {
        launchToken: ctx.token, recordedReceiverPids: receiverPids(ctx), activeOwnedReceiverPids: ownedReceiverPids(ctx) } };
    }
    catch (error) { report = { ...report, pass: false, cleanupError: error.message }; process.exitCode = 1; }
    fs.writeFileSync(path.join(ctx.root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: path.join(ctx.root, 'report.json'), pass: report.pass,
      foreignDeliveries: report.foreignDeliveries, cleanup: report.cleanup, error: report.error }));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
