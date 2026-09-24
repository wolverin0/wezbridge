'use strict';
/**
 * orca-search.test.cjs — T-0576: `orca search`/`orca search --index-status` wrappers.
 * Covers getIndexStatus (enabled/disabled), searchSessions flag pass-through
 * (--scope/--agent/--sort/--limit/--fresh/--path/--since/--cursor/--debug), the
 * disabled-index actionable message on both the status and search paths, and
 * tolerance to CLI failure / malformed JSON. All Orca calls go through a fake
 * runOrcaFn — no real `orca search` here (see the real-CLI smoke output in the
 * T-0576 PR description instead).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const orca = require('../src/orca-search.cjs');

function fakeRunOrcaFn({ stdout, fail = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (fail) throw new Error(fail);
    return typeof stdout === 'function' ? stdout(args) : stdout;
  };
  fn.calls = calls;
  return fn;
}

// ─── getIndexStatus ────────────────────────────────────────────────────────

test('getIndexStatus: enabled index returns {ok:true, enabled:true, status}', async () => {
  const runOrcaFn = fakeRunOrcaFn({
    stdout: JSON.stringify({ ok: true, result: { enabled: true, phase: 'idle', filesIndexed: 42 } }),
  });
  const r = await orca.getIndexStatus({ runOrcaFn });
  assert.equal(r.ok, true);
  assert.equal(r.enabled, true);
  assert.equal(r.status.filesIndexed, 42);
  assert.deepEqual(runOrcaFn.calls, [['search', '--index-status', '--json']]);
});

test('getIndexStatus: disabled index (enabled:false) returns the actionable message, ok:true', async () => {
  const runOrcaFn = fakeRunOrcaFn({
    stdout: JSON.stringify({ ok: true, result: { enabled: false, phase: 'idle', filesIndexed: 0 } }),
  });
  const r = await orca.getIndexStatus({ runOrcaFn });
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false);
  assert.equal(r.message, orca.DISABLED_INDEX_MESSAGE);
  assert.match(r.message, /Session Search \/ History indexing/);
});

// ─── searchSessions: flag pass-through ─────────────────────────────────────

test('searchSessions: passes --scope/--agent/--sort/--limit/--fresh and parses result on an active index', async () => {
  const runOrcaFn = fakeRunOrcaFn({
    stdout: JSON.stringify({ ok: true, result: { kind: 'ok', hits: [{ sessionId: 'abc', snippet: 'hello world' }], cursor: null } }),
  });
  const r = await orca.searchSessions({
    query: 'hello world', scope: 'all', agent: 'claude', sort: 'newest', limit: 3, fresh: true, runOrcaFn,
  });
  assert.equal(r.ok, true);
  assert.equal(r.result.hits.length, 1);
  assert.equal(r.result.hits[0].sessionId, 'abc');
  const args = runOrcaFn.calls[0];
  assert.deepEqual(args, ['search', 'hello world', '--json', '--scope', 'all', '--agent', 'claude', '--sort', 'newest', '--limit', '3', '--fresh']);
});

test('searchSessions: repeatable --agent and --path, plus --since/--cursor/--debug', async () => {
  const runOrcaFn = fakeRunOrcaFn({ stdout: JSON.stringify({ ok: true, result: { kind: 'ok', hits: [] } }) });
  await orca.searchSessions({
    query: 'q', agent: ['claude', 'codex'], path: ['/a', '/b'], since: '2026-08-01T00:00:00Z',
    cursor: 'eyJ2IjoxfQ', debug: true, runOrcaFn,
  });
  const args = runOrcaFn.calls[0];
  assert.deepEqual(args, ['search', 'q', '--json', '--agent', 'claude', '--agent', 'codex',
    '--path', '/a', '--path', '/b', '--since', '2026-08-01T00:00:00Z', '--cursor', 'eyJ2IjoxfQ', '--debug']);
});

test('searchSessions: no query -> {ok:false} without calling the CLI', async () => {
  const runOrcaFn = fakeRunOrcaFn({ stdout: '{}' });
  const r = await orca.searchSessions({ query: '  ', runOrcaFn });
  assert.equal(r.ok, false);
  assert.match(r.reason, /query is required/);
  assert.equal(runOrcaFn.calls.length, 0);
});

// ─── disabled index on the search path ─────────────────────────────────────

test('searchSessions: disabled index ({kind:"unavailable",reason:"disabled"}) -> actionable message, no throw', async () => {
  const runOrcaFn = fakeRunOrcaFn({
    stdout: JSON.stringify({ ok: true, result: { kind: 'unavailable', reason: 'disabled' } }),
  });
  const r = await orca.searchSessions({ query: 'anything', runOrcaFn });
  assert.equal(r.ok, false);
  assert.equal(r.disabled, true);
  assert.equal(r.reason, orca.DISABLED_INDEX_MESSAGE);
});

test('searchSessions: other "unavailable" reasons surface the reason, not the disabled-index message', async () => {
  const runOrcaFn = fakeRunOrcaFn({
    stdout: JSON.stringify({ ok: true, result: { kind: 'unavailable', reason: 'not-supported' } }),
  });
  const r = await orca.searchSessions({ query: 'anything', runOrcaFn });
  assert.equal(r.ok, false);
  assert.equal(r.disabled, undefined);
  assert.match(r.reason, /not-supported/);
  assert.notEqual(r.reason, orca.DISABLED_INDEX_MESSAGE);
});

// ─── failure tolerance ──────────────────────────────────────────────────────

test('searchSessions/getIndexStatus: CLI failure and malformed JSON both degrade to {ok:false, reason}, never throw', async () => {
  const failFn = fakeRunOrcaFn({ fail: 'spawn orca ENOENT' });
  const s1 = await orca.searchSessions({ query: 'x', runOrcaFn: failFn });
  assert.equal(s1.ok, false);
  assert.match(s1.reason, /ENOENT/);
  const st1 = await orca.getIndexStatus({ runOrcaFn: failFn });
  assert.equal(st1.ok, false);
  assert.match(st1.reason, /ENOENT/);

  const garbageFn = fakeRunOrcaFn({ stdout: 'not json' });
  const s2 = await orca.searchSessions({ query: 'x', runOrcaFn: garbageFn });
  assert.equal(s2.ok, false);
  assert.match(s2.reason, /unparseable/);

  const notOkFn = fakeRunOrcaFn({ stdout: JSON.stringify({ ok: false, error: 'not paired' }) });
  const s3 = await orca.searchSessions({ query: 'x', runOrcaFn: notOkFn });
  assert.equal(s3.ok, false);
  assert.match(s3.reason, /not paired/);
});

test('defaultRunOrca against a missing binary degrades instead of throwing an uncaught rejection', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const r = await orca.searchSessions({
    query: 'x',
    runOrcaFn: (a) => orca.defaultRunOrca(a, { bin: path.join(os.tmpdir(), 'no-such-orca.exe') }),
  });
  assert.equal(r.ok, false);
});
