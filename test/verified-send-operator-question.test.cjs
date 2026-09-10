'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vs = require('../src/verified-send.cjs');
const { createWaker } = require('../src/orchestrator-waker.cjs');
// Live pane-10 read on 2026-09-09; only trailing spaces removed.
const LIVE = fs.readFileSync(path.join(__dirname, 'fixtures/wabot-askuserquestion-20260909.txt'), 'utf8');
// Exact selected-line/footer witnesses recorded in T-0401 and fleet events on 2026-09-05.
const HISTORICAL = '\u276f 1. Borrar 18447 (Recommended)\nEnter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel';

test('T-0401 AC1 killer: actual Wabot AskUserQuestion tails are not retained composer text', () => {
  assert.equal(vs.composerHoldsForeignText(LIVE), false);
  assert.equal(vs.composerHoldsForeignText(HISTORICAL), false);
});

test('T-0401 AC2 killer: waker persists operator-question and names it without the held-composer rider', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waker-question-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  const eventsPath = path.join(dir, 'events.jsonl');
  const stateDir = path.join(dir, 'state');
  fs.writeFileSync(eventsPath, '');
  let idle = false;
  const sent = [];
  const w = createWaker({ eventsPath, stateDir, watchRepos: ['wabot'], settleTicks: 1, debounceMs: 0,
    now: () => Date.parse('2026-09-09T14:00:00Z'),
    discoverPanes: () => [{ paneId: 94, project: 'wezbridge', status: idle ? 'idle' : 'busy', lastLines: '\u276f' },
      { paneId: 10, project: 'wabot', status: 'idle', lastLines: LIVE + '\nbypass permissions on' }],
    send: { sendPromptDeferredEnter: async (pane, text) => { sent.push({ pane, text }); return 'ok'; }, verifyPromptSubmission: async () => 'submitted' },
  });
  fs.appendFileSync(eventsPath, JSON.stringify({ repo: 'wabot', pane: 10, session: 'test', event: 'permission-wait', time: '2026-09-09T13:59:00Z' }) + '\n');
  await w.tick();
  const pending = JSON.parse(fs.readFileSync(path.join(stateDir, 'pending.json'), 'utf8'));
  assert.equal(Object.values(pending)[0]?.classification, 'operator-question');
  idle = true;
  await w.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, 94, 'never send to the answering worker pane');
  assert.match(sent[0].text, /operator-question.*pane espera respuesta del operador/i);
  assert.doesNotMatch(sent[0].text, /OJO.*composer RETIENE|finished work/i);
});

test('question menu refuses paste and submission retries, even with force', async () => {
  const writes = [];
  const api = vs.createVerifiedSend({ sleep: async () => {}, wez: {
    invalidateGetTextCache() {}, getFullText: () => LIVE,
    sendTextBracketed: (...a) => writes.push(a), sendTextNoEnter: (...a) => writes.push(a), sendText: (...a) => writes.push(a),
  } });
  const result = await api.sendPromptDeferredEnter(10, '1. Una casilla del dominio', { force: true, why: 'not an authorization to answer a menu' });
  assert.equal(result.refused, 'operator-question');
  assert.equal(await api.verifyPromptSubmission(10, '1. Una casilla del dominio'), 'unknown');
  assert.deepEqual(writes, []);
});

test('real numbered composer after old menu, and a new composer below an active menu, remain protected', () => {
  for (const line of ['\u276f mi texto sin enviar', '\u276f 1. ejecutar esto despues', '\u276f [A2A retained]']) {
    assert.equal(vs.composerHoldsForeignText(LIVE + '\n' + line), true);
  }
  assert.equal(vs.composerHoldsForeignText('\u276f 1. ejecutar esto despues'), true);
  assert.equal(vs.composerHoldsForeignText(LIVE + '\n\u276f'), false);
});

test('menu footer variants, custom answer option and ANSI decorations preserve classification', () => {
  for (const tail of [HISTORICAL.replace('Tab/Arrow keys', '\u2191/\u2193'),
    HISTORICAL.replace('1. Borrar 18447 (Recommended)', '4. la verdad es que nunca tuvimos en cuenta el gps sync'),
    '\x1b[32m' + HISTORICAL + '\x1b[0m']) {
    assert.equal(vs.operatorQuestionVisible(tail), true);
    assert.equal(vs.composerHoldsForeignText(tail), false);
  }
  assert.equal(vs.operatorQuestionVisible(HISTORICAL + '\n\u25cf User answered the questions'), false);
  assert.equal(vs.operatorQuestionVisible(HISTORICAL + '\n\u276f 1. texto nuevo'), false);
  assert.equal(vs.operatorQuestionVisible('1. opcion\nEnter to select'), false);
});
