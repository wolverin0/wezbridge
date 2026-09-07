'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NOW = Date.parse('2026-09-07T06:00:00Z');

function fixture(t, tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-waiting-'));
  const previous = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  fs.mkdirSync(path.join(dir, 'tasks'));
  for (const task of tasks) fs.writeFileSync(path.join(dir, 'tasks', `${task.id}.json`), JSON.stringify(task));
  for (const name of ['../scripts/fleet-board.cjs', '../src/decision-push.cjs']) delete require.cache[require.resolve(name)];
  t.after(() => {
    if (previous === undefined) delete process.env.WEZBRIDGE_INTEL_DIR;
    else process.env.WEZBRIDGE_INTEL_DIR = previous;
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, board: require('../scripts/fleet-board.cjs'), push: require('../src/decision-push.cjs') };
}

function card(id, overrides = {}) {
  return { id, repo: 'wezbridge', title: `Question ${id}`, state: 'review',
    gate: null, contract: { gate: null }, blocked_by: 'agent',
    created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(), ...overrides };
}

function waitingIds(html) {
  const section = html.match(/<h2>Decisions waiting on you[\s\S]*?(?=<h2>Waiting on me)/);
  assert.ok(section, 'the actual waiting section must be rendered');
  return [...section[0].matchAll(/<summary><b>(T-\d{4})<\/b>/g)].map(match => match[1]).sort();
}

test('T-0413 AC1 killer: operator-blocked review with no gate appears in rendered waiting list', t => {
  const task = card('T-9300', { blocked_by: 'operator' });
  const { dir, board } = fixture(t, [task]);
  const file = path.join(dir, 'tasks', `${task.id}.json`);
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(waitingIds(board.build(NOW)), ['T-9300']);
  assert.equal(board.gateOf(task), null, 'visibility must not grant an execution gate');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'rendering must not rewrite task authority');
});

test('T-0413 AC3 killer: rendered board and push select the same exact tasks across every state and gate shape', t => {
  const states = ['queued', 'ready', 'running', 'review', 'blocked', 'failed', 'done', 'cancelled'];
  const shapes = [{ blocked_by: 'operator' }, { gate: 'operator' },
    { contract: { gate: 'operator' } }, { gate: 'agent', blocked_by: 'operator' },
    { blocked_by: 'agent' }, { blocked_by: 'external', blocker: 'operator mentioned in ordinary prose' }];
  const tasks = states.flatMap((state, s) => shapes.map((shape, n) => card(`T-${9400 + s * 10 + n}`, { state, ...shape })));
  const expected = states.slice(0, 6).flatMap((_, s) => [0, 1, 2, 3].map(n => `T-${9400 + s * 10 + n}`)).sort();
  const { board, push } = fixture(t, tasks);
  const rendered = waitingIds(board.build(NOW));
  const selected = push.detectNewDecisions(tasks, {}, NOW).toNotify.map(task => task.id).sort();
  assert.deepEqual(rendered, expected, 'all open questions, including failed tasks, are visible');
  assert.deepEqual(selected, rendered, 'push and board must never disagree on state or gate shape');
});

test('T-0413 blocked_by decisions notify once, clear on agent ownership, and notify again on a new operator wait', async t => {
  const waiting = card('T-9301', { blocked_by: 'operator' });
  const { push } = fixture(t, [waiting]);
  const sent = [];
  const send = async (_text, task) => { sent.push(task.id); return { ok: true }; };
  await push.pushDecisions({ tasks: [waiting], send, now: NOW });
  await push.pushDecisions({ tasks: [waiting], send, now: NOW + 1 });
  assert.deepEqual(sent, ['T-9301'], 'unchanged operator wait sends only once');
  await push.pushDecisions({ tasks: [{ ...waiting, blocked_by: 'agent' }], send, now: NOW + 2 });
  await push.pushDecisions({ tasks: [waiting], send, now: NOW + 3 });
  assert.deepEqual(sent, ['T-9301', 'T-9301'], 'a later wait is a new question');
});
