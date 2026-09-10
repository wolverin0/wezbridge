'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { intelDir } = require('./a2a-intel.cjs');
const INBOX_STALE_MS = 30 * 60 * 1000;

function summarizePending(pending, now) {
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('invalid pending object');
  const ages = Object.values(pending)
    .filter(entry => entry && entry.attempts === 0)
    .map(entry => now - Date.parse(entry.time))
    .filter(age => Number.isFinite(age) && age > INBOX_STALE_MS);
  return { count: ages.length, oldest_age_ms: ages.reduce((oldest, age) => Math.max(oldest, age), 0) };
}

/** Read-only diagnostics: never instantiate a consumer or mutate its durable state. */
function inspectInboxStarvation({ base = intelDir(), now = Date.now() } = {}) {
  const root = path.join(base, 'queues', 'state');
  let directories;
  try { directories = fs.readdirSync(root, { withFileTypes: true }).filter(dir => dir.isDirectory()); }
  catch (err) {
    return { count: 0, oldest_age_ms: 0, projects: [], alerts: err.code === 'ENOENT' ? [] : ['INBOX NO EVALUABLE: cannot read queue state'] };
  }
  const projects = [];
  const errors = [];
  for (const dir of directories) {
    try {
      const pending = JSON.parse(fs.readFileSync(path.join(root, dir.name, 'pending.json'), 'utf8'));
      const summary = summarizePending(pending, now);
      if (summary.count) projects.push({ project: dir.name, ...summary });
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`INBOX NO EVALUABLE: ${dir.name} pending state unreadable`);
    }
  }
  const count = projects.reduce((total, project) => total + project.count, 0);
  const oldest = projects.reduce((age, project) => Math.max(age, project.oldest_age_ms), 0);
  const alerts = projects.map(project => `INBOX ESTANCADA: ${project.project}: ${project.count} sobres sin intento; mas viejo ${Math.floor(project.oldest_age_ms / 60000)} min (>30 min)`);
  return { count, oldest_age_ms: oldest, threshold_ms: INBOX_STALE_MS, projects, alerts: [...alerts, ...errors] };
}

module.exports = { INBOX_STALE_MS, summarizePending, inspectInboxStarvation };
