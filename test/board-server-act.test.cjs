'use strict';
/**
 * board-server-act.test.cjs — GET/POST /act: a signed link from the central de
 * avisos writes the SAME ruling the tablero writes (T-0334 AC2).
 *
 * Guards: a valid link shows a confirmation (never rules on GET), the POST
 * appends a ruling with source=board-app by=operator and moves the task
 * exactly like /api/rulings, and a tampered/expired link is refused with no
 * write. All IO goes to a temp _intel dir.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_INTEL = fs.mkdtempSync(path.join(os.tmpdir(), 'board-act-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP_INTEL;

const srv = require('../board-app/server.cjs');
const { buildActionUrl } = require('../board-app/lib/action-links.cjs');

const TOKEN = 'act-test-token';
let server;
let base;

function seedTask(id, extra = {}) {
  const task = {
    id, title: `Task ${id}`, repo: 'wezbridge', state: 'blocked', corr: `corr-${id}`,
    contract: { gate: 'operator', _note: 'the question' }, blocked_by: 'operator',
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    ...extra,
  };
  fs.writeFileSync(path.join(TMP_INTEL, 'tasks', `${id}.json`), JSON.stringify(task));
  return task;
}
const readTask = (id) => JSON.parse(fs.readFileSync(path.join(TMP_INTEL, 'tasks', `${id}.json`), 'utf8'));
const rulings = () => {
  try { return fs.readFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};

before(async () => {
  fs.mkdirSync(path.join(TMP_INTEL, 'tasks'), { recursive: true });
  seedTask('T-9201');
  seedTask('T-9202');
  seedTask('T-9203');
  server = srv.createServer(TOKEN);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const signed = (task, verb, opts = {}) => buildActionUrl(base, TOKEN, { task, verb, ...opts });
const form = (obj) => new URLSearchParams(obj).toString();

test('GET /act with a valid link shows a confirmation and rules NOTHING', async () => {
  const res = await fetch(signed('T-9201', 'approved'));
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('T-9201') && html.includes('Aprobar'), html.slice(0, 300));
  assert.ok(/<form[^>]+method="post"/i.test(html), 'confirmation must POST');
  assert.strictEqual(rulings().length, 0, 'a GET never writes a ruling (link prefetch safety)');
  assert.strictEqual(readTask('T-9201').state, 'blocked');
});

test('POST /act approves: same ruling line as the tablero, task un-gated to ready', async () => {
  const u = new URL(signed('T-9201', 'approved'));
  const q = Object.fromEntries(u.searchParams);
  const res = await fetch(`${base}/act`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...q, note: 'aprobado desde la bandeja' }),
  });
  const html = await res.text();
  assert.strictEqual(res.status, 200, html);
  assert.ok(html.includes('T-9201'), 'result page names the task');

  const line = rulings().find((l) => l.task === 'T-9201');
  assert.ok(line, 'ruling appended');
  assert.strictEqual(line.ruling, 'approved');
  assert.strictEqual(line.source, 'board-app', 'AC2: same source as the tablero');
  assert.strictEqual(line.by, 'operator', 'AC2: same actor as the tablero');
  assert.strictEqual(line.corr, 'corr-T-9201', 'corr comes from the card');
  assert.strictEqual(line.why, 'aprobado desde la bandeja');

  const t = readTask('T-9201');
  assert.strictEqual(t.state, 'ready');
  assert.strictEqual(t.contract.gate, null, 'approve un-gates exactly like /api/rulings');
});

test('POST /act deferred requires until and records it', async () => {
  const q = Object.fromEntries(new URL(signed('T-9202', 'deferred')).searchParams);
  const bad = await fetch(`${base}/act`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...q, note: 'mas tarde' }),
  });
  assert.strictEqual(bad.status, 400, 'deferred without until is a shrug → 400');
  const until = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
  const ok = await fetch(`${base}/act`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...q, note: 'mas tarde', until }),
  });
  assert.strictEqual(ok.status, 200, await ok.text());
  const line = rulings().find((l) => l.task === 'T-9202');
  assert.strictEqual(line.ruling, 'deferred');
  assert.strictEqual(line.until, until);
});

test('a tampered or expired link is refused with NO write, on GET and on POST', async () => {
  const q = Object.fromEntries(new URL(signed('T-9203', 'cancelled')).searchParams);
  const tampered = { ...q, verb: 'approved' };
  const g = await fetch(`${base}/act?${form(tampered)}`);
  assert.strictEqual(g.status, 403);
  const p = await fetch(`${base}/act`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...tampered, note: 'x' }),
  });
  assert.strictEqual(p.status, 403);

  const expired = Object.fromEntries(new URL(signed('T-9203', 'cancelled', { now: Date.now() - 30 * 86400 * 1000 })).searchParams);
  const e = await fetch(`${base}/act`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...expired, note: 'x' }),
  });
  assert.strictEqual(e.status, 403);

  assert.ok(!rulings().some((l) => l.task === 'T-9203'), 'nothing written for T-9203');
  assert.strictEqual(readTask('T-9203').state, 'blocked');
});

test('/act never needs x-board-token but /api/rulings still does', async () => {
  const res = await fetch(`${base}/api/rulings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'T-9203', verb: 'cancelled', note: 'no token' }),
  });
  assert.strictEqual(res.status, 401);
});
