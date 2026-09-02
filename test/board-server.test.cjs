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
const { gateOf } = require('../scripts/fleet-board.cjs');

const TOKEN = 'test-token-abcdef';
const EVID_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
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

const taskFile = (id) => path.join(TMP_INTEL, 'tasks', `${id}.json`);
const readTask = (id) => JSON.parse(fs.readFileSync(taskFile(id), 'utf8'));

before(async () => {
  fs.mkdirSync(path.join(TMP_INTEL, 'tasks'), { recursive: true });
  seedTask('T-9001');
  // T-0143 transition fixtures — one per verb plus an untouched control, each
  // carrying fields the transition must NOT damage.
  const rich = {
    goal: 'the goal text', acceptance_criteria: ['a', 'b'], depends_on: ['T-9000'],
    corr: 'corr-9', attempt: 3, origin_key: 'keep-me',
    contract: { gate: 'operator', mode: 'scoped_write', allowed_paths: ['src/**'], _note: 'the question' },
  };
  seedTask('T-9101', rich);
  seedTask('T-9102', rich);
  seedTask('T-9103', rich);
  // The FLOTA control: ungated + ready, so it lands in by_repo, which is where
  // the operator complained the rows say nothing.
  seedTask('T-9104', { ...rich, state: 'ready', contract: { ...rich.contract, gate: null } });
  // Slice 4 evidence fixtures: a decision and an in-flight task, each with a
  // corr that has a persisted result body, plus a head_moved beacon for the
  // repo — the board must JOIN these onto the cards, not make the operator ask.
  seedTask('T-9107', { corr: 'corr-evid' });
  seedTask('T-9108', { state: 'running', corr: 'corr-run', contract: { gate: null }, lease: { owner: 'pane-5' } });
  fs.writeFileSync(path.join(TMP_INTEL, 'a2a-results.jsonl'), [
    JSON.stringify({
      time: new Date(Date.now() - 7 * 3600000).toISOString(), event: 'a2a.result',
      corr: 'corr-evid', from_pane: 5, to_pane: 0, v2: 'missing', body: 'primera respuesta',
    }),
    JSON.stringify({
      time: new Date(Date.now() - 6 * 3600000).toISOString(), event: 'a2a.result',
      corr: 'corr-evid', from_pane: 5, to_pane: 0, v2: 'ok',
      body: `criteria:\n- board join: pass — segunda respuesta\n${'x'.repeat(600)}`,
    }),
    JSON.stringify({
      time: new Date(Date.now() - 3600000).toISOString(), event: 'a2a.result',
      corr: 'corr-run', from_pane: 7, to_pane: 0, v2: 'ok', body: 'criteria:\n- otro corr: pass',
    }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(TMP_INTEL, 'pane-events.jsonl'), JSON.stringify({
    time: new Date(Date.now() - 6 * 3600000).toISOString(), repo: 'wezbridge', session: 'abc',
    event: 'turn-end', markers: [], head: EVID_SHA, head_prev: 'e'.repeat(40), head_moved: true,
  }) + '\n');
  // Generous limiter here: these tests exercise validation, not the limiter.
  // The limiter has its own server below — it counts REJECTED posts too, on
  // purpose, so a flood of invalid requests is capped like a valid one.
  // censusCache: null keeps this suite hermetic — the census is the one source
  // that shells out (schtasks), and a test that queried the real Task Scheduler
  // would be reading the operator's machine instead of its own fixtures.
  server = srv.createServer(TOKEN, { rateLimiter: srv.makeRateLimiter(1000, 60000), censusCache: null });
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

// --- slice 4: evidence join + freshness --------------------------------------
//
// These run BEFORE any ruling lands: every seeded task still has its 2026-08-01
// updated_at, so the 6h-old commit evidence is deterministically "untouched".

test('a decision carries evidence.last_result when a2a-results has its corr', async () => {
  const state = await (await api('/api/state')).json();
  const d = state.decisions.find((x) => x.id === 'T-9107');
  assert.ok(d, 'T-9107 is a decision card');
  assert.ok(d.evidence, 'the card carries an evidence block');
  const r = d.evidence.last_result;
  assert.ok(r, 'last_result joined by corr');
  assert.strictEqual(r.v2, 'ok');
  assert.ok(r.excerpt.includes('segunda respuesta'), 'the LATEST result for the corr wins');
  assert.ok(!r.excerpt.includes('primera respuesta'), 'not the older one');
  assert.ok(r.excerpt.length <= 500, `excerpt is capped at 500 chars, got ${r.excerpt.length}`);
});

test('a decision carries evidence.last_commit for its repo (sha + time)', async () => {
  const state = await (await api('/api/state')).json();
  const d = state.decisions.find((x) => x.id === 'T-9107');
  assert.strictEqual(d.evidence.last_commit.sha, EVID_SHA);
  assert.ok(Number.isFinite(Date.parse(d.evidence.last_commit.at)), 'commit evidence carries its time');
});

test('in-flight tasks carry evidence too, joined by THEIR corr', async () => {
  const state = await (await api('/api/state')).json();
  const t = state.in_flight.find((x) => x.id === 'T-9108');
  assert.ok(t, 'T-9108 is in flight');
  assert.ok(t.evidence.last_result, 'result joined');
  assert.ok(t.evidence.last_result.excerpt.includes('otro corr'), 'joined by ITS corr, not any result');
  assert.strictEqual(t.evidence.last_commit.sha, EVID_SHA);
});

test('a task with no corr gets last_result null, never a stray join', async () => {
  const state = await (await api('/api/state')).json();
  const d = state.decisions.find((x) => x.id === 'T-9001');
  assert.ok(d.evidence, 'evidence block still present');
  assert.strictEqual(d.evidence.last_result, null);
  assert.strictEqual(d.evidence.last_commit.sha, EVID_SHA, 'repo commit still joins');
});

test('freshness pill: RED while the 6h-old commit has no task touched since', async () => {
  const state = await (await api('/api/state')).json();
  assert.ok(state.freshness, 'payload carries the freshness verdict');
  assert.strictEqual(state.freshness.verdict, 'RED');
  const s = state.freshness.stale.find((x) => x.repo === 'wezbridge');
  assert.ok(s, 'names the repo');
  assert.strictEqual(s.sha, EVID_SHA, 'and the sha');
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
  assert.deepStrictEqual(Object.keys(last).sort(), ['at', 'by', 'category', 'ruling', 'source', 'task', 'why'],
    'field set matches the rulings schema, PROCEDENCIA y ACTOR incluidos (W1, T-0312)');
  assert.strictEqual(last.source, 'board-app', 'quien escribio la linea queda en la linea');
  assert.strictEqual(last.by, 'operator', 'quien DECIDIO queda en la linea: el tablero es del operador');

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

// --- T-0143 D1: a terminal ruling must move the task ------------------------

test('cancel: ruling lands AND the task goes cancelled AND the card disappears', async () => {
  const before2 = readTask('T-9101');
  const seen = await (await api('/api/state')).json();
  assert.ok(seen.decisions.some((d) => d.id === 'T-9101'), 'card is on screen before the ruling');

  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9101', verb: 'cancelled', note: 'no lo necesitamos mas' }),
  });
  assert.strictEqual(res.status, 200);
  const { line, transition } = await res.json();

  const rulings = fs.readFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rulings.some((r) => r.task === 'T-9101' && r.ruling === 'cancelled'), 'ruling is on disk');
  assert.strictEqual(line.ruling, 'cancelled');

  const after = readTask('T-9101');
  assert.strictEqual(after.state, 'cancelled', 'task moved');
  assert.deepStrictEqual(transition, { applied: true, from: 'blocked', to: 'cancelled', ungated: false });

  // WHO and WHY are in the file that changed, not only in another file.
  assert.match(after.next_action, /operator/i);
  assert.match(after.next_action, /fleet board/i);
  assert.ok(after.next_action.includes('no lo necesitamos mas'), 'the why is recorded verbatim');
  assert.ok(after.next_action.includes(line.at), 'the when is recorded');
  assert.strictEqual(after.updated_at, line.at);

  // Every other field preserved, byte for byte.
  for (const k of ['id', 'title', 'repo', 'goal', 'acceptance_criteria', 'depends_on', 'corr', 'attempt', 'origin_key', 'contract', 'created_at']) {
    assert.deepStrictEqual(after[k], before2[k], `${k} survived the transition`);
  }

  const state = await (await api('/api/state')).json();
  assert.ok(!state.decisions.some((d) => d.id === 'T-9101'), 'card is gone on refresh');
});

test('approve: task goes ready AND is un-gated, so the card is gone too', async () => {
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9102', verb: 'approved', note: 'dale, arrancá' }),
  });
  assert.strictEqual(res.status, 200);
  const { transition } = await res.json();
  assert.deepStrictEqual(transition, { applied: true, from: 'blocked', to: 'ready', ungated: true });

  const after = readTask('T-9102');
  assert.strictEqual(after.state, 'ready');
  assert.strictEqual(after.contract.gate, null, 'the operator gate is cleared — that is what un-gate means');
  // Un-gating must not gut the rest of the contract.
  assert.strictEqual(after.contract.mode, 'scoped_write');
  assert.deepStrictEqual(after.contract.allowed_paths, ['src/**']);
  assert.match(after.next_action, /Approved by the operator via the fleet board/);

  const state = await (await api('/api/state')).json();
  assert.ok(!state.decisions.some((d) => d.id === 'T-9102'), 'approved card leaves DECISIONES');
  const inFleet = Object.values(state.by_repo).flat().some((t) => t.id === 'T-9102');
  assert.ok(inFleet, 'and reappears as ordinary dispatchable work in FLOTA');
});

test('defer: task state UNCHANGED, card hidden while the ruling covers it', async () => {
  const before3 = readTask('T-9103');
  const until = new Date(Date.now() + 86400000).toISOString();
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9103', verb: 'deferred', until, note: 'la semana que viene' }),
  });
  assert.strictEqual(res.status, 200);
  const { transition } = await res.json();
  assert.strictEqual(transition.applied, false, 'a deferral moves no task state');
  assert.ok(!transition.error, 'and that is not an error');

  assert.deepStrictEqual(readTask('T-9103'), before3, 'the task file is untouched, blocker and all');

  const state = await (await api('/api/state')).json();
  assert.ok(!state.decisions.some((d) => d.id === 'T-9103'), 'card hidden while deferred');
  const hidden = state.deferred_hidden.find((d) => d.id === 'T-9103');
  assert.ok(hidden, 'hidden is surfaced, never silently gone');
  assert.strictEqual(hidden.until, until);
});

