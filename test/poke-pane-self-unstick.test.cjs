'use strict';
/**
 * T-0473 (2026-09-23) — poke-pane FAIL(9) used to leave its own partial payload
 * in the composer "for the operator" and then die exit 10 on EVERY subsequent
 * poke to that pane, claiming "a key from the operator unblocks it". Measured:
 * FALSE — a single Ctrl+C clears it, verified composerContent()=='' after,
 * session intact (Ctrl+U 0x15 is NOT bound). Measured 15/09: the only executor
 * with credits sat 2h waiting for a keystroke that was never actually required.
 *
 * AC1 (fail-first, full stack): a pane whose composer shows ONLY a fragment of
 * the payload poke-pane just wrote (a fragmented paste) used to lock out every
 * later run with exit 10. The harness below runs the REAL poke-pane.cjs source
 * (sandboxed, same pattern as poke-pane-audit.test.cjs) against a stateful pane
 * mock that persists composer content ACROSS two separate invocations — exactly
 * like two separate `node poke-pane.cjs` processes hitting the same real pane.
 * AC2: the FAIL(9) run cleans its own residue and VERIFIES composerContent()==''
 *      before exiting; the message says so (or says it could not verify).
 * AC3: cleanup never touches text this run cannot prove it wrote (T-0242/T-0323).
 *      Two sides: (a) foreign text present before any write this run made — die
 *      10, zero writes; (b) even INSIDE the FAIL(9) branch, if what's showing is
 *      not a fragment of the payload THIS run just sent, it is left untouched.
 * AC4: neither exit path claims "a key from the operator unblocks it" anymore.
 * AC5: a measured, explicit payload ceiling (src/poke-payload-ceiling.cjs) warns
 *      and refuses to try instead of attempting a send likely to break, with an
 *      --allow-long escape (mirrors a2a_send's allow_long).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const POKE = path.join(__dirname, '..', 'scripts', 'poke-pane.cjs');
const SOURCE = fs.readFileSync(POKE, 'utf8').replace(/^#![^\n]*\n/, '');
const { pokeCeilingWarning, POKE_PAYLOAD_CEILING, MEASURED_20260915 } = require('../src/poke-payload-ceiling.cjs');

const PAYLOAD = '[A2A from pane-2 to pane-33 | corr=T-0473 | type=request] Revisa el composer y confirma que se autolimpia solo.';

// ---------------------------------------------------------------- stateful pane mock
// `state.composer` is the ONE thing that persists across separate runPoke() calls —
// it models the real pane's live composer line, unaffected by our test process
// boundary, exactly as it would be unaffected by poke-pane running as a fresh CLI
// process each time in production.
function makeState(initialComposer = '') {
  return { composer: initialComposer, writes: [], pasteLanding: undefined, ctrlCFails: false };
}

function childProcessFor(state) {
  return {
    execFileSync: (file, args, options) => {
      assert.equal(file, 'fixture-wezterm');
      if (args.includes('list')) {
        return JSON.stringify([{ pane_id: 10, cwd: '/fixture/wabot', tab_title: 'wabot' }]);
      }
      if (args.includes('get-text')) {
        return state.composer ? `> ${state.composer}` : '> ';
      }
      if (args.includes('send-text')) {
        const input = options.input;
        state.writes.push({ args: [...args], input });
        if (args.includes('--no-paste')) {
          // control write: real Enter ('\r') or our new self-clean Ctrl+C ('\x03').
          if (input === '\r') state.composer = '';
          if (input === '\x03' && !state.ctrlCFails) state.composer = '';
        } else {
          // bracketed paste of the actual payload — `pasteLanding`, when set, models
          // what a FRAGMENTED/mis-rendered landing shows instead of the clean input.
          state.composer = state.pasteLanding !== undefined ? state.pasteLanding : input;
        }
        return '';
      }
      throw new Error(`unexpected terminal operation: ${args}`);
    },
  };
}

function runPoke(state, { project = 'wabot', text = PAYLOAD, extraArgv = [] } = {}) {
  const logs = [];
  const module = { exports: {} };
  const localRequire = createRequire(POKE);
  const fakeRequire = (name) => {
    if (name === '../src/action-log.cjs') return { logAction: () => true };
    if (name === 'fs') return { ...fs, readdirSync: () => [] };
    if (name === 'child_process') return childProcessFor(state);
    return localRequire(name);
  };
  fakeRequire.main = module;
  const proc = {
    platform: 'linux',
    env: { WEZTERM_BIN: 'fixture-wezterm' },
    argv: ['node', POKE, '--project', project, '--text', text, ...extraArgv],
    exit: (status) => { throw Object.assign(new Error('fixture process exit'), { status }); },
  };
  const run = vm.runInNewContext(
    `(function(require, module, __dirname) {\n${SOURCE}\n})`,
    { process: proc, console: { log: (t) => logs.push(t) }, Atomics: { wait: () => 0 } },
    { filename: POKE },
  );
  let status = 0;
  try { run(fakeRequire, module, path.dirname(POKE)); }
  catch (e) { if (e.status === undefined) throw e; status = e.status; }
  return { status, logs: logs.join('\n'), writes: state.writes };
}

// ---------------------------------------------------------------- AC1 + AC2: self-unstick
test('AC1+AC2 fail-first: run 1 hits a fragmented paste (FAIL 9), self-cleans its OWN residue and verifies composerContent()==\'\'; run 2 on the SAME pane delivers (not exit 10)', () => {
  const state = makeState('');
  // Run 1: the paste lands as a FRAGMENT of the payload (not the head) — this is
  // what "fragmented" looks like on the wire; it is provably OUR OWN text because
  // the composer was confirmed empty immediately before this run's own paste.
  state.pasteLanding = PAYLOAD.slice(-40);
  const run1 = runPoke(state);
  assert.equal(run1.status, 9, `run 1 should FAIL(9) on the fragmented landing, got ${run1.status}: ${run1.logs}`);
  assert.match(run1.logs, /residue self-cleared \(Ctrl\+C\) and verified empty/, 'AC2: the FAIL(9) message must say it self-cleaned and verified empty');
  assert.doesNotMatch(run1.logs, /a key from the operator unblocks it/, 'AC4: no more claiming an operator key is needed');
  const ctrlC = run1.writes.filter((w) => w.input === '\x03');
  assert.equal(ctrlC.length, 1, 'exactly one Ctrl+C write, not an Enter (an Enter is what fragments/hybridises)');
  assert.equal(state.composer, '', 'the real pane composer is left empty after run 1');

  // Run 2: a SEPARATE poke-pane invocation against the SAME pane. Before the fix,
  // run 1's own residue would still be sitting there and this run would die 10.
  state.writes = [];
  state.pasteLanding = undefined; // this time the paste lands intact
  const run2 = runPoke(state);
  assert.notEqual(run2.status, 10, `run 2 must not be locked out by run 1's residue: ${run2.logs}`);
  assert.equal(run2.status, 0, `run 2 should deliver cleanly: ${run2.logs}`);
  assert.match(run2.logs, /poke-pane OK:.*VERIFIED/, 'run 2 reaches a real VERIFIED delivery');
});

test('AC2 control: when the self-clean Ctrl+C cannot be verified empty, the message says so and the exit code is unchanged (still 9)', () => {
  const state = makeState('');
  state.pasteLanding = PAYLOAD.slice(-40);
  state.ctrlCFails = true; // simulate a pane where Ctrl+C did not visibly clear the line
  const run1 = runPoke(state);
  assert.equal(run1.status, 9, 'exit code is the SAME 9 as today, not a new code');
  assert.match(run1.logs, /self-clean attempted \(Ctrl\+C\) but could not be verified empty/);
  assert.doesNotMatch(run1.logs, /verified empty; no operator action needed/);
});

// ---------------------------------------------------------------- AC3: never clean what we can't prove we wrote
test('AC3 side A: FOREIGN text already in the composer before this run wrote anything still dies exit 10, zero writes', () => {
  const state = makeState('la verdad me mata tener 2 dashboards, decime cual dejamos');
  const result = runPoke(state);
  assert.equal(result.status, 10);
  assert.deepEqual(result.writes, [], 'neither paste nor any control key may reach the terminal');
  assert.match(result.logs, /composer already holds unsent text/);
  assert.doesNotMatch(result.logs, /a key from the operator unblocks it/, 'AC4: exit 10 stops claiming this too');
});

test('AC3 side B: inside the FAIL(9) branch, a fragment that is NOT provably this run\'s own payload is left untouched (no Ctrl+C sent)', () => {
  const state = makeState('');
  // What lands after the paste is unrelated text, not a fragment of PAYLOAD —
  // e.g. a race where something else painted the composer at the wrong instant.
  state.pasteLanding = 'un mensaje sin relacion con el payload de esta corrida';
  const run1 = runPoke(state);
  assert.equal(run1.status, 9);
  assert.match(run1.logs, /residue left untouched: not provably this run's own payload/);
  const ctrlC = run1.writes.filter((w) => w.input === '\x03');
  assert.equal(ctrlC.length, 0, 'no self-clean attempt when ownership cannot be proven');
});

// ---------------------------------------------------------------- AC4: grep the source
test('AC4 grep: zero occurrences of the false "a key from the operator unblocks it" claim anywhere in poke-pane.cjs', () => {
  assert.doesNotMatch(SOURCE, /a key from the operator unblocks it/);
});

// ---------------------------------------------------------------- AC5: measured payload ceiling
test('AC5 pure: the measured 15/09 datapoints show length alone does not predict the outcome (documented, not pretended otherwise)', () => {
  const byChars = Object.fromEntries(MEASURED_20260915.map((d) => [d.chars, d.result]));
  assert.equal(byChars[433], 'ok');
  assert.equal(byChars[1386], 'head lost');
  assert.equal(byChars[3733], 'ok');
  assert.ok(1386 < 3733, 'the failure sits BELOW a payload that later succeeded — non-monotonic on purpose');
  // The ceiling correctly would have flagged the real failure (1386 > ceiling)...
  assert.ok(pokeCeilingWarning(1386, false) !== null, '1386 (the actual failure) is inside the warn zone');
  // ...but it ALSO flags 3733, which actually succeeded: the ceiling is a risk
  // zone, not a predictor, and this test is what keeps that claim honest.
  assert.ok(pokeCeilingWarning(3733, false) !== null, '3733 (an actual success) also falls in the warn zone — documented limitation');
  assert.equal(pokeCeilingWarning(433, false), null, '433 (an actual success, well under ceiling) does not warn');
});

test('AC5 end-to-end: a payload over the ceiling WARNS and refuses to try — zero terminal writes', () => {
  const state = makeState('');
  const longText = 'x'.repeat(POKE_PAYLOAD_CEILING + 200);
  const result = runPoke(state, { text: longText });
  assert.equal(result.status, 13);
  assert.deepEqual(result.writes, [], 'nothing is attempted once the ceiling refuses');
  assert.match(result.logs, /WARN:/);
  assert.match(result.logs, /--allow-long/);
});

test('AC5 escape hatch: --allow-long proceeds past the ceiling (caller\'s own risk, same contract as a2a_send allow_long)', () => {
  const state = makeState('');
  const longText = 'x'.repeat(POKE_PAYLOAD_CEILING + 200);
  const result = runPoke(state, { text: longText, extraArgv: ['--allow-long'] });
  assert.notEqual(result.status, 13);
  assert.ok(result.writes.length >= 1, '--allow-long lets the paste attempt actually happen');
});
