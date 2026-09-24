'use strict';
require('./setup.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// T-0596 item 4: legacy WezTerm-pane queue delivery, gated off by default — opt in for this file.
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const pq = require('../src/project-queue.cjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't0355-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

for (const mode of ['working', 'composer', 'send-refusal']) {
  test(`busy ${mode}: next idle drain delivers without attempts or cooldown spent`, async t => {
    const base = fixture(t);
    let busy = true;
    let clock = Date.now();
    let writes = 0;
    let verifications = 0;
    const { id } = pq.enqueue({ project: 'sample', corr: mode, type: 'ack', body: 'received', ok: false }, { base });
    const consumer = pq.createConsumer({ base, project: 'sample', now: () => clock,
      discoverPanes: () => [{ paneId: 7, agent: 'claude', project: 'G:/x/sample', status: busy && mode === 'working' ? 'working' : 'idle' }],
      logAction: () => {},
      send: {
        paneComposerHoldsForeignText: () => busy && mode === 'composer',
        sendPromptDeferredEnter: async () => {
          if (busy && mode === 'send-refusal') return { refused: 'composer-foreign-text' };
          writes += 1;
          return 'ok';
        },
        verifyPromptSubmission: async () => { verifications += 1; return 'submitted'; },
      },
    });
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await consumer.drain()).delivered, 0);
      const pending = JSON.parse(fs.readFileSync(path.join(base, 'queues/state/sample/pending.json')));
      assert.equal(pending[id].attempts, 0);
      assert.equal(writes, 0);
      assert.equal(verifications, 0);
      clock += 1;
    }
    busy = false;
    assert.equal((await consumer.drain()).delivered, 1, 'idle drain must not wait five minutes after a refusal');
    assert.equal(writes, 1);
    assert.equal(verifications, 1);
    assert.equal((await consumer.drain()).delivered, 0);
  });
}

function pending(base, project, entries) {
  const dir = path.join(base, 'queues/state', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify(entries));
}

test('starvation: strict 30 minute boundary, oldest age, attempts and privacy', t => {
  const base = fixture(t);
  const now = Date.now();
  const entry = (minutes, attempts = 0) => ({ time: new Date(now - minutes * 60000).toISOString(), attempts, body: 'PRIVATE BODY' });
  pending(base, 'sample', { old: entry(90), stale: entry(31), boundary: entry(30), young: entry(5), attempted: entry(120, 1), invalid: { time: 'bad', attempts: 0 } });
  const { inspectInboxStarvation } = require('../src/inbox-health.cjs');
  const result = inspectInboxStarvation({ base, now });
  assert.equal(result.count, 2);
  assert.equal(result.oldest_age_ms, 90 * 60000);
  assert.match(result.alerts.join('\n'), /INBOX ESTANCADA.*2.*90 min/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY/);
});

test('starvation: absent state is empty, corrupt state is visible and other projects remain measured', t => {
  const base = fixture(t);
  const { inspectInboxStarvation } = require('../src/inbox-health.cjs');
  assert.equal(inspectInboxStarvation({ base }).count, 0);
  pending(base, 'broken', {});
  fs.writeFileSync(path.join(base, 'queues/state/broken/pending.json'), '{');
  pending(base, 'good', { old: { time: new Date(Date.now() - 3600000).toISOString(), attempts: 0 } });
  const result = inspectInboxStarvation({ base });
  assert.equal(result.count, 1);
  assert.ok(result.alerts.some(line => /broken/.test(line)));
});

test('bridge_health real MCP response includes INBOX ESTANCADA and unhealthy verdict', t => {
  const base = fixture(t);
  pending(base, 'sample', { old: { time: new Date(Date.now() - 3600000).toISOString(), attempts: 0 } });
  const response = spawnSync(process.execPath, ['--require', './test/setup.cjs', 'src/mcp-server.cjs'], {
    cwd: path.join(__dirname, '..'), windowsHide: true, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: base, DASHBOARD_PORT: '1' },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_health', arguments: {} } }) + '\n',
  });
  assert.equal(response.status, 0, response.stderr);
  const rpc = response.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 1);
  const health = JSON.parse(rpc.result.content[0].text);
  assert.ok(health.alerts.some(line => /INBOX ESTANCADA/.test(line)), JSON.stringify(health));
  assert.equal(health.inbox_starvation.count, 1);
  assert.equal(health.ok, false);
});