test('deferred card RETURNS once `until` passes — hiding is not deleting', async () => {
  // Supersede the live deferral with an expired one. The latest ruling is what
  // the board reads, and this one no longer covers.
  fs.appendFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), `${JSON.stringify({
    task: 'T-9103', category: 'awaiting-operator', ruling: 'deferred',
    why: 'vencida', at: new Date(Date.now() - 7200000).toISOString(),
    until: new Date(Date.now() - 1000).toISOString(),
  })}\n`);

  const state = await (await api('/api/state')).json();
  assert.ok(state.decisions.some((d) => d.id === 'T-9103'), 'the card is back on the board');
  assert.ok(!state.deferred_hidden.some((d) => d.id === 'T-9103'), 'and is no longer counted as hidden');
  assert.strictEqual(readTask('T-9103').state, 'blocked', 'still legitimately gated the whole time');
});

test('a covering NON-deferred ruling does NOT hide a live operator gate', async () => {
  // `dispatched` covers for 24h in the gate's vocabulary. Honouring that here
  // would make a decision vanish for a day because someone dispatched
  // something — strictly worse than the defect this task fixes.
  fs.appendFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), `${JSON.stringify({
    task: 'T-9103', category: 'awaiting-operator', ruling: 'dispatched',
    why: 'sent to a pane', at: new Date().toISOString(),
  })}\n`);

  const state = await (await api('/api/state')).json();
  assert.ok(state.decisions.some((d) => d.id === 'T-9103'), 'still on screen — only deferrals hide');
});

