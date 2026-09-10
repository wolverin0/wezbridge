'use strict';
// Read-only evidence over real snapshots; never drain or replay their envelopes.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { summarizePending, INBOX_STALE_MS } = require('../src/inbox-health.cjs');
const now = Date.now();
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/inbox-starvation-measure.cjs <pending.json> [...]');
const measurements = files.map(file => {
  const bytes = fs.readFileSync(file);
  const pending = JSON.parse(bytes);
  const entries = Object.entries(pending).map(([id, entry]) => ({ id, corr: entry.corr,
    attempts: entry.attempts, age_minutes: Math.floor((now - Date.parse(entry.time)) / 60000),
    alerted: summarizePending({ [id]: entry }, now).count === 1,
  }));
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    unchanged: bytes.equals(fs.readFileSync(file)), ...summarizePending(pending, now), entries };
});
console.log(JSON.stringify({ measured_at: new Date(now).toISOString(), mode: 'read-only; alert classification, not delivery',
  threshold_ms: INBOX_STALE_MS, measurements }, null, 2));
