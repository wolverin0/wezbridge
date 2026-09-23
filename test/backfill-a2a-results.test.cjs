'use strict';
/**
 * backfill-a2a-results.test.cjs — T-0350 AC6a: scripts/backfill-a2a-results.cjs
 * appends missing type=result queue entries into a2a-results.jsonl, is
 * idempotent by id, defaults to dry-run, and NEVER touches an existing line.
 * All IO points at a temp dir — never the real _intel.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findMissing, appendBackfillLine, main } = require('../scripts/backfill-a2a-results.cjs');

let tmpCounter = 0;
function freshIntel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const intel = path.join(dir, `case-${tmpCounter++}`);
  fs.mkdirSync(path.join(intel, 'queues'), { recursive: true });
  return intel;
}

function writeQueue(intel, project, lines) {
  const file = path.join(intel, 'queues', `${project}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function readResults(intel) {
  const f = path.join(intel, 'a2a-results.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('findMissing: a queued type=result with no line at all in a2a-results.jsonl is MISSING', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-1', corr: 'c-1', type: 'result', from_pane: 3, resolved_pane: null, body: 'criteria:\n- a: pass — ev', time: '2026-09-01T00:00:00.000Z' },
  ]);
  const { missing } = findMissing(intel);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'id-1');
  assert.equal(missing[0].corr, 'c-1');
});

test('findMissing: a corr that already has ANY line in a2a-results.jsonl is not missing', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-2', corr: 'c-2', type: 'result', from_pane: 3, body: 'criteria:\n- a: pass — ev', time: '2026-09-01T00:00:00.000Z' },
  ]);
  fs.writeFileSync(path.join(intel, 'a2a-results.jsonl'), JSON.stringify({ time: '2026-09-01T00:05:00.000Z', corr: 'c-2', body: 'ya registrado por otro camino' }) + '\n');
  const { missing } = findMissing(intel);
  assert.equal(missing.length, 0);
});

test('findMissing: type=request queue entries are never candidates', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-3', corr: 'c-3', type: 'request', from_pane: 3, body: 'hacelo', time: '2026-09-01T00:00:00.000Z' },
  ]);
  const { missing } = findMissing(intel);
  assert.equal(missing.length, 0);
});

test('main --dry-run (default): reports the missing entries but writes NOTHING', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-4', corr: 'c-4', type: 'result', from_pane: 3, body: 'criteria:\n- a: pass — ev', time: '2026-09-01T00:00:00.000Z' },
  ]);
  const out = main(['node', 'backfill-a2a-results.cjs', intel]);
  assert.equal(out.appended, 0);
  assert.equal(out.missing.length, 1);
  assert.equal(fs.existsSync(path.join(intel, 'a2a-results.jsonl')), false, 'dry-run must not create the file');
});

test('main --live: appends exactly the missing lines, marked backfilled:true', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-5', corr: 'c-5', type: 'result', from_pane: 3, resolved_pane: 7, body: 'criteria:\n- a: pass — ev', time: '2026-09-01T00:00:00.000Z' },
  ]);
  const out = main(['node', 'backfill-a2a-results.cjs', intel, '--live']);
  assert.equal(out.appended, 1);
  const lines = readResults(intel);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'id-5');
  assert.equal(lines[0].corr, 'c-5');
  assert.equal(lines[0].backfilled, true);
  assert.match(lines[0].body, /criteria:/);
});

test('main --live: idempotent — a second run over the same intel dir finds nothing left', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-6', corr: 'c-6', type: 'result', from_pane: 3, body: 'criteria:\n- a: pass — ev', time: '2026-09-01T00:00:00.000Z' },
  ]);
  main(['node', 'backfill-a2a-results.cjs', intel, '--live']);
  const second = main(['node', 'backfill-a2a-results.cjs', intel, '--live']);
  assert.equal(second.appended, 0, 'the id is already recorded — nothing left to backfill');
  assert.equal(readResults(intel).length, 1, 'still exactly one line, not two');
});

test('main --live: NEVER touches an existing a2a-results.jsonl line — pure append', () => {
  const intel = freshIntel();
  writeQueue(intel, 'proj', [
    { id: 'id-7a', corr: 'c-7a', type: 'result', from_pane: 3, body: 'criteria:\n- a: pass — ev', time: '2026-09-01T00:00:00.000Z' },
    { id: 'id-7b', corr: 'c-7b', type: 'result', from_pane: 3, body: 'criteria:\n- b: pass — ev', time: '2026-09-01T00:01:00.000Z' },
  ]);
  const existing = JSON.stringify({ time: '2026-08-01T00:00:00.000Z', corr: 'pre-existing', body: 'no me toques' });
  fs.writeFileSync(path.join(intel, 'a2a-results.jsonl'), existing + '\n');
  main(['node', 'backfill-a2a-results.cjs', intel, '--live']);
  const raw = fs.readFileSync(path.join(intel, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
  assert.equal(raw[0], existing, 'the pre-existing line survives byte-for-byte, at its original position');
  assert.equal(raw.length, 3, 'two new lines appended after it, nothing rewritten');
});
