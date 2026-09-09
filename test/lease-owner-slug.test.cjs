'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileLeases } = require('../scripts/lease-reconcile.cjs');
const { reconciliationReport } = require('../scripts/lease-reconcile-cli.cjs');
const projects = { wezbridge: { path: 'wezbridge' }, CRM: { path: 'crm' } };
const task = { id: 'T-0417', repo: 'wezbridge', state: 'running',
  lease: { owner: 'wezbridge', expires_at: '2099-01-01T00:00:00Z' } };

test('T0417 AC1 declared slug with matching live cwd has zero findings', () => {
  assert.deepEqual(reconcileLeases([task], [{ pane_id: 94, cwd: 'file:///G:/Py%20Apps/wezbridge/' }],
    Date.now(), { projects }), []);
});

test('T0417 alias resolves registry path; unknown and unreadable registry are not green', () => {
  const alias = { ...task, lease: { ...task.lease, owner: 'CRM' } };
  assert.deepEqual(reconcileLeases([alias], [{ pane_id: 12, cwd: 'G:/Apps/crm' }], Date.now(), { projects }), []);
  assert.equal(reconcileLeases([task], [], Date.now(), { projects: null })[0].category, 'lease-owner-unverifiable');
  assert.match(reconcileLeases([{ ...task, lease: { owner: 'invented' } }], [], Date.now(), { projects })[0].why, /ilegible/);
});

test('T0417 missing and partial census do not create a healthy slug', () => {
  assert.equal(reconcileLeases([task], null, Date.now(), { projects })[0].category, 'lease-census-unavailable');
  assert.equal(reconcileLeases([task], [{ pane_id: 94, cwd: '' }], Date.now(), { projects })[0].category, 'lease-owner-unverifiable');
});

test('T0417 other executor is parsed but never verified by Eve callback', () => {
  const other = { ...task, lease: { owner: 'codex:run_01' } };
  const result = reconcileLeases([other], null, Date.now(), { projects, executorLiveness: () => assert.fail('not Eve') });
  assert.equal(result[0].category, 'lease-owner-unverifiable');
  assert.doesNotMatch(result[0].why, /ilegible/);
});

test('T0417 AC4 counts distinguish healthy, dead and unavailable measurements', () => {
  const dead = { ...task, id: 'T-9999', lease: { owner: 'CRM' } };
  const report = reconciliationReport([task, dead], [{ pane_id: 94, cwd: 'G:/Apps/wezbridge' }], { projects });
  assert.deepEqual(report.counts, { open_leases: 2, verified: 1, unverified: 1 });
  assert.deepEqual(reconciliationReport([task], null, { projects }).counts, { open_leases: 1, verified: 0, unverified: 1 });
  assert.equal(reconciliationReport([], null, { projects }).census_available, false);
});

test('T0417 AC2 declared slug without live cwd is not healthy or illegible', () => {
  const findings = reconcileLeases([task], [{ pane_id: 94, cwd: 'G:/Py Apps/other' }], Date.now(), { projects });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'dead-owner-lease');
  assert.match(findings[0].why, /sin pane vivo/);
  assert.doesNotMatch(findings[0].why, /ilegible/);
});
