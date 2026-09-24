'use strict';
/**
 * orca-target-sender.test.cjs — T-0600: resolveOrcaSender (src/orca-target.cjs),
 * the REVERSE of resolveOrcaTarget — handle -> project/lane, so an Orca-hosted
 * headless sender (no WezTerm pane at all) can prove its own identity to
 * a2a_send without --from-pane. Census/roster injected as pure doubles, same
 * style as queue-drain-orca-transport.test.cjs.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveOrcaSender } = require('../src/orca-target.cjs');

function deps({ terminals = [], lanes = [] } = {}) {
  return {
    runOrcaCensus: async () => ({ ok: true, terminals }),
    loadRoster: () => ({ lanes, roster_missing: false }),
    mergeLanes: (roster, census) => {
      const list = (census && census.list) || [];
      return (roster.lanes || []).map((l) => {
        const hit = list.find((t) => t.handle === l.handle || (l.handle && t.handle.startsWith(l.handle)));
        return { lane: l.lane, handle: l.handle, live: !!hit, title: hit ? hit.title : null };
      });
    },
  };
}

test('resolveOrcaSender: known handle with a roster lane -> project = that lane', async () => {
  const d = deps({
    terminals: [{ handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true }],
    lanes: [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }],
  });
  const res = await resolveOrcaSender('term_drill1', d);
  assert.equal(res.project, 'drillrepo');
  assert.equal(res.matchedBy, 'lane');
  assert.equal(res.warning, null);
});

test('resolveOrcaSender: known handle with NO roster lane -> falls back to the worktree cwd basename', async () => {
  const d = deps({
    terminals: [{ handle: 'term_x', title: 'shell', worktreePath: 'G:/Py Apps/pedrito', connected: true }],
    lanes: [],
  });
  const res = await resolveOrcaSender('term_x', d);
  assert.equal(res.project, 'pedrito');
  assert.equal(res.matchedBy, 'cwd');
});

test('resolveOrcaSender: unknown handle (not in the live census) -> project:null, warning names the handle', async () => {
  const d = deps({ terminals: [{ handle: 'term_other', worktreePath: 'G:/Py Apps/x', connected: true }], lanes: [] });
  const res = await resolveOrcaSender('term_missing', d);
  assert.equal(res.project, null);
  assert.match(res.warning, /term_missing/);
});

test('resolveOrcaSender: no handle given -> project:null, clear warning, never throws', async () => {
  const res = await resolveOrcaSender(null, deps());
  assert.equal(res.project, null);
  assert.match(res.warning, /no ORCA_TERMINAL_HANDLE/);
});

test('resolveOrcaSender: census failure -> project:null, warning carries the census reason, never throws', async () => {
  const res = await resolveOrcaSender('term_x', {
    runOrcaCensus: async () => ({ ok: false, reason: 'orca cli: ECONNREFUSED' }),
    loadRoster: () => ({ lanes: [] }),
    mergeLanes: () => [],
  });
  assert.equal(res.project, null);
  assert.match(res.warning, /ECONNREFUSED/);
});

test('resolveOrcaSender: terminal has neither lane nor worktree cwd -> falls back to its tab title', async () => {
  const d = deps({ terminals: [{ handle: 'term_y', title: 'my-shell-tab', worktreePath: null, connected: true }], lanes: [] });
  const res = await resolveOrcaSender('term_y', d);
  assert.equal(res.project, 'my-shell-tab');
  assert.equal(res.matchedBy, 'title');
});
