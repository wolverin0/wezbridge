'use strict';
// T-0327 supersedes automatic spill-and-send with explicit refusal and caller opt-in.
// These use the real stdio MCP server; no source-order assertions substitute for effects.
require('./setup.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// T-0400: spawn-and-JSON-RPC boilerplate now lives in test/helpers/mcp-call.cjs
// (shared with test/mcp-server-v35-tools.test.cjs) — callA2aSend/fixture/textOf
// here are the SAME functions, just no longer duplicated in this file.
const { callA2aSend, textOf, fixture: sharedFixture } = require('./helpers/mcp-call.cjs');

function fixture(t) {
  return sharedFixture(t, 't0327-length-policy-');
}
const args = extra => ({ from_pane: 1, to_project: 't0327-unavailable', corr: 'length-policy', type: 'request', ...extra });

for (const body of ['x'.repeat(901), 'x'.repeat(1800), '?'.repeat(901)]) {
  test(`refused long body creates neither spill nor queued delivery (${body.length}/${Buffer.byteLength(body)} bytes)`, async t => {
    const dir = fixture(t);
    const result = await callA2aSend(args({ body }), { WEZBRIDGE_INTEL_DIR: dir });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /REFUSED/);
    assert.match(textOf(result), /_intel\/briefs/);
    assert.equal(fs.existsSync(path.join(dir, 'spill')), false);
    assert.equal(fs.existsSync(path.join(dir, 'queues/t0327-unavailable.jsonl')), false);
  });
}

test('refusal does not depend on writable spill storage', async t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'spill'), 'occupied');
  const result = await callA2aSend(args({ body: 'x'.repeat(901) }), { WEZBRIDGE_INTEL_DIR: dir });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /REFUSED/);
  assert.equal(fs.readFileSync(path.join(dir, 'spill'), 'utf8'), 'occupied');
});

test('explicit allow_long preserves the full queued body', async t => {
  const dir = fixture(t); const body = 'inline opt-in '.repeat(110);
  const result = await callA2aSend(args({ body, allow_long: true }), { WEZBRIDGE_INTEL_DIR: dir });
  assert.notEqual(result.isError, true);
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'queues/t0327-unavailable.jsonl'), 'utf8').trim());
  assert.equal(row.body, body);
  assert.equal(fs.existsSync(path.join(dir, 'spill')), false);
});

test('long result is refused before result recording or ledger linking', async t => {
  const dir = fixture(t);
  const body = 'criteria:\n- scope: pass ? fixture\n' + 'x'.repeat(901);
  const result = await callA2aSend(args({ type: 'result', body }), { WEZBRIDGE_INTEL_DIR: dir });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /REFUSED/);
  assert.equal(fs.existsSync(path.join(dir, 'a2a-results.jsonl')), false);
});

test('allow_long cannot bypass result-shape enforcement', async t => {
  const dir = fixture(t);
  const result = await callA2aSend(args({ type: 'result', body: 'x'.repeat(901), allow_long: true }), { WEZBRIDGE_INTEL_DIR: dir });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /result-shape: BLOCKED/);
});

test('allow_long cannot bypass the existing prompt byte cap', async t => {
  const dir = fixture(t);
  const result = await callA2aSend(args({ body: 'x'.repeat(17000), allow_long: true }), { WEZBRIDGE_INTEL_DIR: dir });
  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(path.join(dir, 'queues/t0327-unavailable.jsonl')), false);
});
