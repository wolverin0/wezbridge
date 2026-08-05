/**
 * verified-send.test.cjs — locks the extracted delivery-verification behaviour.
 *
 * These functions encode three production fixes (multi-line stuck detection
 * 07-10, bracketed-paste anti-splice 07-21, collapsed-paste false-truncation
 * 07-25). The tests pin the verdicts so a future "simplification" that
 * reintroduces any of those bugs fails here, not in a live dispatch.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { inputBoxContent, createVerifiedSend } = require('../src/verified-send.cjs');

const instantSleep = () => Promise.resolve();

function fakeWez(overrides = {}) {
  const calls = { sendText: [], sendTextBracketed: [], sendTextNoEnter: [], invalidations: 0 };
  return {
    calls,
    invalidateGetTextCache() { calls.invalidations += 1; },
    getFullText() { return ''; },
    sendText(paneId, text) { calls.sendText.push({ paneId, text }); },
    sendTextBracketed(paneId, text) { calls.sendTextBracketed.push({ paneId, text }); },
    sendTextNoEnter(paneId, text) { calls.sendTextNoEnter.push({ paneId, text }); },
    ...overrides,
  };
}

// ---------------------------------------------------------------- inputBoxContent
test('inputBoxContent takes the BOTTOM-MOST marker line, not the first', () => {
  const lines = ['❯ old scrollback prompt', 'output', '│ ❯ current text here │'];
  assert.equal(inputBoxContent(lines), 'current text here');
});

test('inputBoxContent returns empty for a pane with no composer marker', () => {
  assert.equal(inputBoxContent(['just', 'plain', 'output']), '');
});

// ---------------------------------------------------------------- verifyPromptSubmission
test('submitted: composer is empty after send', async () => {
  const wez = fakeWez({ getFullText: () => 'work output\n❯ \n' });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(await vs.verifyPromptSubmission(1, 'hello world message'), 'submitted');
});

test('stuck: composer still shows the HEAD of our text; enter-nudges are sent', async () => {
  const wez = fakeWez({ getFullText: () => '❯ hello world message' });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(await vs.verifyPromptSubmission(1, 'hello world message', { retries: 2 }), 'stuck');
  assert.equal(wez.calls.sendText.length, 3, 'one nudge per attempt');
});

test('stuck: multi-line paste shows only its LAST line in the composer (07-10 fix)', async () => {
  const text = 'first line of envelope\nsecond line\nthe visible tail line';
  const wez = fakeWez({ getFullText: () => '❯ the visible tail line' });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(await vs.verifyPromptSubmission(1, text), 'stuck',
    'comparing only the head must not report submitted');
});

test('stuck: paste placeholder in composer counts as unsubmitted', async () => {
  const wez = fakeWez({ getFullText: () => '❯ [Pasted text +42 lines]' });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(await vs.verifyPromptSubmission(1, 'anything at all here'), 'stuck');
});

test('unknown: unreadable pane or empty text', async () => {
  const throwing = fakeWez({ getFullText: () => { throw new Error('pane gone'); } });
  const vs = createVerifiedSend({ wez: throwing, sleep: instantSleep });
  assert.equal(await vs.verifyPromptSubmission(1, 'some text here'), 'unknown');
  assert.equal(await vs.verifyPromptSubmission(1, '   '), 'unknown');
});

// ---------------------------------------------------------------- composerHoldsTail
test('ok: rendered pane holds the payload tail', () => {
  const text = 'a reasonably long payload whose tail must be visible in the pane';
  const wez = fakeWez({ getFullText: () => `stuff before ${text} stuff after` });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(vs.composerHoldsTail(1, text), 'ok');
});

test('truncated: tail missing from the rendered pane', () => {
  const wez = fakeWez({ getFullText: () => 'only the head of the payload arrived and then' });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(vs.composerHoldsTail(1, 'only the head of the payload arrived and then SOME TAIL THAT IS GONE'), 'truncated');
});

test('unknown, not truncated: collapsed paste placeholder (07-25 fix)', () => {
  const wez = fakeWez({ getFullText: () => '❯ [Pasted text #1 +120 lines] paste again to expand' });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  assert.equal(vs.composerHoldsTail(1, 'a long payload whose tail will not render because collapsed'), 'unknown',
    'collapsed paste is unverifiable, and must never read as a failed delivery');
});

test('ok: text too short to meaningfully verify', () => {
  const vs = createVerifiedSend({ wez: fakeWez(), sleep: instantSleep });
  assert.equal(vs.composerHoldsTail(1, 'short'), 'ok');
});

test('unknown: pane unreadable during integrity check', () => {
  const throwing = fakeWez({ getFullText: () => { throw new Error('gone'); } });
  const vs = createVerifiedSend({ wez: throwing, sleep: instantSleep });
  assert.equal(vs.composerHoldsTail(1, 'a payload long enough to need real verification'), 'unknown');
});

// ---------------------------------------------------------------- sendPromptDeferredEnter
test('two-phase send: bracketed body first, separate CR after, verdict returned', async () => {
  const text = 'line one\nline two of a multi-line payload with a distinctive tail';
  const wez = fakeWez({ getFullText: () => text.replace(/\s+/g, ' ') });
  const vs = createVerifiedSend({ wez, sleep: instantSleep });
  const verdict = await vs.sendPromptDeferredEnter(7, text);
  assert.equal(verdict, 'ok');
  assert.equal(wez.calls.sendTextBracketed.length, 1, 'body goes as ONE bracketed paste');
  assert.equal(wez.calls.sendTextBracketed[0].text, text, 'payload not mangled');
  assert.deepEqual(wez.calls.sendTextNoEnter, [{ paneId: 7, text: '\r' }], 'Enter is separate and single');
});

test('module default export is bound and callable (mcp-server import surface)', () => {
  const mod = require('../src/verified-send.cjs');
  for (const fn of ['verifyPromptSubmission', 'composerHoldsTail', 'sendPromptDeferredEnter']) {
    assert.equal(typeof mod[fn], 'function', `${fn} exported`);
  }
});
