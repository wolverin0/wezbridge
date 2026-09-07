'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { auditRoutines } = require('../scripts/routine-audit.cjs');
const NOW = Date.parse('2026-09-06T20:00:00Z');
const HOUR = 3600000;

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0327-routine-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'routines'));
  fs.mkdirSync(path.join(dir, 'routine-findings'));
  const registration = { routine: 'bot-roster', repo: 'wezbridge', cadence_hours: 24,
    registered_at: new Date(NOW - 72 * HOUR).toISOString(), last_task_result: 0, ...overrides };
  fs.writeFileSync(path.join(dir, 'routines/bot-roster.json'), JSON.stringify(registration));
  return dir;
}

function cleanRun(dir, hoursAgo, repo = 'wezbridge') {
  const run = path.join(dir, 'routine-findings/run-bot-roster.json');
  fs.writeFileSync(run, JSON.stringify({ routine: 'bot-roster', repo, exit_status: 0,
    cadence_hours: 24, findings_file: 'clean.json' }));
  fs.writeFileSync(path.join(dir, 'routine-findings/clean.json'), '{"verdict":"clean"}');
  fs.utimesSync(run, new Date(NOW - hoursAgo * HOUR), new Date(NOW - hoursAgo * HOUR));
}

test('T-0327 AC4 killer: registered bot with scheduler exit zero but no run is routine-void in steward', t => {
  const dir = fixture(t);
  const report = require('../scripts/fleet-steward.cjs').audit([], NOW, dir);
  const missing = report.findings.find(f => f.category === 'routine-void');
  assert.ok(missing, 'registration must arm the audit before the first output exists');
  assert.match(missing.why, /run-\*\.json/);
});

test('T-0327 AC4 control: clean run inside the cadence window suppresses missing-run finding', t => {
  const dir = fixture(t); cleanRun(dir, 2);
  assert.deepEqual(auditRoutines(dir, NOW), []);
});

for (const [hours, repo] of [[25, 'wezbridge'], [-1, 'wezbridge'], [2, 'other']]) {
  test(`T-0327 AC4: out-of-window or foreign evidence cannot satisfy registration (${hours}, ${repo})`, t => {
    const dir = fixture(t); cleanRun(dir, hours, repo);
    assert.ok(auditRoutines(dir, NOW).some(f => f.category === 'routine-void' && f.repo === 'wezbridge'));
  });
}

test('T-0327 AC4 control: disabled and not-yet-due registrations do not raise', t => {
  assert.deepEqual(auditRoutines(fixture(t, { enabled: false }), NOW), []);
  assert.deepEqual(auditRoutines(fixture(t, { registered_at: new Date(NOW - HOUR).toISOString() }), NOW), []);
});

test('T-0327 AC4: hidden-tasks bot registry is audited, ordinary tasks are not routines', t => {
  const dir = fixture(t, { enabled: false });
  fs.writeFileSync(path.join(dir, 'hidden-tasks.json'), JSON.stringify({ tasks: [
    { id: 'periodic-bot', bot: true, repo: 'wezbridge', cadence_hours: 24,
      registered_at: new Date(NOW - 72 * HOUR).toISOString(), last_task_result: 0 },
    { id: 'ordinary-task', repo: 'wezbridge', cadence_hours: 24 },
  ] }));
  const findings = auditRoutines(dir, NOW);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /periodic-bot/);
});

test('T-0327 AC4: existing Spanish routine document is a registration, exclusion config is not', t => {
  const dir = fixture(t, { enabled: false });
  const file = path.join(dir, 'routines/mail.md');
  fs.writeFileSync(file, '# Rutina: mail (T-0010)\n**Cadencia:** diaria 08:30 ART · **Host:** pane hub (wezbridge)\n');
  fs.utimesSync(file, new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
  fs.writeFileSync(path.join(dir, 'routines/exclusions.json'), '{"senders":[]}');
  const findings = auditRoutines(dir, NOW);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'routine-void');
  assert.match(findings[0].title, /mail/);
});

test('T-0327 review killer: malformed registration is a local void while other routines remain audited', t => {
  const dir = fixture(t); cleanRun(dir, 2);
  const broken = path.join(dir, 'routines/broken-bot.json');
  fs.writeFileSync(broken, '{"routine":');
  fs.utimesSync(broken, new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
  const result = require('../scripts/fleet-steward.cjs').audit([], NOW, dir).findings;
  assert.equal(result.length, 1);
  assert.equal(result[0].category, 'routine-void');
  assert.match(result[0].why, /broken-bot\.json/);
  assert.ok(result[0].age_hours >= 48, 'a permanently broken definition must not reset its deadline every scan');
});
