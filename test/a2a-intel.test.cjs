'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the module at a temp intel dir BEFORE requiring it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-intel-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP;
const intel = require('../src/a2a-intel.cjs');

test('detectV2: ok when criteria block with pass/fail verdicts present', () => {
  const body = 'Done.\ncriteria:\n- tokens expire: pass — tests/auth.test.ts\n- single-use: fail — see notes\nfiles_changed:\n- src/auth.ts';
  assert.strictEqual(intel.detectV2(body), 'ok');
});

test('detectV2: ok with acceptance_criteria spelling', () => {
  assert.strictEqual(intel.detectV2('acceptance_criteria:\n- build green: passed'), 'ok');
});

test('detectV2: missing for free-prose result', () => {
  assert.strictEqual(intel.detectV2('All done, everything works, deployed fine.'), 'missing');
});

test('detectV2: missing when verdict words appear without a criteria block', () => {
  assert.strictEqual(intel.detectV2('tests pass, lint passes'), 'missing');
});

test('recordEvent appends metadata lines to events.jsonl', () => {
  intel.recordEvent({ from_pane: 1, to_pane: 2, corr: 'evt-t1', type: 'request' });
  intel.recordEvent({ from_pane: 2, to_pane: 1, corr: 'evt-t1', type: 'result', v2: 'ok' });
  const lines = fs.readFileSync(path.join(TMP, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.event, 'a2a.sent');
  assert.strictEqual(last.corr, 'evt-t1');
  assert.strictEqual(last.v2, 'ok');
  assert.ok(last.time);
});

test('thread lifecycle: request opens, result awaits ack, ack closes', () => {
  const file = path.join(TMP, 'a2a-threads.json');
  intel.updateThreads({ fromPane: 10, toPane: 20, corr: 'th-1', type: 'request' });
  let threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-1'].state, 'open');
  assert.strictEqual(threads['th-1'].requester, 10);

  intel.updateThreads({ fromPane: 20, toPane: 10, corr: 'th-1', type: 'result' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-1'].state, 'awaiting-ack');
  assert.strictEqual(threads['th-1'].result_to, 10);

  intel.updateThreads({ fromPane: 10, toPane: 20, corr: 'th-1', type: 'ack' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-1'], undefined);
});

test('updateThreads returns corrs awaiting THIS pane\'s ack', () => {
  // pane 30 requests, pane 40 results back to 30 -> pane 30 owes an ack.
  intel.updateThreads({ fromPane: 30, toPane: 40, corr: 'th-2', type: 'request' });
  intel.updateThreads({ fromPane: 40, toPane: 30, corr: 'th-2', type: 'result' });
  // Next send BY pane 30 (any thread) must surface th-2 as unacked inbound.
  const owed = intel.updateThreads({ fromPane: 30, toPane: 99, corr: 'other', type: 'request' });
  assert.ok(owed.includes('th-2'));
  // Pane 40 sending again does NOT see th-2 (it is owed BY 30, not 40).
  const notOwed = intel.updateThreads({ fromPane: 40, toPane: 99, corr: 'other2', type: 'request' });
  assert.ok(!notOwed.includes('th-2'));
  // Cleanup: ack closes it.
  intel.updateThreads({ fromPane: 30, toPane: 40, corr: 'th-2', type: 'ack' });
});

test('gate line: progress body starting GATE:<kind>:<state> is recorded on the thread', () => {
  const file = path.join(TMP, 'a2a-threads.json');
  intel.updateThreads({ fromPane: 50, toPane: 60, corr: 'th-g1', type: 'request' });
  intel.updateThreads({
    fromPane: 60, toPane: 50, corr: 'th-g1', type: 'progress',
    body: 'GATE:customer-send:waiting — 5 staged sends need operator command\nmore detail below',
  });
  let threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g1'].gate.kind, 'customer-send');
  assert.strictEqual(threads['th-g1'].gate.state, 'waiting');
  assert.match(threads['th-g1'].gate.detail, /5 staged sends/);

  // A later gate line updates the state; case-insensitive, hyphen separator ok.
  intel.updateThreads({ fromPane: 60, toPane: 50, corr: 'th-g1', type: 'progress', body: 'gate:customer-send:cleared - operator approved' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g1'].gate.state, 'cleared');

  // A plain progress body PRESERVES the last gate, does not clear it.
  intel.updateThreads({ fromPane: 60, toPane: 50, corr: 'th-g1', type: 'progress', body: 'still working, 60% done' });
  threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g1'].gate.state, 'cleared');
  intel.updateThreads({ fromPane: 50, toPane: 60, corr: 'th-g1', type: 'ack' });
});

test('gate line: prose mentioning GATE mid-body is NOT parsed as a gate', () => {
  const file = path.join(TMP, 'a2a-threads.json');
  intel.updateThreads({ fromPane: 70, toPane: 80, corr: 'th-g2', type: 'request' });
  intel.updateThreads({ fromPane: 80, toPane: 70, corr: 'th-g2', type: 'progress', body: 'discussing the GATE:deploy:waiting convention in docs' });
  const threads = JSON.parse(fs.readFileSync(file, 'utf8')).threads;
  assert.strictEqual(threads['th-g2'].gate, undefined);
  intel.updateThreads({ fromPane: 70, toPane: 80, corr: 'th-g2', type: 'ack' });
});

test('fail-soft: unwritable intel dir never throws', () => {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = path.join(TMP, 'no\0valid');
  assert.doesNotThrow(() => intel.recordEvent({ corr: 'x', type: 'request' }));
  assert.doesNotThrow(() => intel.updateThreads({ fromPane: 1, toPane: 2, corr: 'x', type: 'request' }));
  process.env.WEZBRIDGE_INTEL_DIR = prev;
});

test('an early ack does not close the thread, and the result still requires one', () => {
  // The real sequence that broke: request -> ack ("got it") -> progress -> result.
  // v1 deleted the thread at the ack, the progress recreated it from nothing, and
  // the result parked it at awaiting-ack with nobody left to acknowledge — because
  // the requester had already acked. Three such threads sat open for five days.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-threads-'));
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  try {
    const corr = 'register-gym';
    intel.updateThreads({ fromPane: 4, toPane: 45, corr, type: 'request', body: 'do the thing' });
    intel.updateThreads({ fromPane: 45, toPane: 4, corr, type: 'ack', body: 'got it' });

    const afterEarlyAck = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8'));
    assert.ok(afterEarlyAck.threads[corr], 'an early ack must NOT delete the thread');
    assert.ok(afterEarlyAck.threads[corr].acked_at, 'but it should be recorded');

    intel.updateThreads({ fromPane: 45, toPane: 4, corr, type: 'progress', body: 'working' });
    const owed = intel.updateThreads({ fromPane: 45, toPane: 4, corr, type: 'result', body: 'done' });
    assert.deepStrictEqual(owed, [], 'the RESPONDER is not owed its own result');

    // The requester is the one who now owes an ack.
    const owedByRequester = intel.updateThreads({ fromPane: 4, toPane: 45, corr, type: 'progress', body: 'noted' });
    assert.deepStrictEqual(owedByRequester, [corr], 'the requester owes the ack');

    intel.updateThreads({ fromPane: 4, toPane: 45, corr, type: 'ack', body: 'accepted' });
    const closed = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8'));
    assert.strictEqual(closed.threads[corr], undefined, 'the ack ON A RESULT closes it');
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ack for an unknown corr invents nothing', () => {
  // Manufacturing an open thread from a stray acknowledgement would recreate the
  // very noise this fix removes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-threads-'));
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  try {
    intel.updateThreads({ fromPane: 9, toPane: 4, corr: 'never-seen', type: 'ack', body: 'ok' });
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8'));
    assert.strictEqual(data.threads['never-seen'], undefined);
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- recordResultBody: type=result bodies persist to a2a-results.jsonl ------
// 4,180 A2A envelopes were sent and 0 result bodies retained — the criteria:
// blocks (the fleet's machine-checkable outcomes) died with the pane scrollback.
// Bodies go to a SIBLING file; events.jsonl's contract stays metadata-only.

function withTmpIntelDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-results-'));
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('recordResultBody: a result body persists as one line with corr + body', () => {
  withTmpIntelDir((dir) => {
    const body = 'Done.\ncriteria:\n- tokens expire: pass — tests/auth.test.ts\nfiles_changed:\n- src/auth.ts';
    intel.recordResultBody({ corr: 'rb-1', fromPane: 4, toPane: 7, v2: 'ok', body });
    const lines = fs.readFileSync(path.join(dir, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1, 'exactly one line per result');
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.event, 'a2a.result');
    assert.strictEqual(rec.corr, 'rb-1');
    assert.strictEqual(rec.from_pane, 4);
    assert.strictEqual(rec.to_pane, 7);
    assert.strictEqual(rec.v2, 'ok');
    assert.strictEqual(rec.body, body);
    assert.strictEqual(rec.body_truncated, false);
    assert.ok(rec.time);
  });
});

test('recordResultBody: a 20KB body is capped at 16KB with body_truncated:true', () => {
  withTmpIntelDir((dir) => {
    const big = 'x'.repeat(20 * 1024);
    intel.recordResultBody({ corr: 'rb-big', fromPane: 1, toPane: 2, v2: 'missing', body: big });
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-results.jsonl'), 'utf8').trim());
    assert.strictEqual(rec.body.length, 16 * 1024, 'body capped at 16KB');
    assert.strictEqual(rec.body_truncated, true);
  });
});

test('request/progress/ack flow leaves a2a-results.jsonl untouched', () => {
  withTmpIntelDir((dir) => {
    // The exact non-result flow mcp-server runs: recordEvent + updateThreads.
    for (const type of ['request', 'progress', 'ack']) {
      intel.recordEvent({ from_pane: 1, to_pane: 2, corr: 'nr-1', type });
      intel.updateThreads({ fromPane: 1, toPane: 2, corr: 'nr-1', type, body: 'some body text' });
    }
    assert.ok(!fs.existsSync(path.join(dir, 'a2a-results.jsonl')),
      'only type=result may create a2a-results.jsonl');
  });
});

test('events.jsonl contract holds: no line ever carries a body key', () => {
  withTmpIntelDir((dir) => {
    // Full result flow as mcp-server runs it: metadata event + body persist.
    intel.recordEvent({ from_pane: 4, to_pane: 7, corr: 'ct-1', type: 'result', v2: 'ok' });
    intel.recordResultBody({ corr: 'ct-1', fromPane: 4, toPane: 7, v2: 'ok', body: 'criteria:\n- x: pass' });
    intel.updateThreads({ fromPane: 4, toPane: 7, corr: 'ct-1', type: 'result', body: 'criteria:\n- x: pass' });
    const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      assert.ok(!('body' in JSON.parse(line)), 'events.jsonl is metadata only, never bodies');
    }
  });
});

test('recordResultBody: fail-soft — unwritable intel dir never throws', () => {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = path.join(TMP, 'no\0valid');
  assert.doesNotThrow(() => intel.recordResultBody({ corr: 'x', fromPane: 1, toPane: 2, v2: 'ok', body: 'b' }));
  process.env.WEZBRIDGE_INTEL_DIR = prev;
});

test('call-site gate: mcp-server persists bodies ONLY for type=result', () => {
  // mcp-server.cjs exports nothing (top-level server script), so the gate is
  // enforced at source level: the ONE call must sit behind the result guard.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp-server.cjs'), 'utf8');
  const calls = src.match(/recordResultBody\(/g) || [];
  assert.strictEqual(calls.length, 1, 'exactly one recordResultBody call site');
  assert.match(src, /if \(msgType === 'result'\) a2aIntel\.recordResultBody\(/,
    'the call must be guarded by msgType === \'result\'');
});

test('an error still closes the thread outright', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-threads-'));
  const prior = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  try {
    intel.updateThreads({ fromPane: 4, toPane: 9, corr: 'boom', type: 'request', body: 'x' });
    intel.updateThreads({ fromPane: 9, toPane: 4, corr: 'boom', type: 'error', body: 'aborted' });
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8'));
    assert.strictEqual(data.threads.boom, undefined, 'an abort ends the thread');
  } finally {
    if (prior === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
