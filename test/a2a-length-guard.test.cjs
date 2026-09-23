'use strict';
/**
 * a2a-length-guard.test.cjs
 *
 * These CALL the rule with real inputs. The first version of this file only
 * grepped mcp-server.cjs for a constant name, and a mutation that replaced the
 * guard's condition with `if (false)` left all seven tests green — because the
 * constant still appeared inside the refusal message the guard returns. The
 * mutation proof is what exposed that; without it the suite would have looked
 * healthy while testing nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { a2aLengthRefusal, A2A_BODY_SOFT_LIMIT } = require('../src/a2a-length-guard.cjs');

const body = (n) => 'x'.repeat(n);

// ---------------------------------------------------------------------------
// Behaviour — these exercise the rule itself.
// ---------------------------------------------------------------------------

test('refuses a body over the soft limit', () => {
  const r = a2aLengthRefusal(body(1500), undefined);
  assert.ok(r, 'an over-limit body must be refused');
  assert.match(r, /REFUSED/);
  assert.match(r, /1500 chars/, 'the refusal states the actual length, not a generic complaint');
});

test('allows a body at or under the soft limit', () => {
  assert.strictEqual(a2aLengthRefusal(body(400), undefined), null, 'short acks must never be blocked');
  assert.strictEqual(a2aLengthRefusal(body(A2A_BODY_SOFT_LIMIT), undefined), null,
    'exactly at the limit is allowed — an off-by-one here blocks legitimate sends');
});

test('ANTI-WOLF: ordinary short envelopes are never refused', () => {
  for (const n of [1, 50, 200, 600, 899, 900]) {
    assert.strictEqual(a2aLengthRefusal(body(n), undefined), null, `${n} chars must pass`);
  }
});

test('allow_long is a deliberate opt-out and only boolean true counts', () => {
  assert.strictEqual(a2aLengthRefusal(body(5000), true), null, 'an explicit opt-in must work');
  assert.ok(a2aLengthRefusal(body(5000), 'yes'), 'a truthy string must NOT open the escape hatch');
  assert.ok(a2aLengthRefusal(body(5000), 1), 'a truthy number must NOT open it either');
  assert.ok(a2aLengthRefusal(body(5000), {}), 'a truthy object must NOT open it either');
});

test('the refusal explains the remedy rather than just saying no', () => {
  const r = a2aLengthRefusal(body(2000), false);
  assert.match(r, /_intel\/briefs/, 'names the file-pointer remedy concretely');
  assert.match(r, /allow_long: true/, 'states the escape hatch');
  assert.match(r, /silently incomplete/, 'says WHY — the failure is invisible to the recipient');
});

test('the limit is configurable but defaults conservatively', () => {
  assert.strictEqual(a2aLengthRefusal(body(500), undefined, 100)?.includes('soft limit 100'), true,
    'an injected limit must actually be used');
  assert.ok(A2A_BODY_SOFT_LIMIT > 0 && A2A_BODY_SOFT_LIMIT <= 4096, 'default must be a sane ceiling');
});

test('non-string bodies are measured, not crashed on', () => {
  assert.strictEqual(a2aLengthRefusal(null, undefined), null);
  assert.strictEqual(a2aLengthRefusal(undefined, undefined), null);
});

// ---------------------------------------------------------------------------
// Wiring — the rule must be CALLED by a2a_send, and called before the send.
// A guard that exists but is never invoked is the "built but never connected"
// defect this fleet found 11 times in one repo.
// ---------------------------------------------------------------------------

// T-0400: was a source-order check (index of the call vs. index of the send
// literal) — an `if (false)` around the real refusal check leaves those two
// literals in the same relative order, so the regex/index comparison stays
// green while nothing stops the send. Rewritten to invoke the real
// mcp-server against test/mocks/wezterm-echo-mock.cjs (the ONE double that
// actually echoes what reached the pane — the default static mock never
// would, so "nothing was sent" would be true trivially against it) and prove
// BOTH halves for real: the call is refused, AND the envelope never reaches
// the pane.
test('a2a_send calls the guard, and calls it BEFORE sending', async (t) => {
  const { callTool, resultText, fixture } = require('./helpers/mcp-call.cjs');
  const dir = fixture(t, 'a2a-length-guard-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-length-guard-echo-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const env = {
    WEZBRIDGE_INTEL_DIR: dir,
    // T-0400 fix-up: WEZBRIDGE_WEZTERM_BIN is always clobbered by setup.cjs in
    // the child now; route the echo double through WEZBRIDGE_TEST_WEZTERM_BIN.
    WEZBRIDGE_TEST_WEZTERM_BIN: path.join(__dirname, 'mocks', 'wezterm-echo-mock.cjs'),
    WEZBRIDGE_MOCK_ECHO_STATE: path.join(stateDir, 'state.json'),
  };
  const corr = 'len-guard-real-1';
  const res = await callTool('a2a_send', { to_pane: 1, from_pane: 777, corr, type: 'request', body: body(1500) }, env);
  assert.equal(res.result.isError, true);
  assert.match(resultText(res), /REFUSED/);
  assert.match(resultText(res), /1500 chars/);

  // If the guard ran AFTER the send (or not at all), the echo mock would have
  // recorded the envelope, and it would show up here — the exact regression
  // an index-order source check cannot catch.
  const read = await callTool('read_output', { pane_id: 1, lines: 20 }, env);
  assert.doesNotMatch(resultText(read), new RegExp(corr), 'the refused envelope must never reach the pane — the guard must run BEFORE the send');
});

test('allow_long is exposed in the tool schema, or the escape hatch is unreachable', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.cjs'), 'utf8');
  const schema = src.slice(src.indexOf("name: 'a2a_send'"), src.indexOf("required: ['to_pane', 'body']"));
  assert.match(schema, /allow_long/);
});