test('failure path: the task write fails, the ruling still stands, the response is honest', async () => {
  // T-9404 has no task file. Deterministic on every platform, unlike chmod.
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9404', verb: 'cancelled', note: 'ruling must survive a failed move' }),
  });
  assert.strictEqual(res.status, 200, 'not a 500 — half the work succeeded and the operator must be told which half');
  const { ok, line, transition } = await res.json();
  assert.strictEqual(ok, true);

  const rulings = fs.readFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rulings.some((r) => r.task === 'T-9404' && r.ruling === 'cancelled' && r.at === line.at),
    'THE RULING STANDS — it is the source of truth and was written first');
  assert.strictEqual(transition.applied, false);
  assert.ok(transition.error, 'the failure is reported, not swallowed into a success');
});

// --- slice 4: touching a task clears freshness -------------------------------

test('freshness returns GREEN once a task moved after the evidence', async () => {
  // The transitions above stamped updated_at = now on T-9101/T-9102 — a task
  // WAS touched after the 6h-old commit, which is exactly what clears the gate.
  const state = await (await api('/api/state')).json();
  assert.strictEqual(state.freshness.verdict, 'GREEN',
    'updating the ledger after the work is the behaviour the gate trains');
});

// --- T-0143 follow-up: the gate lives in EITHER place -----------------------
//
// Found in production 2026-08-16 on the FIRST real approve. T-0145 carried
// `contract.gate: null` and a TOP-LEVEL `gate: "operator"`. gateOf() reads
// both; applyTransition wrote only contract.gate. The task moved to `ready`
// and the approved card stayed on the board — the exact defect T-0143 existed
// to kill, reintroduced through the write path. fleet-steward paid for the
// identical mistake on 2026-08-14 ("the gate lives in EITHER place" in its
// classify()); the board repeated it. Live ledger that day: 13 tasks gated via
// contract.gate, 3 via the top-level field, 2 via both — 5 of 18 in the crack.

