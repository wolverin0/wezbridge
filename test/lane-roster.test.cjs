'use strict';
/**
 * lane-roster.test.cjs — T-0550: _intel/orchestrators.json roster cross-matched
 * against the orca census, feeding the `lanes` key in bridge_health (MCP tool +
 * /api/health). Covers: missing/unparseable roster, exact-handle match, prefix
 * match, absent handle, and census unavailable (live: null).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRoster, mergeLanes } = require('../src/lane-roster.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lane-roster-'));

function writeRoster(intelDir, obj) {
  fs.writeFileSync(path.join(intelDir, 'orchestrators.json'), JSON.stringify(obj), 'utf8');
}

test('missing roster file: loadRoster returns lanes:[] + roster_missing:true, mergeLanes stays empty', () => {
  const intel = tmp();
  const roster = loadRoster(intel);
  assert.deepEqual(roster, { lanes: [], roster_missing: true });
  assert.deepEqual(mergeLanes(roster, { list: [] }), []);
});

test('unparseable roster JSON degrades the same as a missing file, never throws', () => {
  const intel = tmp();
  fs.writeFileSync(path.join(intel, 'orchestrators.json'), 'not json', 'utf8');
  const roster = loadRoster(intel);
  assert.deepEqual(roster, { lanes: [], roster_missing: true });
});

test('two lanes match census by full handle and by handle prefix, one is absent => live true/true/false with titles', () => {
  const intel = tmp();
  writeRoster(intel, {
    version: 1,
    fleet: { handle: 'term_237895d9-6a0b-46b8-a7e1-4c01f3b7d61f', model: 'claude-fable-5-1', effort: 'xhigh' },
    lanes: [
      { lane: 'wisp', handle: 'term_db1a50e0-9530-41ff-beea-b89686d5c690', model: 'claude-opus-5-5', effort: 'medium', state: 'live' },
      { lane: 'pedrito', handle: 'term_db1a50e0', model: 'claude-opus-5-5', effort: 'medium', state: 'live' },
      { lane: 'ghost', handle: 'term_deadbeef-0000-0000-0000-000000000000', model: 'claude-opus-5-5', effort: 'low', state: 'live' },
    ],
  });
  const roster = loadRoster(intel);
  assert.equal(roster.roster_missing, false);
  assert.equal(roster.lanes.length, 3);

  const census = {
    list: [
      { handle: 'term_db1a50e0-9530-41ff-beea-b89686d5c690', title: 'wisp orchestrator', worktreePath: null, connected: true, provider: 'claude' },
    ],
  };
  const lanes = mergeLanes(roster, census);
  assert.deepEqual(lanes, [
    { lane: 'wisp', handle: 'term_db1a50e0-9530-41ff-beea-b89686d5c690', model: 'claude-opus-5-5', effort: 'medium', state: 'live', live: true, title: 'wisp orchestrator' },
    { lane: 'pedrito', handle: 'term_db1a50e0', model: 'claude-opus-5-5', effort: 'medium', state: 'live', live: true, title: 'wisp orchestrator' },
    { lane: 'ghost', handle: 'term_deadbeef-0000-0000-0000-000000000000', model: 'claude-opus-5-5', effort: 'low', state: 'live', live: false, title: null },
  ]);
});

test('census unavailable (no usable .list): every lane reports live:null, never a false "not live"', () => {
  const intel = tmp();
  writeRoster(intel, {
    lanes: [{ lane: 'wisp', handle: 'term_db1a50e0-9530-41ff-beea-b89686d5c690', model: 'claude-opus-5-5', effort: 'medium', state: 'live' }],
  });
  const roster = loadRoster(intel);
  for (const census of [null, undefined, 'unknown (daemon down and no _intel/orca-census.json)', { last_error: 'no census yet' }]) {
    const lanes = mergeLanes(roster, census);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].live, null);
    assert.equal(lanes[0].title, null);
  }
});

test('mergeLanes tolerates a roster with no lanes array and a lane missing its handle', () => {
  assert.deepEqual(mergeLanes({}, { list: [] }), []);
  assert.deepEqual(mergeLanes(null, { list: [] }), []);
  const lanes = mergeLanes({ lanes: [{ lane: 'no-handle' }] }, { list: [{ handle: 'term_x', title: 't' }] });
  assert.deepEqual(lanes, [{ lane: 'no-handle', handle: null, model: null, effort: null, state: null, live: false, title: null }]);
});
