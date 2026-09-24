'use strict';
/**
 * orca-send.test.cjs — T-0596: sendToOrcaTerminal (last-hop delivery to an Orca
 * terminal) against a fake runOrca, mirroring orca-census.test.cjs's style.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const orcaSend = require('../src/orca-send.cjs');

function fakeRunOrca({ sendOk = true, sendError = null, tailByHandle = {}, throwOnSend = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (args[1] === 'send') {
      if (throwOnSend) throw new Error(throwOnSend);
      if (!sendOk) return JSON.stringify({ ok: false, error: sendError || 'send failed' });
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

test('sendToOrcaTerminal: happy path returns delivered:ok, submitted:submitted, ok:true, with screen evidence', async () => {
  const body = 'smoke T-0596 transporte orca — ignorar';
  const runOrca = fakeRunOrca({ tailByHandle: { term_x: ['prior line', body, '❯ '] } });
  const res = await orcaSend.sendToOrcaTerminal('term_x', body, { runOrca, sleep: noSleep, retryId: 'r1' });
  assert.equal(res.ok, true);
  assert.equal(res.submitted, 'submitted');
  assert.equal(res.delivered, 'ok');
  assert.ok(Array.isArray(res.tail));
  const sendCall = runOrca.calls.find((c) => c[1] === 'send');
  assert.ok(sendCall.includes('--retry-request'));
  assert.equal(sendCall[sendCall.indexOf('--retry-request') + 1], 'r1');
  assert.ok(sendCall.includes('--enter'));
});

test('sendToOrcaTerminal: CLI-level send failure -> ok:false, submitted/delivered unknown, error surfaced', async () => {
  const runOrca = fakeRunOrca({ sendOk: false, sendError: 'terminal not writable' });
  const res = await orcaSend.sendToOrcaTerminal('term_x', 'body', { runOrca, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(res.submitted, 'unknown');
  assert.equal(res.delivered, 'unknown');
  assert.match(res.error, /terminal not writable/);
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

test('sendToOrcaTerminal: idempotent retry — same retryId sent twice reaches the CLI with the same --retry-request value', async () => {
  const body = 'resend me';
  const runOrca = fakeRunOrca({ tailByHandle: { term_x: [body] } });
  await orcaSend.sendToOrcaTerminal('term_x', body, { runOrca, sleep: noSleep, retryId: 'stable-id' });
  await orcaSend.sendToOrcaTerminal('term_x', body, { runOrca, sleep: noSleep, retryId: 'stable-id' });
  const sendCalls = runOrca.calls.filter((c) => c[1] === 'send');
  assert.equal(sendCalls.length, 2);
  for (const c of sendCalls) assert.equal(c[c.indexOf('--retry-request') + 1], 'stable-id');
});