test('approve un-gates a TOP-LEVEL gate (the real T-0145 shape)', async () => {
  // Exactly as recorded from the live file: contract present, contract.gate
  // null, gate at the top level.
  seedTask('T-9105', {
    gate: 'operator',
    contract: { mode: 'scoped_write', gate: null, allowed_paths: ['bot/'], evaluator: 'bot-suite' },
  });
  const before4 = await (await api('/api/state')).json();
  assert.ok(before4.decisions.some((d) => d.id === 'T-9105'), 'top-level gate puts it on DECISIONES');

  const res = await api('/api/rulings', {
    method: 'POST', body: JSON.stringify({ task: 'T-9105', verb: 'approved', note: 'dale' }),
  });
  const { transition } = await res.json();
  assert.strictEqual(transition.ungated, true, 'reported un-gated');
  assert.ok(!transition.still_gated);

  const after = readTask('T-9105');
  assert.strictEqual(after.gate, null, 'top-level gate cleared');
  assert.strictEqual(after.contract.mode, 'scoped_write', 'rest of the contract survives');
  assert.strictEqual(after.contract.evaluator, 'bot-suite');

  const state = await (await api('/api/state')).json();
  assert.ok(!state.decisions.some((d) => d.id === 'T-9105'), 'THE CARD LEAVES — the defect that shipped');
});

test('approve un-gates when the gate is in BOTH places', async () => {
  seedTask('T-9106', { gate: 'operator', contract: { gate: 'operator', mode: 'read_mostly' } });
  const res = await api('/api/rulings', {
    method: 'POST', body: JSON.stringify({ task: 'T-9106', verb: 'approved', note: 'dale' }),
  });
  const { transition } = await res.json();
  assert.strictEqual(transition.ungated, true);
  const after = readTask('T-9106');
  assert.strictEqual(after.gate, null, 'top-level cleared');
  assert.strictEqual(after.contract.gate, null, 'contract cleared');
  assert.strictEqual(after.contract.mode, 'read_mostly');

  const state = await (await api('/api/state')).json();
  assert.ok(!state.decisions.some((d) => d.id === 'T-9106'));
});

