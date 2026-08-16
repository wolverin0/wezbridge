'use strict';
/**
 * board-server.test.cjs — the board-app API contract.
 *
 * What must never regress: the verb whitelist (anything else 400), schema
 * fidelity of the appended ruling line (the gate must judge browser rulings
 * exactly like hand-written ones), the token check, staleness fields, and the
 * rate limit on appends. All IO goes to a temp _intel dir — these tests must
 * never touch the real control plane.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_INTEL = fs.mkdtempSync(path.join(os.tmpdir(), 'board-intel-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP_INTEL;

const srv = require('../board-app/server.cjs');
const { rulingCovers } = require('../scripts/steward-gate.cjs');

const TOKEN = 'test-token-abcdef';
let server;
let base;

function seedTask(id, extra = {}) {
  const task = {
    id, title: `Task ${id}`, repo: 'wezbridge', state: 'blocked',
    contract: { gate: 'operator', _note: 'the question' },
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    ...extra,
  };
  fs.writeFileSync(path.join(TMP_INTEL, 'tasks', `${id}.json`), JSON.stringify(task));
  return task;
}

before(async () => {
  fs.mkdirSync(path.join(TMP_INTEL, 'tasks'), { recursive: true });
  seedTask('T-9001');
  // Generous limiter here: these tests exercise validation, not the limiter.
  // The limiter has its own server below — it counts REJECTED posts too, on
  // purpose, so a flood of invalid requests is capped like a valid one.
  server = srv.createServer(TOKEN, { rateLimiter: srv.makeRateLimiter(1000, 60000) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(TMP_INTEL, { recursive: true, force: true });
});

const api = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { 'x-board-token': TOKEN, 'content-type': 'application/json', ...(opts.headers || {}) },
});

// --- token ------------------------------------------------------------------

test('API without token is 401', async () => {
  const res = await fetch(`${base}/api/state`);
  assert.strictEqual(res.status, 401);
});

test('API with wrong token is 401', async () => {
  const res = await fetch(`${base}/api/state`, { headers: { 'x-board-token': 'wrong' } });
  assert.strictEqual(res.status, 401);
});

// --- staleness --------------------------------------------------------------

test('every payload carries generated_at', async () => {
  const state = await (await api('/api/state')).json();
  assert.ok(Number.isFinite(Date.parse(state.generated_at)), 'state.generated_at is a date');
  const act = await (await api('/api/activity')).json();
  assert.ok(Number.isFinite(Date.parse(act.generated_at)), 'activity.generated_at is a date');
});

test('state exposes the operator-gated task as a decision', async () => {
  const state = await (await api('/api/state')).json();
  const d = state.decisions.find((x) => x.id === 'T-9001');
  assert.ok(d, 'T-9001 is a decision card');
  assert.strictEqual(d.question, 'the question');
});

// --- verb whitelist ---------------------------------------------------------

test('unknown verb is 400 and appends nothing', async () => {
  const before1 = fs.existsSync(path.join(TMP_INTEL, 'rulings.jsonl'));
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'resolved', note: 'sneaky' }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(fs.existsSync(path.join(TMP_INTEL, 'rulings.jsonl')), before1);
});

test('deferred without until is 400', async () => {
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'deferred', note: 'later' }),
  });
  assert.strictEqual(res.status, 400);
});

test('deferred with a past until is 400', async () => {
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'deferred', until: '2020-01-01T00:00:00Z', note: 'no' }),
  });
  assert.strictEqual(res.status, 400);
});

test('empty note is 400 — a ruling with no why is not a ruling', async () => {
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'cancelled', note: '  ' }),
  });
  assert.strictEqual(res.status, 400);
});

// --- schema fidelity --------------------------------------------------------

test('cancelled appends a schema-exact line the gate treats as permanent cover', async () => {
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'cancelled', note: 'dead work' }),
  });
  assert.strictEqual(res.status, 200);
  const { line } = await res.json();

  const onDisk = fs.readFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const last = onDisk[onDisk.length - 1];
  assert.deepStrictEqual(last, line, 'response echoes exactly what was written');
  assert.deepStrictEqual(Object.keys(last).sort(), ['at', 'category', 'ruling', 'task', 'why'],
    'field set matches the existing rulings schema');

  const finding = { id: 'T-9001', category: last.category, age_hours: 100 };
  assert.ok(rulingCovers(last, finding, Date.now()), 'gate covers the browser-written cancellation');
});

test('deferred with future until covers now, stops covering after until', async () => {
  const until = new Date(Date.now() + 3600000).toISOString();
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'deferred', until, note: 'parked on purpose' }),
  });
  assert.strictEqual(res.status, 200);
  const { line } = await res.json();
  const finding = { id: 'T-9001', category: line.category, age_hours: 100 };
  assert.ok(rulingCovers(line, finding, Date.now()), 'covers before until');
  assert.ok(!rulingCovers(line, finding, Date.parse(until) + 1000), 're-raises after until');
});

test('approved appends the ruling AND mirrors an approval into operator-actions.jsonl', async () => {
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9001', verb: 'approved', note: 'go ahead' }),
  });
  assert.strictEqual(res.status, 200);
  const { line } = await res.json();
  assert.strictEqual(line.ruling, 'approved');
  const actions = fs.readFileSync(path.join(TMP_INTEL, 'operator-actions.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const mirror = actions.find((a) => a.kind === 'approval' && a.task === 'T-9001');
  assert.ok(mirror, 'approval reached the orchestrator inbox');
});

// --- orchestrator inbox -----------------------------------------------------

test('inbox rejects unknown kind, accepts note', async () => {
  const bad = await api('/api/orchestrator-inbox', {
    method: 'POST', body: JSON.stringify({ kind: 'demand', text: 'x' }),
  });
  assert.strictEqual(bad.status, 400);

  const ok = await api('/api/orchestrator-inbox', {
    method: 'POST', body: JSON.stringify({ kind: 'note', text: 'llamame cuando puedas' }),
  });
  assert.strictEqual(ok.status, 200);
  const { line } = await ok.json();
  assert.strictEqual(line.type, 'operator-action');
  assert.ok(Number.isFinite(Date.parse(line.at)));
});

// --- rate limit -------------------------------------------------------------

test('append endpoints are rate limited', async () => {
  const tight = srv.createServer(TOKEN, { rateLimiter: srv.makeRateLimiter(3, 60000) });
  await new Promise((r) => tight.listen(0, '127.0.0.1', r));
  const tightBase = `http://127.0.0.1:${tight.address().port}`;
  try {
    let limited = false;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${tightBase}/api/orchestrator-inbox`, {
        method: 'POST',
        headers: { 'x-board-token': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'note', text: `spam ${i}` }),
      });
      if (res.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'a POST flood hits 429 at the cap');
  } finally { tight.close(); }
});

test('rate limiter window slides: old hits expire', () => {
  const allow = srv.makeRateLimiter(2, 1000);
  assert.ok(allow('ip', 0));
  assert.ok(allow('ip', 10));
  assert.ok(!allow('ip', 20), 'third hit inside the window is blocked');
  assert.ok(allow('ip', 1500), 'allowed again after the window passes');
});

// --- pagination -------------------------------------------------------------

test('activity is paginated 25 per pull', async () => {
  const act = await (await api('/api/activity?page=0')).json();
  assert.strictEqual(act.page_size, 25);
  assert.ok(act.items.length <= 25);
  assert.ok(typeof act.total === 'number');
});
