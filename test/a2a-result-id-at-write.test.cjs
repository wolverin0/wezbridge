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
