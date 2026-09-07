'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Existing routine reader owns interpretation; preserve errors across clean ticks. */
function recordRun(intel, output, exitStatus) {
  const dir = path.join(intel, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = exitStatus === 0 ? 'latest' : `${Date.now()}-${process.pid}`;
  const base = `decision-relay-wezbridge-${suffix}`;
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
  write(`run-${base}.json`, { routine: 'decision-relay', repo: 'wezbridge',
    cadence_hours: 5 / 60, exit_status: exitStatus, findings_file: findings });
  return report;
}

module.exports = { recordRun };
