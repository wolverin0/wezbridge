// tasks-watcher.test.cjs — black-box coverage for src/tasks-watcher.cjs.
//
// tasks-watcher.cjs has NO module.exports — it is a standalone script that
// runs its boot sequence (fs.watch, setInterval, SIGTERM/SIGINT handlers)
// unconditionally at require-time. It cannot be required in-process without
// side effects (real timers, real signal handlers, process.exit on SIGTERM).
// So every test here spawns it as a child process against a throwaway temp
// file and asserts on the JSON event lines it writes to stdout — same
// pattern as test/dashboard-smoke.test.cjs. No test ever touches the real
// vault/active_tasks.md or _intel/.
//
// Time-based checks (task_stuck, followups_pending) are made deterministic
// by writing dispatched_at/completed_at timestamps far in the past/present
// instead of waiting on wall-clock thresholds (stuck default is minutes —
// too slow to actually sleep through in a test).
//
// Measured race: fs.watch() on this host arms asynchronously (Windows
// ReadDirectoryChangesW via libuv's threadpool). Writing to the file the
// instant our process observes `initial_state` sometimes outruns that
// arming and the change is silently missed — reproduced deterministically
// under node:test (4/4 fails) once >=2 tests share the process, while a
// single isolated test or any run preceded by >=300ms delay passed 3/3.
// `bootReady()` below absorbs that arming window; it is a wait for the
// watcher's OWN readiness, not a hidden mutation of what's under test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'src', 'tasks-watcher.cjs');

function mkTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-watcher-test-'));
  const file = path.join(dir, 'active_tasks.md');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

/** Spawns tasks-watcher.cjs against `file` and collects parsed stdout events. */
function spawnWatcher(file, envOverrides = {}) {
  const events = [];
  const waiters = [];
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      ACTIVE_TASKS_FILE: file,
      TASKS_POLL_MS: '3600000', // effectively off — tests drive ticks via file writes
      TASKS_STUCK_DEFAULT_MIN: '1',
      // Force any wez.getFullText() call to fail fast (ENOENT) instead of
      // waiting out wezterm.cjs's real 10s CLI timeout (x2 with its retry)
      // against a mux that doesn't exist in this test environment.
      WEZBRIDGE_WEZTERM_BIN: 'T:/nonexistent-wezterm-binary-for-tests.exe',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stderr.on('data', (c) => { stderrBuf += c.toString(); });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      events.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(parsed)) {
          waiters[i].resolve(parsed);
          waiters.splice(i, 1);
        }
      }
    }
  });

  function waitForEvent(predicate, timeoutMs = 4000) {
    const already = events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timed out waiting for event; stderr=${stderrBuf}`));
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
    });
  }

  /** Waits a fixed grace period (debounce is 500ms, hardcoded in source). */
  function settle(ms = 800) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function kill() {
    if (child.exitCode !== null || child.killed) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  return { child, events, waitForEvent, settle, kill, stderr: () => stderrBuf };
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

/** Waits for initial_state, then absorbs the fs.watch arming window (see header note). */
async function bootReady(w) {
  await w.waitForEvent((e) => e.event === 'initial_state');
  await w.settle(300);
}

// ─── boot / seed behavior ─────────────────────────────────────────────────

test('boot: creates a parseable seed file when ACTIVE_TASKS_FILE does not exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-watcher-test-'));
  const file = path.join(dir, 'active_tasks.md');
  assert.equal(fs.existsSync(file), false);
  const w = spawnWatcher(file);
  try {
    await w.waitForEvent((e) => e.event === 'watcher_started');
    await w.waitForEvent((e) => e.event === 'initial_state');
    assert.equal(fs.existsSync(file), true, 'seed file must be created');
    const { parseTasksFile } = require('../src/task-parser.cjs');
    const parsed = parseTasksFile(file);
    assert.equal(parsed.errors.length, 0, 'seed content must be parseable without errors');
    assert.equal(parsed.tasks.size, 1);
    assert.ok(parsed.tasks.has('T-000'));
    assert.equal(parsed.tasks.get('T-000').status, 'completed');
  } finally {
    await w.kill();
  }
});

test('boot: never overwrites an existing active_tasks.md', async () => {
  const original = '## T-005 · Existing\n```yaml\nstatus: pending\n```\n';
  const file = mkTmpFile(original);
  const w = spawnWatcher(file);
  try {
    await w.waitForEvent((e) => e.event === 'initial_state');
    await w.settle();
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'existing file content must be untouched at boot');
  } finally {
    await w.kill();
  }
});

// ATOMICITY TRIPWIRE — the source's only write to active_tasks.md is this
// boot-time seed (plain fs.writeFileSync straight to the real path, no
// temp-file+rename). A crash mid-write (power loss, SIGKILL) can leave the
// canonical active-task pointer truncated/corrupt on next boot. An empirical
// SIGKILL-race probe against the running process could NOT be made to land
// mid-syscall (Node's own startup latency outruns the kill from outside),
// so this is asserted structurally instead: it reads the source and fails
// the day someone "fixes" it to fs.writeFileSync(tmp) + fs.renameSync(tmp,
// real) WITHOUT updating this test — that's the point. Don't delete this
// without replacing it with a real atomic-write test.
test('KNOWN GAP: boot seed write is not atomic (temp+rename) — tripwire, not a pass/fail on safety', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks-watcher.cjs'), 'utf8');
  const bootBlock = src.slice(src.indexOf('// --- Boot ---'));
  const usesDirectWrite = /fs\.writeFileSync\(ACTIVE_TASKS_FILE,/.test(bootBlock);
  const usesRename = /renameSync/.test(bootBlock);
  assert.equal(usesDirectWrite, true, 'expected the known direct-write pattern — if this fails, the write path changed and the atomicity story needs re-checking');
  assert.equal(usesRename, false, 'a renameSync appeared — the write may now be atomic; replace this tripwire with a real crash-safety test and update T7 coverage notes');
});

test('boot: initial_state reports the correct task_count and in_progress list', async () => {
  const content = [
    '## T-001 · A',
    '```yaml',
    'status: pending',
    '```',
    '',
    '## T-002 · B',
    '```yaml',
    'status: in_progress',
    'owner: codex-session',
    'dispatched_at: ' + isoAgo(0),
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    const ev = await w.waitForEvent((e) => e.event === 'initial_state');
    assert.equal(ev.task_count, 2);
    assert.deepEqual(ev.in_progress, ['T-002']);
  } finally {
    await w.kill();
  }
});

