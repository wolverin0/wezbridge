'use strict';
/**
 * The /clear interlock.
 *
 * ONE PROPERTY MATTERS HERE: /clear is irreversible, so it must never be sent
 * unless a handoff file actually appeared on disk. A pane that ignored the ask —
 * because it was busy, or out of weekly budget — looks identical to one that
 * complied. Clearing on the assumption destroys a session's working state with
 * no record of it.
 *
 * These drive the real script through its send seam, so what is asserted is the
 * ACTUAL sequence of things it would have typed into a pane, in order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rotate-pane.cjs');
const ROOT = path.join(__dirname, '..', '..');

/** Run rotate-pane against a throwaway project, capturing what it "sent". */
function rotate(args, { waitMs = 2000, handoffAfterMs = null } = {}) {
  const name = `__rotate-test-${process.pid}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const proj = path.join(ROOT, name);
  const hDir = path.join(proj, 'handoffs');
  fs.mkdirSync(hDir, { recursive: true });
  const sent = path.join(os.tmpdir(), `${name}-sent.txt`);
  fs.writeFileSync(sent, '');

  // The delayed write MUST come from a separate OS process. The first version
  // used setTimeout in this process, and spawnSync below blocks the event loop —
  // so the timer never fired, no handoff ever appeared, and the happy-path test
  // failed at baseline while the code was correct. A fixture that cannot run
  // during the thing it is a fixture for tests nothing.
  let writer = null;
  if (handoffAfterMs !== null) {
    const target = path.join(hDir, 'handoff-2026-08-14T2040-x.md').replace(/\\/g, '\\\\');
    writer = spawn(process.execPath, ['-e',
      `setTimeout(() => { try { require('fs').writeFileSync('${target}', '# handoff'); } catch {} }, ${handoffAfterMs})`],
    { detached: true, stdio: 'ignore' });
    writer.unref();
  }

  const r = spawnSync(process.execPath, [SCRIPT, '--project', name, '--tab-title', 'x', ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      WEZBRIDGE_ROTATE_FAKE_SEND: sent,
      WEZBRIDGE_HANDOFF_WAIT_MS: String(waitMs),
      WEZBRIDGE_ROTATE_POLL_MS: '300',
      WEZBRIDGE_CLEAR_SETTLE_MS: '100',
    },
  });

  try { writer?.kill(); } catch { /* already gone */ }
  const lines = fs.readFileSync(sent, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(sent, { force: true });
  return { code: r.status, lines, stdout: `${r.stdout || ''}${r.stderr || ''}` };
}

test('NO handoff written means /clear is never sent and the pane is left intact', () => {
  const r = rotate(['--mode', 'handoff'], { waitMs: 1500, handoffAfterMs: null });
  assert.equal(r.code, 6, 'must exit 6, the "aborted, nothing touched" code');
  assert.ok(!r.lines.some((l) => l.startsWith('/clear')), `/clear was sent anyway: ${JSON.stringify(r.lines)}`);
  assert.deepEqual(r.lines, ['/handoff'], 'only the ask should have gone out');
  assert.match(r.stdout, /NOT sending \/clear/);
});

test('a handoff appearing unblocks the rotation, in the right order', () => {
  const r = rotate(['--mode', 'handoff'], { waitMs: 8000, handoffAfterMs: 600 });
  assert.equal(r.code, 0);
  const ask = r.lines.findIndex((l) => l.startsWith('/handoff'));
  const clear = r.lines.findIndex((l) => l.startsWith('/clear'));
  assert.ok(ask > -1 && clear > ask, `order wrong: ${JSON.stringify(r.lines)}`);
  assert.match(r.lines[clear + 1] || '', /handoff-2026-08-14T2040-x\.md/,
    'the resume prompt must name the handoff file, or the fresh session starts blind');
});

test('a PRE-EXISTING handoff does not count as a fresh one', () => {
  // Otherwise any project with handoff history would clear instantly, which is
  // the interlock failing open on the most common input there is.
  const name = `__rotate-pre-${process.pid}`;
  const proj = path.join(ROOT, name);
  fs.mkdirSync(path.join(proj, 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'handoffs', 'handoff-2026-07-01T0000-old.md'), 'old');
  const sent = path.join(os.tmpdir(), `${name}-sent.txt`);
  fs.writeFileSync(sent, '');
  const r = spawnSync(process.execPath, [SCRIPT, '--project', name, '--tab-title', 'x', '--mode', 'handoff'], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, WEZBRIDGE_ROTATE_FAKE_SEND: sent, WEZBRIDGE_HANDOFF_WAIT_MS: '2000', WEZBRIDGE_ROTATE_POLL_MS: '300' },
  });
  const lines = fs.readFileSync(sent, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(sent, { force: true });
  assert.equal(r.status, 6, 'an old handoff must not satisfy the interlock');
  assert.ok(!lines.some((l) => l.startsWith('/clear')));
});

test('compact mode never asks for a handoff and never clears', () => {
  const r = rotate(['--mode', 'compact']);
  assert.equal(r.code, 0);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^\/compact/);
});

test('bad usage is refused rather than guessed at', () => {
  const bad = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 }).status;
  assert.equal(bad(['--mode', 'compact']), 2, 'no target');
  assert.equal(bad(['--tab-title', 'x', '--mode', 'nonsense']), 2, 'unknown mode');
  assert.equal(bad(['--tab-title', 'x', '--project', 'definitely-not-a-project', '--mode', 'handoff']), 2,
    'handoff mode needs a real project directory to watch');
});
