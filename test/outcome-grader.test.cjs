'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const grader = require(path.resolve(__dirname, '..', 'scripts', 'outcome-grader.cjs'));
const { buildPrompt, parseGraderJson, grade, RESULT_VALUES } = grader;

// buildPrompt -----------------------------------------------------------

test('buildPrompt: includes all sections', () => {
  const p = buildPrompt({ work: 'WORK_X', rubric: 'RUBRIC_Y', taskDesc: 'TASK_Z' });
  assert.match(p, /WORK_X/);
  assert.match(p, /RUBRIC_Y/);
  assert.match(p, /TASK_Z/);
  assert.match(p, /Return JSON/);
});

test('buildPrompt: missing rubric uses fallback', () => {
  const p = buildPrompt({ work: 'X' });
  assert.match(p, /no rubric supplied/);
});

test('buildPrompt: missing work shows (empty)', () => {
  const p = buildPrompt({ rubric: 'R' });
  assert.match(p, /\(empty\)/);
});

// parseGraderJson -------------------------------------------------------

test('parseGraderJson: empty input → failed', () => {
  const r = parseGraderJson('');
  assert.equal(r.result, 'failed');
});

test('parseGraderJson: bare JSON object', () => {
  const j = '{"result":"satisfied","explanation":"all good","met":["a","b"],"gaps":[]}';
  const r = parseGraderJson(j);
  assert.equal(r.result, 'satisfied');
  assert.equal(r.explanation, 'all good');
  assert.deepEqual(r.met, ['a', 'b']);
  assert.deepEqual(r.gaps, []);
});

test('parseGraderJson: JSON wrapped in markdown fence', () => {
  const j = 'sure thing:\n```json\n{"result":"needs_revision","explanation":"missing tests"}\n```\nthat is my call.';
  const r = parseGraderJson(j);
  assert.equal(r.result, 'needs_revision');
  assert.equal(r.explanation, 'missing tests');
});

test('parseGraderJson: JSON wrapped in plain ``` fence', () => {
  const j = '```\n{"result":"failed"}\n```';
  const r = parseGraderJson(j);
  assert.equal(r.result, 'failed');
});

test('parseGraderJson: extracts first {...} from prosey output', () => {
  const j = 'Looking at this... my verdict: {"result":"satisfied","explanation":"clean"}';
  const r = parseGraderJson(j);
  assert.equal(r.result, 'satisfied');
});

test('parseGraderJson: invalid result value defaults to failed', () => {
  const j = '{"result":"absolutely-yes","explanation":"weird"}';
  const r = parseGraderJson(j);
  assert.equal(r.result, 'failed');
});

test('parseGraderJson: garbage input → failed with reason', () => {
  const r = parseGraderJson('this is not json at all');
  assert.equal(r.result, 'failed');
  assert.match(r.explanation, /not parseable/);
});

test('parseGraderJson: handles met/gaps as non-arrays gracefully', () => {
  const j = '{"result":"satisfied","met":"not-an-array","gaps":null}';
  const r = parseGraderJson(j);
  assert.deepEqual(r.met, []);
  assert.deepEqual(r.gaps, []);
});

// grade (stub backend) --------------------------------------------------

test('grade: stub backend returns satisfied', () => {
  const r = grade({ work: 'x', rubric: 'r', backend: 'stub' });
  assert.equal(r.result, 'satisfied');
  assert.match(r.explanation, /stub grader/);
});

test('grade: unknown backend → failed', () => {
  const r = grade({ work: 'x', backend: 'made-up' });
  assert.equal(r.result, 'failed');
  assert.match(r.explanation, /unknown grader backend/);
});

test('grade: env-var WEZBRIDGE_GRADER_BACKEND respected', () => {
  const prev = process.env.WEZBRIDGE_GRADER_BACKEND;
  process.env.WEZBRIDGE_GRADER_BACKEND = 'stub';
  try {
    const r = grade({ work: 'x' }); // no explicit backend
    assert.equal(r.result, 'satisfied');
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_GRADER_BACKEND;
    else process.env.WEZBRIDGE_GRADER_BACKEND = prev;
  }
});

// constants -------------------------------------------------------------

test('RESULT_VALUES matches Managed Agents result enum', () => {
  assert.deepEqual(RESULT_VALUES, ['satisfied', 'needs_revision', 'max_iterations_reached', 'failed']);
});
