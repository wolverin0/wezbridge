'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDaemonCli, killProcessTree } = require('../src/daemon-cli.cjs');
const workerPath = path.join(__dirname, 'fixtures/daemon-cli-task.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('T-0379 deadline rejects without waiting for inherited output and kills its owned process tree', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-cli-deadline-'));
  const file = path.join(dir, 'pids.jsonl');
  const rows = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  t.after(() => {
    for (const row of rows()) if (alive(row.pid)) killProcessTree(row.pid);
    assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true });
  });
  const cli = createDaemonCli({ timeoutMs: 800, workerPath });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 30);
  const started = Date.now();
  try { await assert.rejects(cli.wez.getFullText('hang', file), { code: 'DAEMON_CLI_TIMEOUT' }); }
  finally { clearInterval(timer); }
  assert.ok(Date.now() - started < 2500, 'deadline cannot await child exit or inherited-pipe EOF');
  assert.ok(ticks >= 5, 'the main event loop must keep ticking');
  assert.deepEqual(rows().map(row => row.role).sort(), ['grandchild', 'worker'], 'the held descendant must really exist');
  for (let i = 0; i < 40 && rows().some(row => alive(row.pid)); i++) await sleep(100);
  assert.equal(rows().some(row => alive(row.pid)), false, 'both owned processes must die');
  assert.equal(cli.status().active, 0);
  assert.equal(await cli.wez.getFullText('echo'), 'worker result', 'a timeout must not poison the next operation');
});

test('T-0379 daemon owner cannot fall back to synchronous CLI execution', t => {
  const previous = process.env.WEZBRIDGE_DAEMON_OWNER_PID;
  process.env.WEZBRIDGE_DAEMON_OWNER_PID = String(process.pid);
  t.after(() => {
    if (previous === undefined) delete process.env.WEZBRIDGE_DAEMON_OWNER_PID;
    else process.env.WEZBRIDGE_DAEMON_OWNER_PID = previous;
  });
  const wez = require('../src/wezterm.cjs');
  assert.throws(() => wez.getFullText(9137, 35), /DAEMON_SYNC_CLI_DISABLED/);
  assert.throws(() => wez.sendTextNoEnter(9137, 'fixture'), /DAEMON_SYNC_CLI_DISABLED/);
});