// ─── diff detection: task_added / task_status_changed ─────────────────────

test('diff: emits task_added when a new T-NNN heading appears in the file', async () => {
  const file = mkTmpFile('## T-001 · Seed\n```yaml\nstatus: pending\n```\n');
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.appendFileSync(file, '\n## T-002 · New task\n```yaml\nstatus: pending\n```\n');
    const ev = await w.waitForEvent((e) => e.event === 'task_added' && e.task_id === 'T-002');
    assert.equal(ev.status, 'pending');
  } finally {
    await w.kill();
  }
});

test('diff: emits task_status_changed with from/to when an existing task transitions', async () => {
  const file = mkTmpFile('## T-001 · Seed\n```yaml\nstatus: pending\n```\n');
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.writeFileSync(file, '## T-001 · Seed\n```yaml\nstatus: in_progress\n```\n');
    const ev = await w.waitForEvent((e) => e.event === 'task_status_changed' && e.task_id === 'T-001');
    assert.equal(ev.from, 'pending');
    assert.equal(ev.to, 'in_progress');
  } finally {
    await w.kill();
  }
});

test('diff: does NOT emit task_status_changed when a non-status field changes', async () => {
  const file = mkTmpFile('## T-001 · Seed\n```yaml\nstatus: pending\nowner: alice\n```\n');
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.writeFileSync(file, '## T-001 · Seed\n```yaml\nstatus: pending\nowner: bob\n```\n');
    await w.waitForEvent((e) => e.event === 'tasks_file_updated');
    await w.settle();
    assert.equal(
      w.events.some((e) => e.event === 'task_status_changed'),
      false,
      'owner-only change must not be reported as a status change',
    );
  } finally {
    await w.kill();
  }
});

