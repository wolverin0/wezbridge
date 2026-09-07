'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPaneHandlers } = require('../src/handlers/pane-handlers.cjs');

test('T-0379 pane prompt response waits for text and Enter operations to finish', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const effects = [];
  const responses = [];
  const handlers = createPaneHandlers({
    parseBody: async () => ({ text: 'fixture prompt' }),
    safetyPolicy: { evaluate: () => ({ allowed: true }) },
    wez: {
      sendText: async () => { await pending; effects.push('text'); },
      sendTextNoEnter: async () => { effects.push('enter'); },
    },
    sendJson: (_res, status, body) => responses.push({ status, body }),
    sendError: (_res, error) => { throw error; },
  });
  const result = handlers.handlePostPrompt({}, {}, 8001);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(responses, [], 'HTTP must not acknowledge an operation still running in its worker');
  release();
  await result;
  assert.deepEqual(effects, ['text', 'enter']);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].status, 200);
});

test('T-0379 pane list response contains resolved cached or worker data, not a promise', async () => {
  const expected = [{ pane_id: 8002, title: 'fixture' }];
  let response;
  const handlers = createPaneHandlers({ collectPanes: async () => expected,
    sendJson: (_res, status, body) => { response = { status, body }; },
    sendError: (_res, error) => { throw error; } });
  await handlers.handleGetPanes({}, {});
  assert.deepEqual(response, { status: 200, body: { panes: expected } });
});
