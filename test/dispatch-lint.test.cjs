'use strict';
/**
 * Tests for dispatch-lint.cjs (W1 dispatch-unspecced, W2 ruling-unlanded).
 *
 * Two properties matter, in tension:
 *  - the seeded violation MUST fire (mutation anchor: disabling the lint, or
 *    unwiring it from fleet-steward's audit(), turns these red), and
 *  - compliant behaviour MUST stay silent (anti-wolf: an enforcement artifact
 *    that fires on a specced dispatch or an ordinary ruling trains everyone to
 *    appease it, which is worse than not having it).
 * The integration tests go through audit() ON PURPOSE: a pure lint that passes
 * its own tests while never being called is exactly the silent failure the
 * abandoned-lease `lease.until` bug already demonstrated in this repo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lintSpecRefs, lintRulings, LINT_EPOCH_MS } = require('../scripts/dispatch-lint.cjs');
const { audit } = require('../scripts/fleet-steward.cjs');
const { evaluate, DEADLINES } = require('../scripts/steward-gate.cjs');

const NOW = Date.parse('2026-08-18T12:00:00Z');
const H = (n) => n * 3600000;
const iso = (ms) => new Date(ms).toISOString();

const uiTask = (over = {}) => ({
  id: 'T-9001', repo: 'demo', state: 'ready', kind: 'general',
  title: 'Rebuild the admin dashboard UI as a cockpit',
  context_refs: [], lease: null,
  created_at: iso(NOW - H(2)), updated_at: iso(NOW - H(2)),
  ...over,
});

const ruling = (over = {}) => ({
  task: 'T-9002', category: 'routine-findings', ruling: 'dispatched',
  why: 'raised the dwell threshold from 120s to 1800s for the pilot',
  at: iso(NOW - H(1)),
  ...over,
});

// ---------------------------------------------------------------------------
// W1 dispatch-unspecced — must fire
// ---------------------------------------------------------------------------

test('an open post-epoch UI task with no spec reference fires', () => {
  const out = lintSpecRefs([uiTask()], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'dispatch-unspecced');
  assert.equal(out[0].id, 'T-9001');
});

test('service work fires the same way', () => {
  const out = lintSpecRefs([uiTask({ title: 'Ship the roadmap watcher as a daemon' })], NOW);
  assert.equal(out.length, 1);
});

test('age counts from creation, so the deadline can actually pass', () => {
  const out = lintSpecRefs([uiTask({ created_at: iso(NOW - H(50)), updated_at: iso(NOW) })], NOW);
  assert.equal(out[0].age_hours, 50);
});

// ---------------------------------------------------------------------------
// W1 — must stay silent (anti-wolf)
// ---------------------------------------------------------------------------

test('a spec reference in context_refs silences it', () => {
  const specced = uiTask({ context_refs: ['wezbridge/.orchestrator/FLEET-BOARD-APP-SPEC.md (read FIRST)'] });
  assert.equal(lintSpecRefs([specced], NOW).length, 0);
});

test('a template reference in context_refs silences it', () => {
  const specced = uiTask({ context_refs: ['_intel/templates/ui-work.md'] });
  assert.equal(lintSpecRefs([specced], NOW).length, 0);
});

test('pre-epoch tasks are never retro-flagged', () => {
  const old = uiTask({ created_at: '2026-08-01T00:00:00Z' });
  assert.equal(lintSpecRefs([old], NOW).length, 0);
});

test('non-UI, non-service work is out of scope', () => {
  const out = lintSpecRefs([uiTask({ title: 'graphify-regen for mzcopilot', kind: 'graphify-regen' })], NOW);
  assert.equal(out.length, 0);
});

test('closed and gated states are out of scope', () => {
  for (const state of ['done', 'cancelled', 'blocked', 'review', 'failed']) {
    assert.equal(lintSpecRefs([uiTask({ state })], NOW).length, 0, state);
  }
});

// ---------------------------------------------------------------------------
// W2 ruling-unlanded — must fire
// ---------------------------------------------------------------------------

test('a value-change ruling with no value_landed_in and no path fires', () => {
  const out = lintRulings([ruling()], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'ruling-unlanded');
  assert.equal(out[0].id, 'RL-unlanded-T-9002');
});

test('enable/disable wording counts as a value change', () => {
  const out = lintRulings([ruling({ why: 'disabled the kitchen watcher until the camera is mounted' })], NOW);
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------------------
// W2 — must stay silent (anti-wolf)
// ---------------------------------------------------------------------------

test('value_landed_in silences it', () => {
  const landed = ruling({ value_landed_in: 'yolo26/config/pilot.env' });
  assert.equal(lintRulings([landed], NOW).length, 0);
});

test('a file path inside why also counts as landed', () => {
  const landed = ruling({ why: 'raised the dwell threshold to 1800s in pilot.env' });
  assert.equal(lintRulings([landed], NOW).length, 0);
});

test('an ordinary dispatch ruling does NOT fire', () => {
  const plain = ruling({ why: 'dispatched to pane-47 with acceptance criteria; builder owns board-app' });
  assert.equal(lintRulings([plain], NOW).length, 0);
});

test('an ordinary deferral does NOT fire', () => {
  const plain = ruling({ ruling: 'deferred', why: 'parked until the operator returns from travel', until: iso(NOW + H(72)) });
  assert.equal(lintRulings([plain], NOW).length, 0);
});

test('pre-epoch rulings are never retro-flagged', () => {
  assert.equal(lintRulings([ruling({ at: '2026-08-10T00:00:00Z' })], NOW).length, 0);
});

test('latest ruling wins: a corrected re-append clears the finding', () => {
  const bad = ruling({ at: iso(NOW - H(3)) });
  const fix = ruling({ at: iso(NOW - H(1)), value_landed_in: 'yolo26/config/pilot.env' });
  assert.equal(lintRulings([bad, fix], NOW).length, 0);
  // and the reverse order in the file changes nothing — `at` decides
  assert.equal(lintRulings([fix, bad], NOW).length, 0);
});

// ---------------------------------------------------------------------------
// Wiring: the lints reach the gate through audit(), not just their own module
// ---------------------------------------------------------------------------

test('audit() carries both lint categories end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lint-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'rulings.jsonl'), JSON.stringify(ruling()) + '\n');
  const report = audit([uiTask()], NOW, dir);
  assert.equal(report.byCategory['dispatch-unspecced'], 1);
  assert.equal(report.byCategory['ruling-unlanded'], 1);
});

test('the gate actually gates them: past deadline with no ruling is RED', () => {
  assert.ok(Number.isFinite(DEADLINES['dispatch-unspecced']));
  assert.ok(Number.isFinite(DEADLINES['ruling-unlanded']));
  const findings = [
    { id: 'T-9001', category: 'dispatch-unspecced', age_hours: DEADLINES['dispatch-unspecced'] + 1 },
    { id: 'RL-unlanded-T-9002', category: 'ruling-unlanded', age_hours: DEADLINES['ruling-unlanded'] + 1 },
  ];
  const { verdict, unruled } = evaluate({ findings, rulings: [], now: NOW });
  assert.equal(verdict, 'RED');
  assert.equal(unruled.length, 2);
});

test('epoch constant guards the backlog: it is on/after the retro date', () => {
  assert.ok(LINT_EPOCH_MS >= Date.parse('2026-08-16T00:00:00Z'));
});