// ─── parse errors ───────────────────────────────────────────────────────

test('parse: emits parse_error (severity P1) for an unclosed yaml block', async () => {
  const file = mkTmpFile('## T-001 · Broken\n```yaml\nstatus: pending\n');
  const w = spawnWatcher(file);
  try {
    const ev = await w.waitForEvent((e) => e.event === 'parse_error');
    assert.equal(ev.severity, 'P1');
    assert.match(ev.error, /unclosed yaml block/);
  } finally {
    await w.kill();
  }
});

test('parse: a well-formed file produces zero parse_error events', async () => {
  const file = mkTmpFile('## T-001 · Fine\n```yaml\nstatus: pending\n```\n');
  const w = spawnWatcher(file);
  try {
    await w.waitForEvent((e) => e.event === 'initial_state');
    await w.settle(500);
    assert.equal(w.events.some((e) => e.event === 'parse_error'), false);
  } finally {
    await w.kill();
  }
});

// ─── stuck detection ───────────────────────────────────────────────────

test('stuck: emits task_stuck via dispatch-age fallback for a non-pane owner well past 3x threshold', async () => {
  const content = [
    '## T-003 · Long runner',
    '```yaml',
    'status: in_progress',
    'owner: codex-session',
    'dispatched_at: ' + isoAgo(10 * 60 * 1000), // 10 min ago, threshold=1min*3=3min
    'stuck_threshold_min: 1',
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    // checkStuckTasks only runs inside tick(), and tick() never runs at boot
    // (initial state is captured directly via parseSafely) — force one.
    await bootReady(w);
    fs.appendFileSync(file, '\n');
    const ev = await w.waitForEvent((e) => e.event === 'task_stuck');
    assert.equal(ev.task_id, 'T-003');
    assert.equal(ev.severity, 'P2');
    assert.equal(ev.reason, 'dispatch_age_fallback');
    assert.equal(ev.threshold_min, 1);
    assert.ok(ev.age_min >= 9, `expected age_min >= 9, got ${ev.age_min}`);
  } finally {
    await w.kill();
  }
});

test('stuck: does NOT emit task_stuck for a task dispatched moments ago', async () => {
  const content = [
    '## T-004 · Fresh',
    '```yaml',
    'status: in_progress',
    'owner: codex-session',
    'dispatched_at: ' + isoAgo(0),
    'stuck_threshold_min: 1',
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    // Force an extra tick so checkStuckTasks actually runs post-boot.
    fs.appendFileSync(file, '\n');
    await w.waitForEvent((e) => e.event === 'tasks_file_updated');
    await w.settle();
    assert.equal(w.events.some((e) => e.event === 'task_stuck'), false);
  } finally {
    await w.kill();
  }
});

test('stuck: an unreadable pane owner (no live wezterm) still falls back to dispatch-age instead of crashing', async () => {
  const content = [
    '## T-006 · Pane owner',
    '```yaml',
    'status: in_progress',
    'owner: pane-999999',
    'dispatched_at: ' + isoAgo(10 * 60 * 1000),
    'stuck_threshold_min: 1',
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.appendFileSync(file, '\n');
    const ev = await w.waitForEvent((e) => e.event === 'task_stuck');
    assert.equal(ev.task_id, 'T-006');
    assert.equal(ev.reason, 'dispatch_age_fallback');
  } finally {
    await w.kill();
  }
});

test('stuck: does not re-emit task_stuck on a second tick within the renotify window', async () => {
  const content = [
    '## T-007 · Long runner',
    '```yaml',
    'status: in_progress',
    'owner: codex-session',
    'dispatched_at: ' + isoAgo(10 * 60 * 1000),
    'stuck_threshold_min: 1',
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.appendFileSync(file, '\n'); // first tick
    await w.waitForEvent((e) => e.event === 'task_stuck');
    await w.settle(300); // let the debounce timer from the first write fully clear before the next
    // Trigger a second, unrelated file event → second tick within the same run.
    const before = w.events.filter((e) => e.event === 'tasks_file_updated').length;
    fs.appendFileSync(file, '\n');
    await w.waitForEvent((e) => e.event === 'tasks_file_updated' && w.events.filter((x) => x.event === 'tasks_file_updated').length > before);
    await w.settle();
    const stuckCount = w.events.filter((e) => e.event === 'task_stuck').length;
    assert.equal(stuckCount, 1, `expected exactly one task_stuck across two ticks, got ${stuckCount}`);
  } finally {
    await w.kill();
  }
});

