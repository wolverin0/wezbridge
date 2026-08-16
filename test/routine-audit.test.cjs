'use strict';
/**
 * Tests for routine-audit.cjs.
 *
 * The property under test is NOT "it finds findings". It is the inverse and much
 * harder one: THE ONLY INPUT THAT PRODUCES SILENCE IS AN EXPLICIT `clean` FROM A
 * RUN THAT COMPLETED. Every other shape — crash, absent artifact, unparseable
 * artifact, unknown verdict word, schedule stopped — must raise. Each of those
 * used to read as "nothing to report".
 *
 * So the assertions that matter here are the ones expecting a finding from an
 * input that looks like nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyRun, classifySilence, auditRuns, loadRuns, auditRoutines, SILENCE_GRACE_HOURS,
} = require('../scripts/routine-audit.cjs');

// SILENCE_GRACE_HOURS is imported ONLY to assert its value below. Test inputs
// use literals on purpose - see the note above the silence tests.

const NOW = Date.parse('2026-08-20T12:00:00Z');
const H = (n) => n * 3600000;

const run = (over = {}) => ({
  id: 'run-test-strength-audit-wezbridge-20260820-040000',
  routine: 'test-strength-audit',
  repo: 'wezbridge',
  exit_status: 0,
  cadence_hours: 168,
  at_ms: NOW - H(2),
  findings: { verdict: 'clean' },
  ...over,
});

// ---------------------------------------------------------------------------
// The one silent case
// ---------------------------------------------------------------------------

test('a completed run reporting clean is the ONLY silent input', () => {
  assert.equal(classifyRun(run(), NOW), null);
});

// ---------------------------------------------------------------------------
// Everything that must NOT be silent
// ---------------------------------------------------------------------------

test('a crashed runner is void, not clean', () => {
  const f = classifyRun(run({ exit_status: 7, findings: null }), NOW);
  assert.equal(f.category, 'routine-void');
  assert.match(f.why, /exited 7/);
});

test('exit 0 with no artifact is void — the absence is the finding', () => {
  const f = classifyRun(run({ findings: null }), NOW);
  assert.equal(f.category, 'routine-void');
  assert.match(f.why, /no findings artifact/);
});

test('a crashed runner that still left an artifact is void — the run is not trustworthy', () => {
  // Guards against reading the artifact first and believing a verdict produced
  // by a process that did not finish.
  const f = classifyRun(run({ exit_status: 1, findings: { verdict: 'clean' } }), NOW);
  assert.equal(f.category, 'routine-void');
});

test('the routine reporting void is carried through with its reason', () => {
  const f = classifyRun(run({ findings: { verdict: 'void', void_reason: 'node_modules missing' } }), NOW);
  assert.equal(f.category, 'routine-void');
  assert.match(f.why, /node_modules missing/);
});

test('an unrecognised verdict word is void, never a pass', () => {
  for (const verdict of ['ok', 'passed', 'CLEAN-ISH', '', undefined, null, 0, true]) {
    const f = classifyRun(run({ findings: { verdict } }), NOW);
    assert.ok(f, `verdict ${JSON.stringify(verdict)} produced silence`);
    assert.equal(f.category, 'routine-void');
  }
});

test('findings are reported with their count', () => {
  const f = classifyRun(run({ findings: { verdict: 'findings', survived: [{}, {}, {}] } }), NOW);
  assert.equal(f.category, 'routine-findings');
  assert.match(f.why, /3 finding\(s\)/);
  assert.doesNotMatch(f.why, /mutation/);  // test-strength-specific wording read as nonsense from the pilot-liveness probe
});

test('verdict matching is case-insensitive so casing cannot flip a verdict', () => {
  assert.equal(classifyRun(run({ findings: { verdict: 'CLEAN' } }), NOW), null);
  assert.equal(classifyRun(run({ findings: { verdict: 'Void' } }), NOW).category, 'routine-void');
});

test('age is measured from the run record, so a finding ages toward its deadline', () => {
  assert.equal(classifyRun(run({ exit_status: 9, at_ms: NOW - H(50) }), NOW).age_hours, 50);
});

// ---------------------------------------------------------------------------
// Silence detection
// ---------------------------------------------------------------------------

test('a routine that never ran produces NO silence finding (anti-wolf)', () => {
  // The bootstrap case. Firing here would mean firing on a schedule that simply
  // has not come round yet, which trains everyone to ignore the gate.
  assert.deepEqual(classifySilence([], NOW), []);
});

// The next three PIN THE POLICY with literals: weekly cadence, 24h grace.
//
// They were written as `H(168 + SILENCE_GRACE_HOURS - 1)`, importing the very
// constant under test — so the input moved whenever the constant moved and a
// mutation setting the grace to 0 survived the whole suite. Caught 2026-08-14
// by running that mutation. A test that reads its subject's own value cannot
// detect a change to it, which is this repo's recurring defect wearing a
// different hat. If these numbers are meant to change, change them HERE too,
// deliberately.
test('a routine still inside its cadence plus grace is silent', () => {
  assert.deepEqual(classifySilence([run({ at_ms: NOW - H(191) })], NOW), [], '191h < 168h cadence + 24h grace');
});

test('the grace is real: an overdue-but-within-grace routine does not fire', () => {
  assert.deepEqual(classifySilence([run({ at_ms: NOW - H(180) })], NOW), [], '180h is past cadence but inside grace');
});

test('a routine past cadence plus grace raises routine-silent', () => {
  const [f] = classifySilence([run({ at_ms: NOW - H(197) })], NOW);   // 168 + 24 + 5
  assert.equal(f.category, 'routine-silent');
  assert.equal(f.age_hours, 5, 'age must be hours OVERDUE, not hours since the run');
  assert.equal(f.id, 'R-silent-test-strength-audit-wezbridge', 'id must be stable so one ruling covers it');
});

test('silence is judged on the NEWEST run per routine+repo, not the oldest', () => {
  const old = run({ id: 'a', at_ms: NOW - H(400) });
  const fresh = run({ id: 'b', at_ms: NOW - H(2) });
  assert.deepEqual(classifySilence([old, fresh], NOW), []);
});

test('two repos running the same routine are tracked independently', () => {
  const a = run({ repo: 'wezbridge', at_ms: NOW - H(2) });
  const b = run({ repo: 'brlite', at_ms: NOW - H(400) });
  const out = classifySilence([a, b], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].repo, 'brlite');
});

test('a missing cadence falls back to weekly rather than to never', () => {
  const r = run({ cadence_hours: undefined, at_ms: NOW - H(193) });   // 168 + 24 + 1
  assert.equal(classifySilence([r], NOW).length, 1);
});

// ---------------------------------------------------------------------------
// Findings must be shaped like steward findings, or the gate cannot consume them
// ---------------------------------------------------------------------------

test('findings carry every field the gate and the renderer read', () => {
  for (const f of auditRuns([run({ exit_status: 3, at_ms: NOW - H(400) })], NOW)) {
    for (const k of ['id', 'repo', 'category', 'age_hours', 'title', 'why']) {
      assert.ok(f[k] !== undefined, `missing ${k} on ${f.category}`);
    }
    assert.ok(Number.isFinite(f.age_hours));
  }
});

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

function tmpIntel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-audit-'));
  fs.mkdirSync(path.join(dir, 'routine-findings'));
  return dir;
}

test('loadRuns ignores a findings artifact with no run record', () => {
  // A stray artifact is not evidence that a run happened. Only the runner, which
  // is deterministic code, gets to assert that.
  const dir = tmpIntel();
  fs.writeFileSync(path.join(dir, 'routine-findings', 'test-strength-audit-x-1.json'),
    JSON.stringify({ verdict: 'findings', survived: [{}] }));
  assert.deepEqual(loadRuns(path.join(dir, 'routine-findings')), []);
});

test('a run record pointing at a missing artifact yields void, not a crash', () => {
  const dir = tmpIntel();
  fs.writeFileSync(path.join(dir, 'routine-findings', 'run-r-x-1.json'),
    JSON.stringify({ routine: 'r', repo: 'x', exit_status: 0, findings_file: 'nope.json' }));
  const [f] = auditRoutines(dir, Date.now());
  assert.equal(f.category, 'routine-void');
});

test('a run record pointing at UNPARSEABLE json yields void, not silence', () => {
  const dir = tmpIntel();
  const fdir = path.join(dir, 'routine-findings');
  fs.writeFileSync(path.join(fdir, 'artifact.json'), '{ this is not json');
  fs.writeFileSync(path.join(fdir, 'run-r-x-1.json'),
    JSON.stringify({ routine: 'r', repo: 'x', exit_status: 0, findings_file: 'artifact.json' }));
  assert.equal(auditRoutines(dir, Date.now())[0].category, 'routine-void');
});

test('a run record with no exit_status field is assumed FAILED, not passed', () => {
  // Defaulting an absent status to 0 would let a truncated record read as a
  // successful run. Absent means unknown, and unknown is not a pass.
  //
  // The artifact here is present AND clean on purpose. The first version of this
  // test pointed at a missing artifact, so it went void for that reason instead
  // and passed no matter what the exit_status default was — a mutation flipping
  // the default to 0 survived it. The only difference between pass and fail must
  // be the thing being tested.
  const dir = tmpIntel();
  const fdir = path.join(dir, 'routine-findings');
  fs.writeFileSync(path.join(fdir, 'clean.json'), JSON.stringify({ verdict: 'clean' }));
  fs.writeFileSync(path.join(fdir, 'run-r-x-1.json'),
    JSON.stringify({ routine: 'r', repo: 'x', findings_file: 'clean.json' }));
  const out = auditRoutines(dir, Date.now());
  assert.equal(out.length, 1, 'an unknown exit status must not read as a clean run');
  assert.equal(out[0].category, 'routine-void');
});

test('an absent routine-findings directory is zero runs, not a crash', () => {
  assert.deepEqual(auditRoutines(path.join(os.tmpdir(), 'definitely-not-here-9f3a'), Date.now()), []);
});

test('a real clean run through the full IO path produces nothing', () => {
  const dir = tmpIntel();
  const fdir = path.join(dir, 'routine-findings');
  fs.writeFileSync(path.join(fdir, 'clean.json'), JSON.stringify({ verdict: 'clean' }));
  fs.writeFileSync(path.join(fdir, 'run-r-x-1.json'), JSON.stringify({
    routine: 'r', repo: 'x', exit_status: 0, cadence_hours: 168, findings_file: 'clean.json',
  }));
  assert.deepEqual(auditRoutines(dir, Date.now()), []);
});

test('absolute findings_file paths resolve (the runner writes absolute)', () => {
  const dir = tmpIntel();
  const fdir = path.join(dir, 'routine-findings');
  const abs = path.join(fdir, 'abs.json');
  fs.writeFileSync(abs, JSON.stringify({ verdict: 'findings', survived: [{}, {}] }));
  fs.writeFileSync(path.join(fdir, 'run-r-x-1.json'), JSON.stringify({
    routine: 'r', repo: 'x', exit_status: 0, findings_file: abs.replace(/\\/g, '/'),
  }));
  const [f] = auditRoutines(dir, Date.now());
  assert.equal(f.category, 'routine-findings');
  assert.match(f.why, /2 finding\(s\)/);
});

test('the policy constants are what the tests above assume', () => {
  // The one place the constant is read. If this fails, the literals in the
  // silence tests are now testing a policy that no longer exists - fix both.
  assert.equal(SILENCE_GRACE_HOURS, 24);
  assert.equal(require('../scripts/routine-audit.cjs').DEFAULT_CADENCE_HOURS, 168);
});
