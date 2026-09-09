'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { reconcileLeases, liveCensus, loadProjects } = require('./lease-reconcile.cjs');

function reconciliationReport(tasks, census, opts = {}) {
  const now = opts.now || Date.now();
  const open = tasks.filter(t => t?.lease?.owner && !['done', 'cancelled'].includes(t.state));
  const findings = reconcileLeases(tasks, census, now, opts);
  const unavailable = findings.some(f => f.category === 'lease-census-unavailable');
  const leases = open.map(t => {
    const finding = findings.find(f => f.id === t.id);
    return { id: t.id, repo: t.repo, owner: t.lease.owner,
      verified: !unavailable && !finding,
      reason: finding?.why || (unavailable ? 'censo no disponible' : 'owner vivo reconciliado') };
  });
  const verified = leases.filter(t => t.verified).length;
  return { at: new Date(now).toISOString(), census_available: Array.isArray(census),
    census_panes: Array.isArray(census) ? census.length : null,
    counts: { open_leases: open.length, verified, unverified: open.length - verified }, leases, findings };
}

function readTasks(dir) {
  const tasks = []; const errors = [];
  for (const file of fs.readdirSync(path.join(dir, 'tasks')).filter(name => /^T-\d+\.json$/.test(name))) {
    try { tasks.push(JSON.parse(fs.readFileSync(path.join(dir, 'tasks', file), 'utf8'))); }
    catch (error) { errors.push({ file, error: error.message }); }
  }
  return { tasks, errors };
}

function run() {
  try {
    const dir = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '../..', '_intel');
    const { tasks, errors } = readTasks(dir);
    const census = liveCensus();
    const projects = loadProjects(dir);
    const report = { ...reconciliationReport(tasks, census, { projects }),
      registry_available: projects !== null, task_files_read: tasks.length, task_read_errors: errors, census };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = errors.length || report.counts.unverified || projects === null || !Array.isArray(census) ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, counts: null, census_available: false }));
    process.exitCode = 1;
  }
}

module.exports = { run, readTasks, reconciliationReport };
