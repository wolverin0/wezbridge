'use strict';
/**
 * wezterm-transport-flag.test.cjs — T-0596 item 4: WezTerm is retired as a
 * default delivery transport. With WEZBRIDGE_WEZTERM_TRANSPORT unset
 * (default off): a2a_send's to_project resolution and project-queue.cjs's
 * findTarget must NEVER attempt a WezTerm pane resolution/send, even when a
 * live matching WezTerm pane exists in the census — Orca is resolved first
 * and is the only default transport. Setting WEZBRIDGE_WEZTERM_TRANSPORT=1
 * restores the legacy WezTerm-pane-first behavior unchanged.
 * Key terms: WEZBRIDGE_WEZTERM_TRANSPORT, findTarget, a2a_send.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pq = require('../src/project-queue.cjs');
const ROOT = path.resolve(__dirname, '..');

// ── project-queue.cjs findTarget / deliverPending ───────────────────────────

const IDLE_WEZ_PANE = { paneId: 7, agent: 'claude', status: 'idle', project: 'G:/x/wezbridge', tabTitle: null, title: null };

function fixture(t, { wezTransport } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-flag-'));
  t.after(() => { assert.equal(path.dirname(base), os.tmpdir()); fs.rmSync(base, { recursive: true, force: true }); });
  const prior = process.env.WEZBRIDGE_WEZTERM_TRANSPORT;
  if (wezTransport) process.env.WEZBRIDGE_WEZTERM_TRANSPORT = '1';
  else delete process.env.WEZBRIDGE_WEZTERM_TRANSPORT;
  t.after(() => { if (prior === undefined) delete process.env.WEZBRIDGE_WEZTERM_TRANSPORT; else process.env.WEZBRIDGE_WEZTERM_TRANSPORT = prior; });
  const wezCalls = [];
  const orcaCalls = [];
  const config = {
    base, project: 'wezbridge', now: () => Date.parse('2026-09-25T00:00:00Z'),
    discoverPanes: () => [IDLE_WEZ_PANE], // a LIVE matching WezTerm pane exists
    logAction: () => {},
    send: {
      sendPromptDeferredEnter: async (paneId, text) => { wezCalls.push({ paneId, text }); return 'ok'; },
      verifyPromptSubmission: async () => 'submitted',
    },
    resolveOrcaTarget: async () => ({ handle: 'term_wb1', matchedBy: 'lane', ambiguous: [], warning: null }),
    orcaSend: {
      sendToOrcaTerminal: async (handle, body) => {
        orcaCalls.push({ handle, body });
        return { ok: true, submitted: 'submitted', delivered: 'ok', handle, retryId: null, tail: ['...'], error: null };
      },
    },
  };
  // T-0596 V5 backlog seal (project-queue.cjs's ORCA_DRAIN_NOT_BEFORE): an
  // unmocked enqueue timestamp is real wall-clock "today" and can fall before
  // that cutoff, wrongly sealing a freshly-added entry on the Orca branch —
  // same fixup queue-drain-orca-transport.test.cjs uses. Pin the entry's
  // `time` to the mocked clock so this file's assertions are about the
  // WezTerm-flag behavior, not an unrelated backlog-seal date.
  const clock = config.now();
  const add = (corr, body = corr) => {
    const saved = pq.enqueue({ project: 'wezbridge', corr, type: 'progress', from_pane: 9, ok: false, body }, { base });
    const entry = JSON.parse(fs.readFileSync(saved.file, 'utf8').trim());
    fs.writeFileSync(saved.file, JSON.stringify({ ...entry, time: new Date(clock).toISOString() }) + '\n');
    return saved;
  };
  return { base, wezCalls, orcaCalls, config, add };
}

test('queue-drain: flag OFF (default) — a live matching WezTerm pane is never used; Orca resolved first', async (t) => {
  const f = fixture(t, { wezTransport: false });
  f.add('flag-off-1', 'must go via orca, not wezterm');
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(f.wezCalls.length, 0, 'no wezterm send attempted with the flag off');
  assert.equal(outcome.delivered, 1, JSON.stringify(outcome));
  assert.equal(f.orcaCalls.length, 1, 'orca is the default transport');
});

test('queue-drain: flag ON — legacy WezTerm-pane-first delivery still works', async (t) => {
  const f = fixture(t, { wezTransport: true });
  f.add('flag-on-1', 'legacy wezterm path');
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(outcome.delivered, 1, JSON.stringify(outcome));
  assert.equal(f.wezCalls.length, 1, 'flag on restores WezTerm-pane delivery');
  assert.equal(f.orcaCalls.length, 0, 'a resolved WezTerm pane still wins over Orca when the flag is on');
});

test('queue-drain: flag OFF and no live Orca terminal either — target stays queued (missing), never silently dropped', async (t) => {
  const f = fixture(t, { wezTransport: false });
  f.config.resolveOrcaTarget = async () => ({ handle: null, matchedBy: null, ambiguous: [], warning: 'no orca terminal' });
  f.add('flag-off-no-orca', 'nobody can take this');
  const consumer = pq.createConsumer(f.config);
  const outcome = await consumer.drain();
  assert.equal(f.wezCalls.length, 0);
  assert.equal(f.orcaCalls.length, 0);
  assert.equal(outcome.delivered, 0);
  assert.equal(outcome.dropped, 1, 'project-not-live: dropped with a reason, not silently discarded');
});

// ── mcp-server.cjs a2a_send (real subprocess, real WezTerm census stub) ────

function invokeA2aSend(t, { wezTransport }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wez-flag-mcp-'));
  const cwd = path.join(temporary, 'producer');
  const intel = path.join(temporary, '_intel');
  const countFile = path.join(temporary, 'wez-call-count');
  fs.mkdirSync(cwd);
  fs.writeFileSync(countFile, '0');
  t.after(() => { assert.equal(path.dirname(temporary), os.tmpdir()); fs.rmSync(temporary, { recursive: true, force: true }); });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WEZBRIDGE_INTEL_DIR: intel, WEZTERM_CALL_COUNT_FILE: countFile };
    if (wezTransport) env.WEZBRIDGE_WEZTERM_TRANSPORT = '1'; else delete env.WEZBRIDGE_WEZTERM_TRANSPORT;
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers/wezterm-flag-preload.cjs'), path.join(ROOT, 'src/mcp-server.cjs')], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timeout: ${errors}`)); }, 15000);
    child.on('error', reject);
    child.stderr.on('data', (data) => { errors += data; });
    child.stdout.on('data', (data) => { output += data; });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve({ response: JSON.parse(output.trim()).result, wezCalls: Number(fs.readFileSync(countFile, 'utf8')) });
      } catch (error) { reject(new Error(`${error.message}: ${errors}`)); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'a2a_send', arguments: { from_pane: 1, to_project: 'consumer', corr: 'wez-flag-probe', type: 'progress', body: 'wezterm transport flag probe' },
    } }) + '\n');
  });
}

test('a2a_send: flag OFF (default) — a live matching WezTerm pane is never sent to (0 wezterm calls)', async (t) => {
  const { wezCalls } = await invokeA2aSend(t, { wezTransport: false });
  assert.equal(wezCalls, 0, 'no wezterm send attempted with the flag off');
});

test('a2a_send: flag ON — legacy WezTerm-pane-first delivery still works', async (t) => {
  const { response, wezCalls } = await invokeA2aSend(t, { wezTransport: true });
  assert.equal(wezCalls, 1, 'flag on restores WezTerm-pane delivery');
  assert.equal(Boolean(response.isError), false);
});
