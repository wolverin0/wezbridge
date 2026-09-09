'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkSpHeartbeat, heartbeatStatus, heartbeatSender, STALE_MS } = require('../scripts/sp-bridge-heartbeat.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-heartbeat-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, '.sp-bridge'));
  return dir;
}

test('T-0408 killer: scheduled sentinel writes sp-bridge.stale for an old last-success file', t => {
  const dir = fixture(t);
  const ts = new Date(Date.now() - 16 * 60000).toISOString();
  fs.writeFileSync(path.join(dir, '.sp-bridge/last-success.json'), JSON.stringify({ ts }));
  fs.writeFileSync(path.join(dir, '.daemon-heartbeat.json'), JSON.stringify({ ts }));
  const run = spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures/sentinel-observation.cjs'),
    path.join(__dirname, '../scripts/daemon-heartbeat-sentinel.cjs')], {
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: dir, SENTINEL_FIXTURE_MODE: 'during-probe',
      WEZBRIDGE_EVENTS_URL: '', PERSONALDASHBOARD_EVENTS_HMAC_SECRET: '' },
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const file = path.join(dir, 'events.jsonl');
  assert.ok(fs.existsSync(file), 'old SP heartbeat must produce durable evidence even when daemon is healthy');
  const event = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(e => e.event === 'sp-bridge.stale');
  assert.ok(event, 'sp-bridge.stale event missing');
  assert.equal(event.last_success_at, ts);
  assert.ok(event.age_ms > 15 * 60000);
  assert.equal(event.severity, 'P1');
});

test('15 minute boundary, missing, malformed and future timestamps fail closed', () => {
  const now = Date.now();
  assert.equal(heartbeatStatus({ ts: new Date(now - STALE_MS).toISOString() }, now).stale, false);
  assert.equal(heartbeatStatus({ ts: new Date(now - STALE_MS - 1).toISOString() }, now).stale, true);
  for (const beat of [null, {}, { ts: 'invalid' }, { ts: new Date(now + 1).toISOString() }]) {
    assert.equal(heartbeatStatus(beat, now).stale, true);
    assert.equal(heartbeatStatus(beat, now).age_ms, null);
  }
});

test('one stale event and P1 delivery per episode; recovery permits a new episode', async t => {
  const dir = fixture(t);
  const now = Date.now();
  const tasks = [];
  const send = async (_, task) => { tasks.push(task); return { ok: true, status: 201 }; };
  const opts = { intelDir: dir, now, send };
  const first = await checkSpHeartbeat(opts);
  assert.equal(first.notified, true);
  assert.equal((await checkSpHeartbeat({ ...opts, now: now + 1000 })).duplicate, true);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].id, /^sp-bridge.stale:/);
  fs.writeFileSync(path.join(dir, '.sp-bridge/last-success.json'), JSON.stringify({ ts: new Date(now).toISOString() }));
  assert.equal((await checkSpHeartbeat(opts)).stale, false);
  await checkSpHeartbeat({ ...opts, now: now + STALE_MS + 1 });
  assert.equal(tasks.length, 2);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'sp-bridge.stale').length, 2);
  assert.notEqual(tasks[0].id, tasks[1].id);
});

test('failed/unconfigured gateway remains retryable without losing or duplicating stale evidence', async t => {
  const dir = fixture(t);
  const opts = { intelDir: dir, now: Date.now() };
  assert.equal((await checkSpHeartbeat({ ...opts, send: null })).delivery.reason, 'gateway-unconfigured');
  assert.equal((await checkSpHeartbeat({ ...opts, send: async () => { throw Error('do not log credentials'); } })).notified, false);
  assert.equal((await checkSpHeartbeat({ ...opts, send: async () => ({ ok: false, status: 401 }) })).delivery.status, 401);
  assert.equal((await checkSpHeartbeat({ ...opts, send: async () => ({ ok: true, status: 201 }) })).notified, true);
  const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').map(JSON.parse).filter(e => e.event === 'sp-bridge.stale').length, 1);
  assert.doesNotMatch(raw, /credentials/);
});

test('real sender uses the existing signed P1 decision route, no fake board approval actions', async t => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const dir = fixture(t);
  let received;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', b => { body += b; });
    req.on('end', () => { received = { headers: req.headers, body, url: req.url }; res.writeHead(201); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `WEZBRIDGE_EVENTS_URL=http://127.0.0.1:${server.address().port}\nPERSONALDASHBOARD_EVENTS_HMAC_SECRET=test-only\n`);
  const send = heartbeatSender({}, envFile);
  assert.equal((await checkSpHeartbeat({ intelDir: dir, send })).notified, true);
  assert.equal(received.url, '/v1/events');
  const body = JSON.parse(received.body);
  assert.equal(body.source, 'wezbridge');
  assert.equal(body.kind, 'decision');
  assert.equal(body.severity, 'P1');
  assert.deepEqual(body.actions, []);
  const sig = crypto.createHmac('sha256', 'test-only').update(`${received.headers['x-event-timestamp']}.${received.body}`).digest('hex');
  assert.equal(received.headers['x-event-signature'], `sha256=${sig}`);
  assert.equal(heartbeatSender({ WEZBRIDGE_EVENTS_URL: '' }, envFile), null);
  assert.equal(heartbeatSender({}, path.join(dir, 'missing')), null);
});

test('evidence IO failures throw instead of claiming the alert was written', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'not-a-directory');
  fs.writeFileSync(file, 'x');
  await assert.rejects(checkSpHeartbeat({ intelDir: file, send: null }));
});
