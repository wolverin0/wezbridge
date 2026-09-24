'use strict';
// T-0571: recordResultBody call sites in the a2a_send path (src/mcp-server.cjs)
// were not passing the envelope `id`, so dedupeResultLines (src/a2a-intel.cjs)
// fell back to corr+sha1(body) for almost all live traffic — two genuinely
// distinct results with identical body for the same corr in one cursor batch
// collapsed into one. This spawns the REAL mcp-server and drives it through
// the to_project-unresolved branch (recordAndLinkResult fires before the
// early return, same as the delivered path) to prove the written line
// carries `id`.
require('./setup.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { callA2aSend, fixture } = require('./helpers/mcp-call.cjs');

test('a2a_send result path: recordResultBody writes a line that carries id', async (t) => {
  const dir = fixture(t, 't0571-result-id-');
  const body = 'Done.\ncriteria:\n- x: pass — evidence';
  const result = await callA2aSend(
    { from_pane: 1, to_project: 't0571-unavailable-project', corr: 't0571-corr', type: 'result', body },
    { WEZBRIDGE_INTEL_DIR: dir },
  );
  assert.notEqual(result.isError, true);
  const resultsFile = path.join(dir, 'a2a-results.jsonl');
  assert.equal(fs.existsSync(resultsFile), true, 'a2a-results.jsonl should exist');
  const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.corr, 't0571-corr');
  assert.ok(rec.id && typeof rec.id === 'string' && rec.id.length > 0, `expected a non-empty id on the written line, got ${JSON.stringify(rec.id)}`);
});

// T-0571 fixup: a random id-per-SEND made three identical resends (same
// corr + byte-identical body — the 151x incident class) write three
// DIFFERENT ids, so dedupeResultLines kept all three instead of collapsing
// them to one. The id must be DERIVED from the envelope (project-queue.cjs's
// entryId) so identical resends produce the SAME id.
test('a2a_send result path: 3 identical resends (same corr+body) share ONE id and collapse via dedupeResultLines', async (t) => {
  const dir = fixture(t, 't0571-resend-collapse-');
  const body = 'Done.\ncriteria:\n- x: pass — evidence';
  const args = { from_pane: 1, to_project: 't0571-unavailable-project', corr: 't0571-resend-corr', type: 'result', body };
  for (let i = 0; i < 3; i++) {
    const result = await callA2aSend(args, { WEZBRIDGE_INTEL_DIR: dir });
    assert.notEqual(result.isError, true);
  }
  const resultsFile = path.join(dir, 'a2a-results.jsonl');
  const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, 'each identical resend still writes its own line');
  const ids = lines.map((r) => r.id);
  assert.equal(new Set(ids).size, 1, `expected all 3 resends to share ONE id, got ${JSON.stringify(ids)}`);

  const { dedupeResultLines } = require('../src/a2a-intel.cjs');
  const collapsed = dedupeResultLines(lines);
  assert.equal(collapsed.length, 1, `dedupeResultLines should collapse 3 identical resends to 1, got ${collapsed.length}`);
});

// T-0571 fixup AC2: the id written at send time must equal project-queue's
// entryId() for the same envelope (and therefore the id the queue itself
// would assign on enqueue for the same envelope).
test('a2a_send result path: written id equals project-queue entryId() for the same envelope', async (t) => {
  const dir = fixture(t, 't0571-id-matches-queue-');
  const body = 'Done.\ncriteria:\n- x: pass — evidence';
  const args = { from_pane: 1, to_project: 't0571-unavailable-project', corr: 't0571-match-corr', type: 'result', body };
  const result = await callA2aSend(args, { WEZBRIDGE_INTEL_DIR: dir });
  assert.notEqual(result.isError, true);

  const resultsFile = path.join(dir, 'a2a-results.jsonl');
  const rec = JSON.parse(fs.readFileSync(resultsFile, 'utf8').trim().split('\n').pop());

  const { entryId } = require('../src/project-queue.cjs');
  const expectedId = entryId({ project: 't0571-unavailable-project', corr: 't0571-match-corr', type: 'result', from_pane: 1, body });
  assert.equal(rec.id, expectedId, 'the direct-write id must equal entryId() for the identical envelope');

  // The same unresolved-to_project branch also durably enqueues this
  // envelope (project-queue.cjs) — its line's id must match too, and
  // AC4 (double-record) requires exactly one a2a-results.jsonl line.
  const queueFile = path.join(dir, 'queues', 't0571-unavailable-project.jsonl');
  assert.equal(fs.existsSync(queueFile), true, 'queue file should exist for the unresolved to_project send');
  const queueRec = JSON.parse(fs.readFileSync(queueFile, 'utf8').trim().split('\n').pop());
  assert.equal(queueRec.id, expectedId, 'the queue entry id must equal the direct-write result id');
  assert.equal(queueRec.recorded, true, 'the queued line must be marked recorded:true — the result already lives in a2a-results.jsonl');

  const resultLines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n');
  assert.equal(resultLines.length, 1, 'AC4: direct write + queue backstop for the same envelope must yield exactly 1 a2a-results.jsonl line');
});
