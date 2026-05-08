'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tm = require(path.resolve(__dirname, '..', 'src', 'team-manifest.cjs'));

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-team-'));
  return path.join(dir, 'teams.jsonl');
}

// record + readEvents -------------------------------------------------

test('record + readEvents: roundtrip', () => {
  const logPath = tmpLog();
  tm.record({ event: 'worktree_added', pane_id: 12, worktree_path: '/r/.wt/x', branch_name: 'feat/x', base_cwd: '/r' }, { logPath });
  tm.record({ event: 'worktree_removed', pane_id: 12 }, { logPath });
  const events = tm.readEvents({ logPath });
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'worktree_added');
  assert.equal(events[1].event, 'worktree_removed');
});

test('record: rejects invalid input', () => {
  const logPath = tmpLog();
  assert.equal(tm.record(null, { logPath }), false);
  assert.equal(tm.record({}, { logPath }), false);
  assert.equal(tm.record({ event: '' }, { logPath }), false);
  assert.deepEqual(tm.readEvents({ logPath }), []);
});

test('readEvents: empty log returns []', () => {
  assert.deepEqual(tm.readEvents({ logPath: '/no/such/file.jsonl' }), []);
});

test('readEvents: skips malformed lines', () => {
  const logPath = tmpLog();
  tm.record({ event: 'team_added', team_name: 't1' }, { logPath });
  fs.appendFileSync(logPath, 'garbage\n', 'utf8');
  tm.record({ event: 'team_dissolved', team_name: 't1' }, { logPath });
  const events = tm.readEvents({ logPath });
  assert.equal(events.length, 2);
});

// replay --------------------------------------------------------------

test('replay: rebuilds teams from team_added', () => {
  const logPath = tmpLog();
  tm.record({ event: 'team_added', team_name: 'orange', prd: 'orange.md', cwd: '/r', roles: [{ paneId: 1, persona: 'reviewer' }] }, { logPath });
  const { teams, worktrees } = tm.replay({ logPath });
  assert.equal(teams.size, 1);
  assert.equal(worktrees.size, 0);
  const t = teams.get('orange');
  assert.equal(t.prd, 'orange.md');
  assert.equal(t.cwd, '/r');
  assert.equal(t.roles.length, 1);
});

test('replay: team_dissolved removes the team', () => {
  const logPath = tmpLog();
  tm.record({ event: 'team_added', team_name: 't1', cwd: '/r' }, { logPath });
  tm.record({ event: 'team_dissolved', team_name: 't1' }, { logPath });
  const { teams } = tm.replay({ logPath });
  assert.equal(teams.size, 0);
});

test('replay: rebuilds worktrees from worktree_added', () => {
  const logPath = tmpLog();
  tm.record({ event: 'worktree_added', pane_id: 21, persona: 'pather', worktree_path: '/r/.wt/p', branch_name: 'p', base_cwd: '/r' }, { logPath });
  tm.record({ event: 'worktree_added', pane_id: 33, persona: 'pather', worktree_path: '/r/.wt/q', branch_name: 'q', base_cwd: '/r' }, { logPath });
  const { worktrees } = tm.replay({ logPath });
  assert.equal(worktrees.size, 2);
  assert.equal(worktrees.get(21).branchName, 'p');
  assert.equal(worktrees.get(33).persona, 'pather');
});

test('replay: worktree_removed deletes', () => {
  const logPath = tmpLog();
  tm.record({ event: 'worktree_added', pane_id: 21, base_cwd: '/r' }, { logPath });
  tm.record({ event: 'worktree_removed', pane_id: 21 }, { logPath });
  const { worktrees } = tm.replay({ logPath });
  assert.equal(worktrees.size, 0);
});

test('replay: latest team_added wins (snapshot semantics)', () => {
  const logPath = tmpLog();
  tm.record({ event: 'team_added', team_name: 't1', cwd: '/old' }, { logPath });
  tm.record({ event: 'team_added', team_name: 't1', cwd: '/new' }, { logPath });
  const { teams } = tm.replay({ logPath });
  assert.equal(teams.get('t1').cwd, '/new');
});

test('replay: unknown events ignored (forward-compat)', () => {
  const logPath = tmpLog();
  tm.record({ event: 'team_added', team_name: 't1' }, { logPath });
  tm.record({ event: 'future_thing_added', x: 1 }, { logPath });
  const { teams } = tm.replay({ logPath });
  assert.equal(teams.size, 1);
});

test('replay: empty log returns empty maps', () => {
  const r = tm.replay({ logPath: '/nope.jsonl' });
  assert.equal(r.teams.size, 0);
  assert.equal(r.worktrees.size, 0);
});
