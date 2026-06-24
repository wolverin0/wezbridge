'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG = path.resolve(__dirname, '..', 'vault', '_wezbridge', 'project-status.jsonl');

function recordProjectStatus(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.project) return false;
  const logPath = opts.logPath || DEFAULT_LOG;
  const payload = {
    recorded_at: opts.now || new Date().toISOString(),
    ...entry,
  };
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
  return true;
}

function readProjectStatuses(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG;
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function latestByProject(opts = {}) {
  const latest = new Map();
  for (const entry of readProjectStatuses(opts)) {
    if (!entry.project) continue;
    latest.set(entry.project, entry);
  }
  return Object.fromEntries(latest.entries());
}

module.exports = {
  DEFAULT_LOG,
  latestByProject,
  readProjectStatuses,
  recordProjectStatus,
};