test('ungateTask agrees with gateOf for EVERY gate shape', () => {
  // The post-condition, stated as a property: `ungated` is true exactly when
  // the task WAS gated and is no longer. This is what stops the writer from
  // drifting away from the reader again — including for a third gate location
  // nobody has invented yet, which would make `ungated` report false rather
  // than silently leave an approved card on the board.
  const shapes = [
    ['contract only', { contract: { gate: 'operator' } }],
    ['top level only', { gate: 'operator' }],
    ['both', { gate: 'operator', contract: { gate: 'operator' } }],
    ['top level + null contract gate (T-0145)', { gate: 'operator', contract: { gate: null } }],
  ];
  for (const [name, task] of shapes) {
    const out = srv.ungateTask({ id: 'T-1', ...task });
    assert.strictEqual(out.wasGated, true, `${name}: was gated`);
    assert.strictEqual(out.ungated, true, `${name}: un-gated`);
    assert.notStrictEqual(gateOf(out.next), 'operator', `${name}: gateOf agrees it is gone`);
  }

  // A task that was never gated must NOT report ungated:true. The lazy version
  // of this fix ("is it gated now? no → ungated") would claim credit for work
  // it never did, and that lie would hide the next regression.
  for (const [name, task] of [
    ['no gate at all', {}],
    ['non-operator gate', { gate: 'ci' }],
    ['already cleared', { gate: null, contract: { gate: null } }],
  ]) {
    const out = srv.ungateTask({ id: 'T-1', ...task });
    assert.strictEqual(out.wasGated, false, `${name}: not gated going in`);
    assert.strictEqual(out.ungated, false, `${name}: must not claim an un-gate it did not perform`);
  }
});

test('ungateTask does not mutate the task it is given', () => {
  const task = { id: 'T-1', gate: 'operator', contract: { gate: 'operator', mode: 'x' } };
  srv.ungateTask(task);
  assert.strictEqual(task.gate, 'operator', 'input untouched');
  assert.strictEqual(task.contract.gate, 'operator', 'nested input untouched');
});

// --- T-0143 D1: the whitelist is a whitelist --------------------------------

test('TASK_TRANSITION is the complete set of task-state writes', () => {
  assert.deepStrictEqual(Object.keys(srv.TASK_TRANSITION).sort(), [...srv.VERBS].sort(),
    'every verb is accounted for — no verb may fall through undeclared');
  assert.strictEqual(srv.TASK_TRANSITION.deferred, null);
  // `blockedBy` es parte de la regla desde W1: aprobar contesta al operador y la
  // tarjeta deja de esperarlo. Cancelar deja el campo como estaba (null aca
  // significa "no lo escribas"), porque la pregunta murio sin respuesta.
  assert.deepStrictEqual(srv.TASK_TRANSITION.cancelled, { state: 'cancelled', ungate: false, blockedBy: null });
  assert.deepStrictEqual(srv.TASK_TRANSITION.approved, { state: 'ready', ungate: true, blockedBy: 'agent' });
});

test('applyTransition refuses a task id that escapes the tasks directory', () => {
  const out = srv.applyTransition('../../escape', { ruling: 'cancelled', at: 'now', why: 'x' });
  assert.strictEqual(out.applied, false);
  assert.match(out.error, /outside the tasks directory/);
});

test('NO OTHER PATH writes a task file', async () => {
  const ids = fs.readdirSync(path.join(TMP_INTEL, 'tasks'));
  const snapshot = Object.fromEntries(ids.map((f) => [f, fs.readFileSync(path.join(TMP_INTEL, 'tasks', f), 'utf8')]));

  await api('/api/state');
  await api('/api/activity?page=0');
  await api('/api/orchestrator-inbox', { method: 'POST', body: JSON.stringify({ kind: 'note', text: 'una nota' }) });
  await api('/api/orchestrator-inbox', { method: 'POST', body: JSON.stringify({ kind: 'call-me', text: 'llamame' }) });
  await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9104', verb: 'deferred', until: new Date(Date.now() + 86400000).toISOString(), note: 'no toca nada' }),
  });
  await api('/api/rulings', { method: 'POST', body: JSON.stringify({ task: 'T-9104', verb: 'resolved', note: 'rejected verb' }) });

  assert.deepStrictEqual(fs.readdirSync(path.join(TMP_INTEL, 'tasks')), ids, 'no task file created or deleted');
  for (const [f, text] of Object.entries(snapshot)) {
    assert.strictEqual(fs.readFileSync(path.join(TMP_INTEL, 'tasks', f), 'utf8'), text, `${f} byte-identical`);
  }
});

