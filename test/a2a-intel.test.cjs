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

// T-0400: was a source-regex check ("recordResultBody( appears exactly once,
// guarded by msgType === 'result'") — an `if (false)` around the guarded
// block left it green because the regex only ever inspected TEXT, never
// whether the call actually ran. Rewritten to invoke the REAL mcp-server
// (test/helpers/mcp-call.cjs) and read a2a-results.jsonl for the effect: a
// type=result send must persist exactly one line; a type=request send with
// the same shape must persist NONE.
test('call-site gate: mcp-server persists bodies ONLY for type=result', async (t) => {
  const { callA2aSend, textOf, fixture } = require('./helpers/mcp-call.cjs');
  const dir = fixture(t, 'a2a-intel-callsite-');
  const body = 'criteria:\n- G1: pass — evidence here';

  const resultRes = await callA2aSend(
    { from_pane: 401, to_pane: 402, corr: 'cs-result-1', type: 'result', body },
    { WEZBRIDGE_INTEL_DIR: dir },
  );
  assert.notEqual(resultRes.isError, true, `unexpected error: ${textOf(resultRes)}`);
  const lines = fs.readFileSync(path.join(dir, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1, 'exactly one recordResultBody call site: one result in, one line out');
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.corr, 'cs-result-1');
  assert.strictEqual(rec.body, body);

  const reqRes = await callA2aSend(
    { from_pane: 401, to_pane: 402, corr: 'cs-request-1', type: 'request', body: 'not a result' },
    { WEZBRIDGE_INTEL_DIR: dir },
  );
  assert.notEqual(reqRes.isError, true, `unexpected error: ${textOf(reqRes)}`);
  const linesAfter = fs.readFileSync(path.join(dir, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(linesAfter.length, 1, 'a request must never add a second a2a-results.jsonl line — the call site must stay guarded by msgType === \'result\'');
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

// ── ABANDON visibility (unlazy adoption, 2026-08-21) ─────────────────────
// Silent scope-narrowing is the failure the fleet keeps hunting; unlazy's
// convention makes surrender VISIBLE: "ABANDON: <what> <why>". detectAbandons
// surfaces those lines so events/results carry the count instead of losing it.

test('detectAbandons: counts ABANDON: lines and extracts what was surrendered', () => {
  const { detectAbandons } = require('../src/a2a-intel.cjs');
  const body = [
    'criteria:',
    '- G1: pass — 10/10',
    'ABANDON: G3 el endpoint del proveedor fue retirado',
    'files_changed: x.js',
    'ABANDON: G4 sin acceso al entorno objetivo',
  ].join('\n');
  const out = detectAbandons(body);
  assert.equal(out.count, 2);
  assert.match(out.items[0], /G3/);
  assert.match(out.items[1], /G4/);
});

test('detectAbandons: cero en un body sin rendiciones', () => {
  const { detectAbandons } = require('../src/a2a-intel.cjs');
  assert.deepEqual(detectAbandons('criteria:\n- G1: pass'), { count: 0, items: [] });
});

// ── Decision ledger (A1, 2026-08-22) ─────────────────────────────────────
// dzhng pattern: a result body MAY carry a "decisions:" block — every choice
// made where the plan was silent, with self-assessed confidence and what the
// agent would have asked. detectDecisions parses it; detectEvidence extracts
// the evidence tails of criteria verdict lines; detectV2 gains 'partial'.

test('detectV2: partial when a criteria heading has no pass/fail verdicts', () => {
  assert.strictEqual(intel.detectV2('criteria:\n- build green\n- deploy done'), 'partial');
});

test('detectV2: legacy results keep their verdict — ok stays ok, missing stays missing', () => {
  // Exit criterion A1: legacy result sigue ok/missing como hoy (WARN-only intacto).
  assert.strictEqual(intel.detectV2('criteria:\n- tokens expire: pass — tests/auth.test.ts'), 'ok');
  assert.strictEqual(intel.detectV2('All done, everything works, deployed fine.'), 'missing');
});

test('detectDecisions: parses items with confidence and what would have been asked', () => {
  const body = [
    'criteria:',
    '- G1: pass — 10/10',
    'decisions:',
    '- usé el puerto 4201 [conf: baja] — habría preguntado si 4200 estaba reservado',
    '- mantuve WARN-only [conf: alta] — nada',
    'next_action: none',
  ].join('\n');
  const out = intel.detectDecisions(body);
  assert.strictEqual(out.count, 2);
  assert.strictEqual(out.items[0].confidence, 'baja');
  assert.match(out.items[0].decision, /4201/);
  assert.match(out.items[0].would_have_asked, /4200 estaba reservado/);
  assert.strictEqual(out.items[1].confidence, 'alta');
});

test('detectDecisions: an item without a [conf:] tag still counts, confidence null', () => {
  const out = intel.detectDecisions('decisions:\n- renombré la variable sin avisar');
  assert.strictEqual(out.count, 1);
  assert.strictEqual(out.items[0].confidence, null);
  assert.strictEqual(out.items[0].would_have_asked, null);
});

test('detectDecisions: block ends at the first non-item line', () => {
  const body = 'decisions:\n- a [conf: media] — b\nfiles_changed:\n- src/x.cjs';
  const out = intel.detectDecisions(body);
  assert.strictEqual(out.count, 1, 'files_changed items must not leak into decisions');
});

test('detectDecisions: cero sin bloque, y prosa "decisions:" en medio de línea no cuenta', () => {
  assert.deepStrictEqual(intel.detectDecisions('criteria:\n- G1: pass'), { count: 0, items: [] });
  assert.strictEqual(intel.detectDecisions('we discussed decisions: several were made\n- not an item').count, 0);
});

test('detectEvidence: counts only verdict lines that carry an evidence tail', () => {
  const body = [
    'criteria:',
    '- tokens expire: pass — tests/auth.test.ts',
    '- single-use: fail — replay accepted, see notes',
    '- deploy: pass', // verdict WITHOUT evidence — must not count
  ].join('\n');
  const out = intel.detectEvidence(body);
  assert.strictEqual(out.count, 2);
  assert.match(out.items[0], /auth\.test\.ts/);
  assert.match(out.items[1], /replay accepted/);
});

test('detectEvidence: cero en prosa libre sin líneas de veredicto', () => {
  assert.deepStrictEqual(intel.detectEvidence('All done, works fine.'), { count: 0, items: [] });
});

test('recordResultBody persists decisions (count+items) and evidence in the record', () => {
  const body = [
    'criteria:',
    '- G1: pass — suite 10/10',
    'decisions:',
    '- elegí sha1 para dedupe [conf: media] — habría preguntado el algoritmo',
  ].join('\n');
  intel.recordResultBody({ corr: 'dl-1', fromPane: 3, toPane: 0, v2: 'ok', body });
  const lines = fs.readFileSync(path.join(TMP, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(rec.decisions.count, 1);
  assert.strictEqual(rec.decisions.items[0].confidence, 'media');
  assert.match(rec.decisions.items[0].would_have_asked, /algoritmo/);
  assert.strictEqual(rec.evidence.count, 1);
  assert.match(rec.evidence.items[0], /suite 10\/10/);
});

test('recordResultBody: a legacy result (sin decisions) persiste count 0 y sigue ok', () => {
  const body = 'Done.\ncriteria:\n- x: pass — evidence here';
  intel.recordResultBody({ corr: 'dl-legacy', fromPane: 3, toPane: 0, v2: intel.detectV2(body), body });
  const lines = fs.readFileSync(path.join(TMP, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(rec.v2, 'ok', 'legacy result sigue ok');
  assert.deepStrictEqual(rec.decisions, { count: 0, items: [] });
});

// T-0400: was a source-regex check for the ternary literal — an `if (false)`
// around the ternary's true branch left this green (the text still matched
// even when the branch could never run). Rewritten to invoke the real
// mcp-server and read the TOOL RESPONSE, not a2a-results.jsonl: the response
// JSON's decisions/evidence COUNT fields come straight from mcp-server.cjs's
// own local `decisions`/`evidence` variables — recordResultBody separately
// (and unconditionally, once called) recomputes decisions/evidence from the
// body itself, so reading the persisted record would test recordResultBody,
// not this call site's guard.
test('call-site gate: mcp-server computes decisions/evidence ONLY for type=result', async (t) => {
  const { callA2aSend, textOf, fixture } = require('./helpers/mcp-call.cjs');
  const dir = fixture(t, 'a2a-intel-decisions-');
  const body = [
    'criteria:',
    '- G1: pass — suite 10/10',
    'decisions:',
    '- elegí sha1 para dedupe [conf: media] — habría preguntado el algoritmo',
  ].join('\n');

  const res = await callA2aSend(
    { from_pane: 411, to_pane: 412, corr: 'cs-dec-1', type: 'result', body },
    { WEZBRIDGE_INTEL_DIR: dir },
  );
  assert.notEqual(res.isError, true, `unexpected error: ${textOf(res)}`);
  const out = JSON.parse(textOf(res));
  assert.strictEqual(out.decisions, 1, 'the response must report the computed decisions count for type=result');
  assert.strictEqual(out.evidence, 1, 'the response must report the computed evidence count for type=result');

  const reqRes = await callA2aSend(
    { from_pane: 411, to_pane: 412, corr: 'cs-dec-2', type: 'request', body },
    { WEZBRIDGE_INTEL_DIR: dir },
  );
  assert.notEqual(reqRes.isError, true, `unexpected error: ${textOf(reqRes)}`);
  const reqOut = JSON.parse(textOf(reqRes));
  assert.strictEqual(reqOut.decisions, undefined, 'a request must not compute/report decisions — the guard is on msgType, not body shape');
  assert.strictEqual(reqOut.evidence, undefined, 'a request must not compute/report evidence — the guard is on msgType, not body shape');
});

// ── Auto-ack bookkeeping (B1, 2026-08-22) ────────────────────────────────
// A VERIFIED result delivery proves receipt — the "got it" ack stops being an
// LLM turn. autoAckResult closes ONLY awaiting-ack threads; the requester's
// judgement on the result is not automated anywhere.

test('autoAckResult: closes an awaiting-ack thread and records the closure', () => {
  withTmpIntelDir((dir) => {
    intel.updateThreads({ fromPane: 1, toPane: 2, corr: 'aa-1', type: 'request' });
    intel.updateThreads({ fromPane: 2, toPane: 1, corr: 'aa-1', type: 'result' });
    assert.strictEqual(intel.autoAckResult({ corr: 'aa-1', byPane: 2 }), true);
    const threads = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8')).threads;
    assert.strictEqual(threads['aa-1'], undefined, 'the bookkeeping acuse closes the thread');
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some((e) => e.event === 'a2a.thread-auto-acked' && e.corr === 'aa-1'),
      'the closure must be auditable');
  });
});

test('autoAckResult: an open (non-awaiting-ack) thread and an unknown corr are untouched', () => {
  withTmpIntelDir((dir) => {
    intel.updateThreads({ fromPane: 1, toPane: 2, corr: 'aa-2', type: 'request' });
    assert.strictEqual(intel.autoAckResult({ corr: 'aa-2', byPane: 1 }), false,
      'a request without a result has nothing to acuse');
    assert.strictEqual(intel.autoAckResult({ corr: 'aa-never', byPane: 1 }), false);
    const threads = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8')).threads;
    assert.strictEqual(threads['aa-2'].state, 'open', 'the open request thread survives');
  });
});

test('autoAckResult: fail-soft — unwritable intel dir never throws', () => {
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = path.join(TMP, 'no\0valid');
  assert.doesNotThrow(() => intel.autoAckResult({ corr: 'x', byPane: 1 }));
  process.env.WEZBRIDGE_INTEL_DIR = prev;
});

// T-0400: was a source-regex check on the guard's literal shape — an
// `if (false)` around it left this green regardless of whether autoAckResult
// ever actually ran. Rewritten to invoke the real mcp-server against
// test/mocks/wezterm-echo-mock.cjs, the ONE double in this suite that echoes
// pasted text back (test/mocks/wezterm-mock.cjs is static, so a real
// verified delivery — submitted==='submitted', delivered!=='truncated' — can
// never happen against it): open a thread with a request, close it with a
// result, and assert the thread is gone iff the delivery the echo mock
// produced was actually verified.
test('call-site gate: mcp-server auto-acks ONLY verified type=result deliveries', async (t) => {
  const { callA2aSend, textOf, fixture } = require('./helpers/mcp-call.cjs');
  const dir = fixture(t, 'a2a-intel-autoack-');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-intel-echo-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const env = {
    WEZBRIDGE_INTEL_DIR: dir,
    // T-0400 fix-up: WEZBRIDGE_WEZTERM_BIN is always clobbered by setup.cjs in
    // the child now; route the echo double through WEZBRIDGE_TEST_WEZTERM_BIN.
    WEZBRIDGE_TEST_WEZTERM_BIN: path.join(__dirname, 'mocks', 'wezterm-echo-mock.cjs'),
    WEZBRIDGE_MOCK_ECHO_STATE: path.join(stateDir, 'state.json'),
  };
  const corr = 'cs-autoack-1';

  const reqRes = await callA2aSend({ from_pane: 555, to_pane: 1, corr, type: 'request', body: 'do the thing' }, env);
  assert.notEqual(reqRes.isError, true, `unexpected error opening thread: ${textOf(reqRes)}`);
  let threads = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8')).threads;
  assert.strictEqual(threads[corr].state, 'open', 'sanity: the thread must actually be open before the result');

  const resultRes = await callA2aSend({ from_pane: 1, to_pane: 555, corr, type: 'result', body: 'criteria:\n- G1: pass — done' }, env);
  assert.notEqual(resultRes.isError, true, `unexpected error sending result: ${textOf(resultRes)}`);
  const out = JSON.parse(textOf(resultRes));
  assert.strictEqual(out.submitted, 'submitted', 'the echo mock must produce a verified submission, or this test proves nothing');
  assert.notStrictEqual(out.delivered, 'truncated', 'the echo mock must produce non-truncated delivery, or this test proves nothing');
  assert.strictEqual(out.auto_acked, true, 'a verified type=result delivery must auto-ack');

  threads = JSON.parse(fs.readFileSync(path.join(dir, 'a2a-threads.json'), 'utf8')).threads;
  assert.strictEqual(threads[corr], undefined, 'the auto-ack must close the thread');
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.event === 'a2a.thread-auto-acked' && e.corr === corr), 'the closure must be auditable');
});

test('recordResultBody persists abandons so surrender survives the scrollback', () => {
  const { recordResultBody } = require('../src/a2a-intel.cjs');
  recordResultBody({ corr: 'c-ab', fromPane: 1, toPane: 0, v2: 'ok',
    body: 'criteria:\n- G1: pass\nABANDON: G2 imposible por retiro del API' });
  const lines = fs.readFileSync(path.join(TMP, 'a2a-results.jsonl'), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.abandons, 1, 'el count de ABANDON debe persistirse en el registro');
});
