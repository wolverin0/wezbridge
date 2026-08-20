'use strict';
/**
 * pane-beacon-commit.test.cjs — commit identity on every turn-end (slice 3)
 * plus the PROPOSAL marker (slice 5). Spawns the REAL global hook by absolute
 * path — the file every Claude session on this machine runs on every turn —
 * against a temp WEZBRIDGE_INTEL_DIR and a temp git repo. The fail-soft
 * contract is asserted everywhere: exit 0 always, NEVER any stdout on Stop.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const HOOK = 'C:/Users/pauol/.claude/hooks/pane-beacon.cjs';

const mkIntel = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-intel-'));

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'beacon@test.local');
  git(dir, 'config', 'user.name', 'beacon-test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'one');
  return dir;
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

let n = 0;
function commit(dir, msg) {
  fs.writeFileSync(path.join(dir, 'f.txt'), `${msg}-${n += 1}`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Run the hook exactly as Claude Code does: JSON on stdin, Stop event. */
function beacon(intel, { cwd, session = 'beacontest', transcript = '' } = {}) {
  const transcriptPath = path.join(intel, `${session}.transcript.txt`);
  fs.appendFileSync(transcriptPath, transcript);
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'Stop', session_id: session,
      cwd, transcript_path: transcriptPath,
    }),
    env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel },
    encoding: 'utf8', timeout: 20000,
  });
  assert.strictEqual(res.status, 0, `the hook must NEVER exit non-zero (stderr: ${res.stderr})`);
  assert.strictEqual(res.stdout, '', 'no stdout on Stop — a beacon must never alter the watched session');
  return res;
}

const lines = (intel) => fs.readFileSync(path.join(intel, 'pane-events.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));

test('same HEAD twice: neither beacon claims head_moved, but heads are tracked', () => {
  const intel = mkIntel();
  const repo = mkRepo();
  beacon(intel, { cwd: repo });
  beacon(intel, { cwd: repo });
  const [first, second] = lines(intel);
  // First-ever observation is a baseline, not movement — and an unchanged HEAD
  // is the mutation this guards: head_moved on a quiet repo is a FALSE work
  // signal, and downstream (board freshness, steward) trusts it as ground truth.
  assert.strictEqual(first.head_moved, undefined, 'first observation is a baseline, not a move');
  assert.strictEqual(second.head_moved, undefined, 'unchanged HEAD must not claim head_moved');
  assert.strictEqual(second.head, undefined);
  assert.strictEqual(second.head_prev, undefined);
  // ...but the state file updates on EVERY turn, marker or no marker.
  const heads = JSON.parse(fs.readFileSync(path.join(intel, '.beacon-heads.json'), 'utf8'));
  const repoKey = path.basename(repo);
  assert.strictEqual(heads[repoKey], git(repo, 'rev-parse', 'HEAD').trim(),
    '.beacon-heads.json must track HEAD on every turn-end, not only when deploy markers appear');
});

test('a commit between beacons stamps head, head_prev and head_moved', () => {
  const intel = mkIntel();
  const repo = mkRepo();
  const sha1 = git(repo, 'rev-parse', 'HEAD').trim();
  beacon(intel, { cwd: repo });                    // baseline
  const sha2 = commit(repo, 'two');
  beacon(intel, { cwd: repo });                    // HEAD moved
  beacon(intel, { cwd: repo });                    // quiet again
  const all = lines(intel);
  const moved = all[1];
  assert.strictEqual(moved.head_moved, true);
  assert.strictEqual(moved.head, sha2);
  assert.strictEqual(moved.head_prev, sha1);
  // The move is reported ONCE. The next quiet turn carries nothing — otherwise
  // one commit reads as perpetual progress.
  assert.strictEqual(all[2].head_moved, undefined, 'a single commit must not echo forever');
  assert.strictEqual(all[2].head, undefined);
});

test('non-repo cwd: head fields absent, exit 0, beacon still lands', () => {
  const intel = mkIntel();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-norepo-'));
  beacon(intel, { cwd: plain });
  const [line] = lines(intel);
  assert.strictEqual(line.event, 'turn-end', 'the beacon itself must still be appended');
  assert.strictEqual(line.head, undefined);
  assert.strictEqual(line.head_prev, undefined);
  assert.strictEqual(line.head_moved, undefined);
});

test('PROPOSAL:<slug> is a recognised marker (slice 5)', () => {
  const intel = mkIntel();
  const repo = mkRepo();
  beacon(intel, { cwd: repo, transcript: 'Recommend filing this. PROPOSAL:board-freshness-gate\n' });
  const [line] = lines(intel);
  assert.ok(line.markers.includes('PROPOSAL:BOARD-FRESHNESS-GATE'),
    `PROPOSAL marker must be captured, got: ${JSON.stringify(line.markers)}`);
});