// --- T-0143 D3: rows carry what you decide with -----------------------------

test('every task payload carries the detail the operator decides with', async () => {
  const state = await (await api('/api/state')).json();
  const row = Object.values(state.by_repo).flat().find((t) => t.id === 'T-9104');
  assert.ok(row, 'T-9104 is listed');
  assert.ok(row.detail, 'row carries a detail block, not just a title');
  assert.strictEqual(row.detail.goal, 'the goal text');
  assert.deepStrictEqual(row.detail.acceptance_criteria, ['a', 'b']);
  assert.deepStrictEqual(row.detail.depends_on, ['T-9000']);
  assert.strictEqual(row.detail.corr, 'corr-9');
  assert.strictEqual(row.detail.contract_mode, 'scoped_write');
});

test('detailOf survives a task missing every optional field', () => {
  const d = srv.detailOf({ id: 'T-0', state: 'ready' });
  assert.deepStrictEqual(d.acceptance_criteria, [], 'arrays default to empty, never undefined');
  assert.deepStrictEqual(d.depends_on, []);
  assert.strictEqual(d.goal, '');
  assert.strictEqual(d.lease, null);
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
  const tight = srv.createServer(TOKEN, { rateLimiter: srv.makeRateLimiter(3, 60000), censusCache: null });
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

// --- routine verdict resolution ---------------------------------------------

test('relative findings_file resolves against routine-findings dir, not cwd', async () => {
  const dir = path.join(TMP_INTEL, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'findings-rel.json'), JSON.stringify({ verdict: 'clean' }));
  fs.writeFileSync(path.join(dir, 'run-rel.json'), JSON.stringify({
    routine: 'rel-routine', repo: 'wezbridge', cadence_hours: 24, exit_status: 0,
    findings_file: 'findings-rel.json',
  }));
  fs.writeFileSync(path.join(dir, 'run-absent.json'), JSON.stringify({
    routine: 'absent-routine', repo: 'wezbridge', cadence_hours: 24, exit_status: 0,
    findings_file: 'findings-does-not-exist.json',
  }));

  const state = await (await api('/api/state')).json();
  const rel = state.routines.find((r) => r.routine === 'rel-routine');
  const absent = state.routines.find((r) => r.routine === 'absent-routine');
  assert.ok(rel, 'relative-path run appears');
  assert.strictEqual(rel.verdict, 'clean', 'relative findings_file renders its real verdict');
  assert.ok(absent, 'absent-artifact run appears');
  assert.strictEqual(absent.verdict, 'no artifact', 'only a genuinely missing file is "no artifact"');
});

// --- pagination -------------------------------------------------------------

test('activity is paginated 25 per pull', async () => {
  const act = await (await api('/api/activity?page=0')).json();
  assert.strictEqual(act.page_size, 25);
  assert.ok(act.items.length <= 25);
  assert.ok(typeof act.total === 'number');
});

// --- W1: procedencia, blocked_by y el espejo del inbox ----------------------
//
// Tres cosas que el tablero hacia a medias. La linea no decia quien la escribio
// (con tres escritores del mismo archivo, "quien decidio esto" no se podia
// responder leyendolo). La tarjeta aprobada quedaba `ready` con
// `blocked_by: operator`, o sea seguia contando como deuda del operador en la
// UNICA metrica que mide si la orquestacion funciona. Y el espejo al inbox del
// orquestador tiene que ser exactamente UNO por approve: el tablero NO pasa por
// `ledger decide`, asi que si algun dia lo hiciera, la linea se duplicaria.

test('approve deja la tarjeta con blocked_by agent: ya no espera al operador', async () => {
  seedTask('T-9110', {
    blocked_by: 'operator',
    contract: { gate: 'operator', mode: 'scoped_write', allowed_paths: ['src/**'] },
  });
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9110', verb: 'approved', note: 'aprobado desde el telefono' }),
  });
  assert.strictEqual(res.status, 200);
  const after = readTask('T-9110');
  assert.strictEqual(after.state, 'ready');
  assert.strictEqual(after.blocked_by, 'agent',
    'aprobar contesta al operador: la tarjeta pasa a esperar a un agente');
  assert.strictEqual(gateOf(after), null, 'y el gate se fue, medido con el lector');
});

