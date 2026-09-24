'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 't0377-routing-'));
process.env.WEZBRIDGE_INTEL_DIR = root;
// T-0596 item 4: legacy WezTerm-pane queue delivery, gated off by default — opt in for this file.
process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
const pq = require('../src/project-queue.cjs');
const pane = (paneId, project, title = project) => ({ paneId, project: 'G:/projects/' + project,
  agent: 'claude', status: 'idle', tabTitle: title });

function fixture(t) {
  const base = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const calls = [];
  const send = { sendPromptDeferredEnter: async (paneId, body) => { calls.push({ paneId, body }); return 'ok'; },
    verifyPromptSubmission: async () => 'submitted' };
  const enqueue = (corr = 'T0377-one') => {
    const result = pq.enqueue({ project: 'bajoneando', corr, type: 'request', from_project: 'orchestrator',
      resolved_pane: 46, ok: false, body: 'Harmless routing probe ' + corr }, { base });
    // Preserve a legacy to_pane field as well; neither hint is identity.
    const record = JSON.parse(fs.readFileSync(result.file, 'utf8').trim().split('\n').pop());
    fs.appendFileSync(result.file, JSON.stringify({ ...record, to_pane: 46 }) + '\n');
    return result;
  };
  const consumer = (discoverPanes, extra = {}) => pq.createConsumer({ project: 'bajoneando', base,
    discoverPanes, send, cooldownMs: 0, logAction: () => {}, ...extra });
  const events = () => fs.existsSync(path.join(base, 'events.jsonl'))
    ? fs.readFileSync(path.join(base, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { base, calls, send, enqueue, consumer, events };
}

test('AC1 control: old pane 46 belongs to another project; delivery goes to current project pane 7', async t => {
  const f = fixture(t); f.enqueue();
  const result = await f.consumer(() => [pane(46, 'omniremote'), pane(7, 'bajoneando')]).drain();
  assert.equal(result.delivered, 1);
  assert.deepEqual(f.calls.map(call => call.paneId), [7]);
  assert.match(f.calls[0].body, /to bajoneando/);
});

test('AC1 fail-first: absent project is dropped with an event and cannot resurrect after restart', async t => {
  const f = fixture(t); const entry = f.enqueue();
  const result = await f.consumer(() => [pane(46, 'omniremote')]).drain();
  assert.equal(result.delivered, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(result.pending, 0, 'missing destination must be dropped, not left for stale replay');
  const event = f.events().find(event => event.event === 'queue.entry_dropped');
  assert.equal(event.id, entry.id);
  assert.equal(event.reason, 'project-not-live');
  await f.consumer(() => [pane(7, 'bajoneando')]).drain();
  assert.equal(f.calls.length, 0, 'restart must preserve the explicit discard');
});

test('AC1 fail-first: stale tab label cannot impersonate a project whose cwd is absent', async t => {
  const f = fixture(t); f.enqueue();
  const result = await f.consumer(() => [pane(46, 'omniremote', 'bajoneando')]).drain();
  assert.equal(result.delivered, 0, 'foreign cwd must not receive the queued envelope');
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().find(event => event.event === 'queue.entry_dropped').reason, 'project-not-live');
});

test('AC1 fail-first: a restore between two envelopes forces fresh project resolution for the second', async t => {
  const f = fixture(t); f.enqueue('first'); f.enqueue('second');
  let panes = [pane(46, 'bajoneando')];
  const send = { ...f.send, sendPromptDeferredEnter: async (paneId, body) => {
    f.calls.push({ paneId, body });
    panes = [pane(46, 'omniremote'), pane(7, 'bajoneando')];
    return 'ok';
  } };
  const result = await f.consumer(() => panes, { send }).drain();
  assert.equal(result.delivered, 2);
  assert.deepEqual(f.calls.map(call => call.paneId), [46, 7]);
});

test('discovery failure is uncertainty, not proof that the project has no pane', async t => {
  const f = fixture(t); f.enqueue();
  const result = await f.consumer(() => { throw new Error('mux unavailable'); }).drain();
  assert.equal(result.pending, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().length, 0);
});

test('mandatory discard audit failure preserves the decision for retry without later delivery', async t => {
  const f = fixture(t); const entry = f.enqueue();
  fs.mkdirSync(path.join(f.base, 'events.jsonl'));
  const first = f.consumer(() => []);
  await assert.rejects(first.drain());
  assert.equal(first.status().pending, 1);
  assert.equal(first._state.suppressed[entry.id].reported, false);
  fs.rmdirSync(path.join(f.base, 'events.jsonl'));
  await f.consumer(() => [pane(7, 'bajoneando')]).drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().filter(event => event.event === 'queue.entry_dropped').length, 1);
  await f.consumer(() => [pane(7, 'bajoneando')]).drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().length, 1);
});

test('the envelope project survives a sanitized queue filename', async t => {
  const f = fixture(t);
  const queued = pq.enqueue({ project: 'group/bajoneando', corr: 'nested-project', type: 'request',
    body: 'Harmless nested project probe', resolved_pane: 46, ok: false }, { base: f.base });
  assert.equal(queued.ok, true);
  const result = await f.consumer(() => [pane(46, 'omniremote'), pane(7, 'bajoneando')],
    { project: 'group-bajoneando' }).drain();
  assert.equal(result.delivered, 1);
  assert.deepEqual(f.calls.map(call => call.paneId), [7]);
});

test('disappearance between envelopes drops the remainder instead of reusing the old pane', async t => {
  const f = fixture(t); f.enqueue('first'); f.enqueue('second');
  let panes = [pane(46, 'bajoneando')];
  const send = { ...f.send, sendPromptDeferredEnter: async (paneId, body) => {
    f.calls.push({ paneId, body }); panes = [pane(46, 'omniremote')]; return 'ok';
  } };
  const result = await f.consumer(() => panes, { send }).drain();
  assert.equal(result.delivered, 1); assert.equal(result.dropped, 1); assert.equal(result.pending, 0);
  assert.deepEqual(f.calls.map(call => call.paneId), [46]);
  assert.equal(f.events().find(event => event.event === 'queue.entry_dropped').corr, 'second');
});

test('dry-run cannot consume or emit a discard for an absent destination', async t => {
  const f = fixture(t); f.enqueue();
  await f.consumer(() => [{ ...pane(7, 'bajoneando'), status: 'working' }]).drain();
  const result = await f.consumer(() => []).drain({ dryRun: true });
  assert.equal(result.pending, 1); assert.equal(f.events().length, 0); assert.equal(f.calls.length, 0);
});

test('audit retry survives a later verified sender record removing the pending copy', async t => {
  const f = fixture(t); const entry = f.enqueue();
  fs.mkdirSync(path.join(f.base, 'events.jsonl'));
  await assert.rejects(f.consumer(() => []).drain());
  fs.rmdirSync(path.join(f.base, 'events.jsonl'));
  const original = JSON.parse(fs.readFileSync(entry.file, 'utf8').trim().split('\n')[0]);
  pq.enqueue({ ...original, ok: true }, { base: f.base });
  await f.consumer(() => [pane(7, 'bajoneando')]).drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.events().filter(event => event.event === 'queue.entry_dropped').length, 1);
});