// ─── follow-ups ─────────────────────────────────────────────────────────

test('followups: emits followups_pending (P1) for a completed task with an undispatched pending child', async () => {
  const content = [
    '## T-010 · Parent',
    '```yaml',
    'status: completed',
    'completed_at: ' + isoAgo(10 * 60 * 1000), // past the 5min grace
    'follow_ups:',
    '  - T-011: Do X',
    '```',
    '',
    '## T-011 · Child',
    '```yaml',
    'status: pending',
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    // checkFollowups only runs inside tick(), never at boot — force one.
    await bootReady(w);
    fs.appendFileSync(file, '\n');
    const ev = await w.waitForEvent((e) => e.event === 'followups_pending');
    assert.equal(ev.parent, 'T-010');
    assert.equal(ev.severity, 'P1');
    assert.equal(ev.pending.length, 1);
    assert.equal(ev.pending[0].id, 'T-011');
    assert.equal(ev.pending[0].reason, 'pending_not_dispatched');
  } finally {
    await w.kill();
  }
});

test('followups: does NOT emit followups_pending once the child has been dispatched', async () => {
  const content = [
    '## T-010 · Parent',
    '```yaml',
    'status: completed',
    'completed_at: ' + isoAgo(10 * 60 * 1000),
    'follow_ups:',
    '  - T-011: Do X',
    '```',
    '',
    '## T-011 · Child',
    '```yaml',
    'status: pending',
    'dispatched_at: ' + isoAgo(0),
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.appendFileSync(file, '\n');
    await w.waitForEvent((e) => e.event === 'tasks_file_updated');
    await w.settle();
    assert.equal(w.events.some((e) => e.event === 'followups_pending'), false);
  } finally {
    await w.kill();
  }
});

test('followups: does NOT emit followups_pending while still inside the 5-minute grace period', async () => {
  const content = [
    '## T-010 · Parent',
    '```yaml',
    'status: completed',
    'completed_at: ' + isoAgo(0), // just completed
    'follow_ups:',
    '  - T-011: Do X',
    '```',
    '',
    '## T-011 · Child',
    '```yaml',
    'status: pending',
    '```',
    '',
  ].join('\n');
  const file = mkTmpFile(content);
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.appendFileSync(file, '\n');
    await w.waitForEvent((e) => e.event === 'tasks_file_updated');
    await w.settle();
    assert.equal(w.events.some((e) => e.event === 'followups_pending'), false);
  } finally {
    await w.kill();
  }
});

// ─── file-change plumbing ───────────────────────────────────────────────

test('watch: a plain file write triggers tasks_file_updated', async () => {
  const file = mkTmpFile('## T-001 · Seed\n```yaml\nstatus: pending\n```\n');
  const w = spawnWatcher(file);
  try {
    await bootReady(w);
    fs.appendFileSync(file, '\n');
    await w.waitForEvent((e) => e.event === 'tasks_file_updated');
  } finally {
    await w.kill();
  }
});

// ─── shutdown ───────────────────────────────────────────────────────────
//
// NOT COVERED: the source registers process.on('SIGTERM'/'SIGINT') to exit(0)
// gracefully. Confirmed empirically on this host that Node's child.kill()
// does not deliver a real SIGTERM to a Windows child process at all — it
// hard-terminates it unconditionally (exit code null, signal 'SIGTERM'),
// so the handler never runs and a test asserting "exit code 0 after kill"
// would be asserting a Windows kill() implementation detail, not the
// source's own shutdown code. See tasks-watcher.cjs's SIGTERM/SIGINT
// handlers — genuinely untestable from a spawned-child harness on Windows
// without WSL/POSIX signal delivery.
