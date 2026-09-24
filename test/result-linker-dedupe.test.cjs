'use strict';
// result-linker-dedupe.test.cjs — T-0564: reader-side collapse of amplified
// resends (T-0350's dedupeResultLines) at the batch-consumer boundary
// (scripts/result-link.cjs reads a BATCH of new a2a-results.jsonl lines per
// cursor run and hands each to src/result-linker.cjs's link()). The
// 996509539944f94d incident (186 identical lines, same corr/id, resent every
// ~15min) means a catch-up run (or a slow-cursor run spanning several
// resends) can see many duplicate lines in ONE batch — each would otherwise
// call link() again, inflating seen/unlinked counts and emitting redundant
// result.unlinked noise for a corr whose card already moved.
//
// No companions needed: parseResultLines is a pure array transform, and the
// terminal-state guard test injects a stub runLedger/readTasks instead of
// touching the real ledger CLI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const linker = require('../src/result-linker.cjs');

const rawLine = (over = {}) => JSON.stringify({
  time: '2026-09-02T01:56:00.000Z',
  event: 'a2a.result',
  id: 'env-996509539944f94d',
  corr: 'eve-piloto-d006-final-20260829',
  from_pane: 7,
  to_pane: 0,
  v2: 'ok',
  body: 'FinalOrchestra JOB-1: COMPLETED',
  ...over,
});

test('parseResultLines: un envelope reenviado 3 veces (mismo id) se procesa 1 sola vez', () => {
  const lines = [
    rawLine({ time: '2026-09-02T01:56:00.000Z' }),
    rawLine({ time: '2026-09-02T02:11:00.000Z' }),
    rawLine({ time: '2026-09-02T02:26:00.000Z' }),
  ];
  const parsed = linker.parseResultLines(lines);
  assert.strictEqual(parsed.length, 1, 'el mismo id reenviado no debe multiplicar las lineas a procesar');
  assert.strictEqual(parsed[0].time, '2026-09-02T01:56:00.000Z', 'sobrevive la copia mas antigua (primer intento)');
});

test('parseResultLines: lineas rotas y las que no son a2a.result se descartan sin tirar', () => {
  const parsed = linker.parseResultLines([
    'not json{{{',
    JSON.stringify({ event: 'turn-end', corr: 'x' }),
    rawLine({ corr: 'distinto', id: 'otro-id' }),
  ]);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].corr, 'distinto');
});

test('parseResultLines: dos corrs DISTINTOS nunca se colapsan entre si', () => {
  const parsed = linker.parseResultLines([
    rawLine({ corr: 'A', id: 'id-a' }),
    rawLine({ corr: 'B', id: 'id-b' }),
  ]);
  assert.strictEqual(parsed.length, 2);
});

// ── AC2: terminal states (done/cancelled) are never moved by a late/duplicate result ──

test('link(): una tarjeta en estado done NUNCA se mueve por un result (duplicado o no) — guard ya existe, se fija con test', () => {
  const line = JSON.parse(rawLine({ corr: 'T-0999:x:20260901' }));
  const calls = [];
  const result = linker.link(line, {
    runLedger: (args) => { calls.push(args); return ''; },
    readTasks: () => [{ id: 'T-0999', corr: 'T-0999:x:20260901', state: 'done', evaluator_evidence: '' }],
    recordEvent: () => {},
  });
  assert.strictEqual(result.linked, false);
  assert.strictEqual(result.reason, 'state=done');
  assert.deepStrictEqual(calls, [], 'el ledger jamas se invoca sobre una tarjeta done');
});

test('link(): una tarjeta en estado cancelled NUNCA se mueve por un result', () => {
  const line = JSON.parse(rawLine({ corr: 'T-0998:x:20260901' }));
  const calls = [];
  const result = linker.link(line, {
    runLedger: (args) => { calls.push(args); return ''; },
    readTasks: () => [{ id: 'T-0998', corr: 'T-0998:x:20260901', state: 'cancelled', evaluator_evidence: '' }],
    recordEvent: () => {},
  });
  assert.strictEqual(result.linked, false);
  assert.strictEqual(result.reason, 'state=cancelled');
  assert.deepStrictEqual(calls, []);
});