test('cancelar NO toca blocked_by: la pregunta no fue contestada, la tarea murio', async () => {
  seedTask('T-9111', { blocked_by: 'operator' });
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9111', verb: 'cancelled', note: 'muerta' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(readTask('T-9111').blocked_by, 'operator',
    'reescribir esto seria inventar un dato sobre una tarjeta cerrada');
});

test('UN approve deja EXACTAMENTE UNA linea nueva en operator-actions.jsonl', async () => {
  const actionsFile = path.join(TMP_INTEL, 'operator-actions.jsonl');
  const count = () => (fs.existsSync(actionsFile)
    ? fs.readFileSync(actionsFile, 'utf8').split('\n').filter(Boolean).length : 0);
  seedTask('T-9112', { blocked_by: 'operator' });
  const before = count();
  const res = await api('/api/rulings', {
    method: 'POST',
    body: JSON.stringify({ task: 'T-9112', verb: 'approved', note: 'una sola vez' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(count(), before + 1, 'ni cero (el orquestador no se entera) ni dos (el tablero shelleando a decide)');
  const mine = fs.readFileSync(actionsFile, 'utf8').split('\n').filter(Boolean)
    .map(JSON.parse).filter((a) => a.task === 'T-9112');
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].source, 'board-app');
});

test('validateRuling acepta un `by` opcional y rechaza uno vacio', () => {
  const findings = [];
  const ok = srv.validateRuling({ task: 'T-9113', verb: 'approved', note: 'dale', by: 'operator' }, findings);
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.line.by, 'operator');
  assert.strictEqual(ok.line.source, 'board-app');
  const bad = srv.validateRuling({ task: 'T-9113', verb: 'approved', note: 'dale', by: '   ' }, findings);
  assert.ok(bad.error, 'un `by` vacio es peor que ausente: firma sin firmante');
});

test('la linea del tablero pasa por el MISMO validador que appendRuling', () => {
  // El tablero es uno de los tres escritores; si armara su linea por su cuenta
  // habria dos schemas sobre un archivo, que es el defecto T-0294 otra vez.
  const { validateRulingLine } = require('../src/rulings.cjs');
  const { line } = srv.validateRuling({ task: 'T-9114', verb: 'approved', note: 'x' }, []);
  const verdict = validateRulingLine(line, Date.now());
  assert.strictEqual(verdict.ok, true, `el validador central rechaza lo que el tablero escribe: ${verdict.error}`);
});

// ---------------------------------------------------------------------------
// T31 (2026-09-01): un approve responde la pregunta del operador, no el hallazgo
// bajo el que el steward archivo la tarjeta. Sin esto, la segunda aprobacion de
// una tarjeta (archivada como decision-unheard) volvia 400 y el operador no
// podia decidir desde el telefono.
// ---------------------------------------------------------------------------
test('T31: approved sobre una tarjeta archivada bajo OTRO hallazgo escribe category awaiting-operator y responde 200', () => {
  const id = 'T-9310';
  seedTask(id);
  const { line } = srv.validateRuling({ task: id, verb: 'approved', note: 'dale' }, [{ id, category: 'decision-unheard' }]);
  assert.equal(line.category, 'awaiting-operator');
  const { line: deferred } = srv.validateRuling({ task: id, verb: 'deferred', note: 'despues', until: '2099-01-01T00:00:00.000Z' }, [{ id, category: 'idle' }]);
  assert.equal(deferred.category, 'idle', 'deferred sigue la categoria del hallazgo');
});

// ---------------------------------------------------------------------------
// T31 W3: el tablero avisa al dueño INLINE tras la transicion — relay inyectable
// (los tests no descubren panes; main() pasa el relay real). Sin relay inyectado
// el tablero no intenta nada: nunca toca el _intel vivo por accidente.
// ---------------------------------------------------------------------------
test('T31: un approve invoca el relay inyectado UNA vez con el intelDir del tablero; sin relay no explota', async () => {
  const calls = [];
  const relay = (opts) => { calls.push(opts); return Promise.resolve({ delivered: [], queued: ['T-9320'] }); };
  const s2 = srv.createServer(TOKEN, { censusCache: null, relay });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    seedTask('T-9320');
    const res = await fetch(`${b2}/api/rulings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': TOKEN }, body: JSON.stringify({ task: 'T-9320', verb: 'approved', note: 'dale' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(calls.length, 1, 'el relay corre exactamente una vez por approve');
    assert.equal(calls[0].intelDir, TMP_INTEL, 'el relay recibe el intelDir del tablero, nunca el vivo por defecto');
    assert.deepEqual(body.relay, { delivered: [], queued: ['T-9320'] }, 'la respuesta dice que paso con el aviso');
    seedTask('T-9321');
    const res2 = await fetch(`${b2}/api/rulings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': TOKEN }, body: JSON.stringify({ task: 'T-9321', verb: 'deferred', until: '2099-01-01T00:00:00.000Z', note: 'despues' }) });
    assert.equal(res2.status, 200);
    assert.equal(calls.length, 1, 'deferred no avisa a nadie: no mueve la tarjeta');
  } finally { await new Promise((r) => s2.close(r)); }
});

// ---------------------------------------------------------------------------
// T-0312 (2026-09-02): la linea del tablero tiene que llevar el `corr` de la
// tarjeta. Sin el, el ruling approved de un kind gate=operator no se puede
// correlacionar con el job que espera en FinalOrchestra (AC2: UNA decision
// con task/correlation id visible en las dos superficies) — medido en vivo
// con T-0310: card.corr estampado y la linea salia sin corr igual.
test('validateRuling copia el corr de la TARJETA a la linea (no del request)', () => {
  const tasks = [{ id: 'T-9115', corr: 'T-9115:drill-deploy:20260901' }];
  const { error, line } = srv.validateRuling({ task: 'T-9115', verb: 'approved', note: 'dale' }, [], Date.now(), tasks);
  assert.ok(!error, error);
  assert.strictEqual(line.corr, 'T-9115:drill-deploy:20260901', 'la linea sale sin corr: FO no puede correlacionar la aprobacion');
  const { validateRulingLine } = require('../src/rulings.cjs');
  assert.strictEqual(validateRulingLine(line, Date.now()).ok, true);
});

test('validateRuling NO acepta un corr del request ni inventa uno cuando la tarjeta no lo tiene', () => {
  const tasks = [{ id: 'T-9116', corr: null }];
  const { line } = srv.validateRuling({ task: 'T-9116', verb: 'approved', note: 'dale', corr: 'forjado' }, [], Date.now(), tasks);
  assert.strictEqual(line.corr, undefined, 'el corr lo dice la tarjeta, nunca el cliente HTTP');
});

// T-0312 / FinalOrchestra AC2 (2026-09-02): toda decision del tablero lleva
// ACTOR. El lector canonico de FO exige `by`; la linea approved de T-0310 del
// 12:57:33Z salio sin el y FO la descarto (409). El tablero es la superficie
// del operador (token), asi que un tap sin `by` persiste 'operator'.
test('un tap del tablero sin `by` persiste un actor estable: operator', () => {
  const { line } = srv.validateRuling({ task: 'T-9117', verb: 'approved', note: 'ok' }, []);
  assert.strictEqual(line.by, 'operator', 'una decision sin actor no es consumible por FinalOrchestra');
  const explicit = srv.validateRuling({ task: 'T-9117', verb: 'approved', note: 'ok', by: 'gonzalo' }, []);
  assert.strictEqual(explicit.line.by, 'gonzalo', 'un by explicito no se pisa');
  const { validateRulingLine } = require('../src/rulings.cjs');
  assert.strictEqual(validateRulingLine(line, Date.now()).ok, true);
});
