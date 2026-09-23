'use strict';

/**
 * alert-fallback.test.cjs — T-0526: sendFallback() channel selection, error
 * aggregation, and the "no channel configured" loud-not-silent path. Every
 * sender/enabled check is injected via `senders` — no real network, no env
 * var mutation of the process (ntfy/telegram config is read through the
 * injected *Enabled() checks here, never process.env directly).
 */

const test = require('node:test');
const assert = require('node:assert');
const { sendFallback } = require('../src/alert-fallback.cjs');

test('T-0526: neither channel configured -> ok:false with a stated reason, nothing sent', async () => {
  let sent = false;
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => false,
      telegramEnabled: () => false,
      sendNtfy: async () => { sent = true; return true; },
      sendTelegram: async () => { sent = true; return { ok: true }; },
    },
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'no fallback channel configured' });
  assert.strictEqual(sent, false, 'an unconfigured channel must never be called');
});

test('T-0526: ntfy only, success', async () => {
  let receivedMessage = null;
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => true,
      telegramEnabled: () => false,
      sendNtfy: async (msg) => { receivedMessage = msg; return true; },
    },
  });
  assert.strictEqual(receivedMessage, 'DAEMON DOWN');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.channel, 'ntfy');
  assert.strictEqual(result.error, undefined);
});

test('T-0526: telegram only, failure is reported with an error, not swallowed', async () => {
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => false,
      telegramEnabled: () => true,
      sendTelegram: async () => ({ ok: false, status: 401, error: 'Unauthorized' }),
    },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.channel, 'telegram');
  assert.match(result.error, /telegram:Unauthorized/);
});

test('T-0526: both configured, both succeed -> ok:true, both channels named', async () => {
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => true,
      telegramEnabled: () => true,
      sendNtfy: async () => true,
      sendTelegram: async () => ({ ok: true, status: 200 }),
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.channel, 'ntfy,telegram');
});

test('T-0526: both configured, one fails -> ok:true overall (at least one channel landed), error still recorded', async () => {
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => true,
      telegramEnabled: () => true,
      sendNtfy: async () => false,
      sendTelegram: async () => ({ ok: true, status: 200 }),
    },
  });
  assert.strictEqual(result.ok, true, 'one landed channel is still a delivered alert');
  assert.match(result.error, /ntfy:failed/);
});

test('T-0526: both configured, both fail -> ok:false, both errors recorded', async () => {
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => true,
      telegramEnabled: () => true,
      sendNtfy: async () => false,
      sendTelegram: async () => ({ ok: false, error: 'timeout' }),
    },
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /ntfy:failed/);
  assert.match(result.error, /telegram:timeout/);
});

test('T-0526: a throwing sender is caught, not propagated to the caller', async () => {
  const result = await sendFallback('DAEMON DOWN', {
    senders: {
      ntfyEnabled: () => true,
      telegramEnabled: () => false,
      sendNtfy: async () => { throw new Error('socket hang up'); },
    },
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /socket hang up/);
});
