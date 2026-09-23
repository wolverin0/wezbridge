'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Existing routine reader owns interpretation; preserve errors across clean ticks. */
function recordRun(intel, output, exitStatus, { routine = 'decision-relay', cadenceHours = 5 / 60 } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(routine)) throw new Error('invalid routine name');
  if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) throw new Error('invalid routine cadence');
  const dir = path.join(intel, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = exitStatus === 0 ? 'latest' : `${Date.now()}-${process.pid}`;
  const base = `${routine}-wezbridge-${suffix}`;
  const findings = `${base}.json`;
  const report = { ...output, exit_status: exitStatus,
    verdict: exitStatus === 0 ? 'clean' : 'void' };
  const write = (file, value) => {
    const target = path.join(dir, file);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, target);
  };
  write(findings, report);
  write(`run-${base}.json`, { routine, repo: 'wezbridge',
    cadence_hours: cadenceHours, exit_status: exitStatus, findings_file: findings });
  return report;
}

module.exports = { recordRun };
