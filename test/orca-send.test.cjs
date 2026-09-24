'use strict';
/**
 * orca-send.test.cjs — T-0596: sendToOrcaTerminal (last-hop delivery to an Orca
 * terminal) against a fake runOrca, mirroring orca-census.test.cjs's style.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const orcaSend = require('../src/orca-send.cjs');

function fakeRunOrca({ sendOk = true, sendError = null, tailByHandle = {}, throwOnSend = null, ambiguousThenOk = null } = {}) {
  const calls = [];
  let sendCallCount = 0;
  const fn = async (args) => {
    calls.push(args);
    if (args[1] === 'send') {
      sendCallCount += 1;
      if (throwOnSend) throw new Error(throwOnSend);
      // Measured real-CLI shape: the FIRST attempt (no --retry-request) is
      // refused with an orchestrationRequestId; a SECOND attempt reissued
      // with EXACTLY that id (as the real contract requires) succeeds.
      if (ambiguousThenOk && sendCallCount === 1) {
        return JSON.stringify({ ok: false, error: { code: 'ambiguous_transport_failure', message: 'retry with the reported id', data: { orchestrationRequestId: ambiguousThenOk } } });
      }
      if (!sendOk) return JSON.stringify({ ok: false, error: sendError || { code: 'send_failed', message: 'send failed' } });
      return JSON.stringify({ ok: true, result: { accepted: true } });
    }
    if (args[1] === 'read') {
      const h = args[args.indexOf('--terminal') + 1];
      const tail = tailByHandle[h];
      if (!tail) return JSON.stringify({ ok: false, error: 'unknown terminal' });
      return JSON.stringify({ ok: true, result: { terminal: { handle: h, tail, source: 'screen' } } });
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

test('screenShowsSubmittedBody: true when the head is in scrollback and not held in the composer', () => {
  const tail = ['some prior output', 'FinalOrchestra JOB-9: COMPLETED and done', '❯ '];
  assert.equal(orcaSend.screenShowsSubmittedBody(tail, 'FinalOrchestra JOB-9: COMPLETED and done'), true);
});

test('screenShowsSubmittedBody: false when the text still sits unsent in the composer', () => {
  const tail = ['some prior output', '❯ FinalOrchestra JOB-9: COMPLETED and'];
  assert.equal(orcaSend.screenShowsSubmittedBody(tail, 'FinalOrchestra JOB-9: COMPLETED and done'), false);
});

test('sendToOrcaTerminal: happy path (clean first attempt) returns delivered:ok, submitted:submitted, ok:true, with screen evidence, and sends NO --retry-request', async () => {
  const body = 'smoke T-0596 transporte orca — ignorar';
  const runOrca = fakeRunOrca({ tailByHandle: { term_x: ['prior line', body, '❯ '] } });
  const res = await orcaSend.sendToOrcaTerminal('term_x', body, { runOrca, sleep: noSleep });
  assert.equal(res.ok, true);
  assert.equal(res.submitted, 'submitted');
  assert.equal(res.delivered, 'ok');
  assert.equal(res.retryId, null, 'a clean first attempt never reissues, so there is no orchestration id to report');
  assert.ok(Array.isArray(res.tail));
  const sendCalls = runOrca.calls.filter((c) => c[1] === 'send');
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].includes('--retry-request'), false,
    'measured against the real orca.exe: a caller-chosen --retry-request on a FIRST attempt is refused as invalid_argument');
  assert.ok(sendCalls[0].includes('--enter'));
});

test('sendToOrcaTerminal: an ambiguous-transport refusal is reissued ONCE with the EXACT id Orca reported, and that retry succeeds', async () => {
  const body = 'resend me';
  const runOrca = fakeRunOrca({ ambiguousThenOk: 'orca-reported-uuid-123', tailByHandle: { term_x: [body] } });
  const res = await orcaSend.sendToOrcaTerminal('term_x', body, { runOrca, sleep: noSleep });
  assert.equal(res.ok, true);
  assert.equal(res.retryId, 'orca-reported-uuid-123');
  const sendCalls = runOrca.calls.filter((c) => c[1] === 'send');
  assert.equal(sendCalls.length, 2, 'exactly one reissue, not an open-ended retry loop');
  assert.equal(sendCalls[0].includes('--retry-request'), false, 'the FIRST attempt never carries a retry id');
  assert.equal(sendCalls[1][sendCalls[1].indexOf('--retry-request') + 1], 'orca-reported-uuid-123',
    'the reissue must use the EXACT id Orca reported, not a caller-derived one');
});

test('sendToOrcaTerminal: CLI-level send failure with NO orchestrationRequestId -> ok:false, single attempt (nothing to reissue with)', async () => {
  const runOrca = fakeRunOrca({ sendOk: false, sendError: { code: 'terminal_not_writable', message: 'terminal not writable' } });
  const res = await orcaSend.sendToOrcaTerminal('term_x', 'body', { runOrca, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(res.submitted, 'unknown');
  assert.equal(res.delivered, 'unknown');
  assert.match(res.error, /terminal not writable/);
  assert.equal(runOrca.calls.filter((c) => c[1] === 'send').length, 1, 'no orchestrationRequestId to reissue with -> no retry attempted');
});

test('sendToOrcaTerminal: transport exception (spawn ENOENT etc.) -> ok:false, never throws', async () => {
  const runOrca = fakeRunOrca({ throwOnSend: 'spawn orca ENOENT' });
  const res = await orcaSend.sendToOrcaTerminal('term_x', 'body', { runOrca, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.match(res.error, /ENOENT/);
});

test('sendToOrcaTerminal: send accepted but read-back never shows the body -> NOT counted as delivered (W4 posture)', async () => {
  const body = 'a distinctive envelope body for this test';
  const runOrca = fakeRunOrca({ tailByHandle: { term_x: ['unrelated scrollback only'] } });
  const res = await orcaSend.sendToOrcaTerminal('term_x', body, { runOrca, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(res.delivered, 'unknown');
});

test('sendToOrcaTerminal: read-back unreadable (unknown terminal) -> ok:false, delivered unknown, does not throw', async () => {
  const runOrca = fakeRunOrca({ tailByHandle: {} });
  const res = await orcaSend.sendToOrcaTerminal('term_missing', 'body', { runOrca, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(res.delivered, 'unknown');
});

test('defaultRunOrca: a CLI that exits non-zero but still writes a JSON body to stdout resolves with that body (measured against real orca.exe 2026-09-24 — a stale-handle refusal exits non-zero while stdout carries {ok:false,...})', async () => {
  const path = require('node:path');
  const script = path.join(__dirname, 'mocks', 'orca-mock-exit-nonzero.cjs');
  const stdout = await orcaSend.defaultRunOrca(['terminal', 'send', '--terminal', 'x'], { bin: script, timeoutMs: 5000 });
  const j = JSON.parse(stdout);
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'terminal_handle_stale');
});

test('defaultRunOrca: a truly empty stdout (real transport failure, e.g. spawn ENOENT) still rejects', async () => {
  await assert.rejects(
    () => orcaSend.defaultRunOrca(['terminal', 'list'], { bin: 'G:/no-such-orca-binary.exe', timeoutMs: 5000 }),
  );
});
