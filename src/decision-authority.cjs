'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { latestRulingWhere } = require('./rulings.cjs');

/** Re-read authority immediately before transport; append order is canonical. */
function decisionDisposition({ intel, task, ruling, at, why, source, card, allowDuplicate = false }) {
  try {
    const currentCard = card || JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${task}.json`), 'utf8'));
    if (ruling === 'approved' && ['cancelled', 'done'].includes(currentCard.state)) {
      return { status: 'superseded', reason: `card-${currentCard.state}` };
    }
    const rows = fs.readFileSync(path.join(intel, 'rulings.jsonl'), 'utf8').replace(/^\uFEFF/, '')
      .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const latest = latestRulingWhere(rows, task, r => ['approved', 'cancelled'].includes(r.ruling));
    if (!latest || !Number.isFinite(Date.parse(latest.at))) return { status: 'unknown', reason: 'no-valid-current-ruling' };
    if (ruling !== latest.ruling) return { status: 'superseded', reason: `replaced-by-${latest.ruling}` };
    if (!at) return { status: 'unknown', reason: 'missing-decision-provenance' };
    const duplicate = allowDuplicate && why === latest.why && source === latest.source
      && Math.abs(Date.parse(at) - Date.parse(latest.at)) < 120000;
    if (at !== latest.at && !duplicate) return { status: 'superseded', reason: 'replaced-by-newer-ruling' };
    return { status: 'allow', latest };
  } catch (error) { return { status: 'unknown', reason: `authority-unreadable: ${error.code || error.name}` }; }
}

/** Legacy decision bodies are recognized even if producer metadata is missing. */
function queuedDecision(entry) {
  const head = String(entry.body || '').match(/^\[decision\] operator (approved|cancelled) (T-\d{4}):/);
  if (entry.from_project !== 'decision-relay' && !head) return null;
  if (!head || (entry.ruling && head[1] !== entry.ruling) || head[2] !== entry.corr) {
    return { invalid: true };
  }
  return { task: entry.corr, ruling: head[1], at: entry.decision_at };
}

module.exports = { decisionDisposition, queuedDecision };
