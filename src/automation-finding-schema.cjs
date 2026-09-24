'use strict';
/**
 * automation-finding-schema.cjs — T-0598 Fase A. The one JSON shape every
 * scheduled automation (PC Task Scheduler, VM crons, Hermes, pane crons)
 * MUST emit when it finds something actionable, so `scripts/automation-router.cjs`
 * can turn it into a ledger card without per-automation glue code.
 * Key terms: validateFinding, computeFingerprint, normalizeSummary, SEVERITIES.
 * Read when: an automation needs to emit a finding, or the router needs to
 * validate/quarantine one.
 *
 * Shape:
 *   { task: string, repo_owner: string, actionable: boolean, summary: string,
 *     evidence: string, severity: 'low'|'medium'|'high'|'critical',
 *     fingerprint?: string, kind?: string }
 *
 * Fingerprint rule (T-0598): if `fingerprint` is present, use it verbatim —
 * the emitting automation knows its own identity best (e.g. a UISP service id).
 * Otherwise derive one from `task` + a normalized `summary` so the SAME finding
 * re-emitted by a flaky automation still dedupes: sha256(`${task}|${normalize(summary)}`)
 * truncated to 16 hex chars (enough entropy for one automation's finding stream,
 * short enough to read in a corr id).
 */
const crypto = require('node:crypto');

const SEVERITIES = ['low', 'medium', 'high', 'critical'];

function normalizeSummary(summary) {
  return String(summary).trim().toLowerCase().replace(/\s+/g, ' ');
}

function computeFingerprint(finding) {
  if (finding.fingerprint && String(finding.fingerprint).trim()) {
    return String(finding.fingerprint).trim();
  }
  const basis = `${finding.task}|${normalizeSummary(finding.summary)}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/**
 * Returns { ok: true, finding } or { ok: false, errors: string[] }.
 * Never throws — the router's job is to quarantine bad input, not crash.
 */
function validateFinding(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['finding must be a JSON object'] };
  }
  if (!raw.task || typeof raw.task !== 'string') errors.push('task must be a non-empty string');
  if (!raw.repo_owner || typeof raw.repo_owner !== 'string') errors.push('repo_owner must be a non-empty string');
  if (typeof raw.actionable !== 'boolean') errors.push('actionable must be a boolean');
  if (!raw.summary || typeof raw.summary !== 'string') errors.push('summary must be a non-empty string');
  if (!raw.evidence || typeof raw.evidence !== 'string') errors.push('evidence must be a non-empty string');
  if (!SEVERITIES.includes(raw.severity)) errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (raw.fingerprint !== undefined && typeof raw.fingerprint !== 'string') errors.push('fingerprint must be a string when present');
  if (raw.kind !== undefined && typeof raw.kind !== 'string') errors.push('kind must be a string when present');
  if (errors.length) return { ok: false, errors };
  return { ok: true, finding: raw };
}

module.exports = { SEVERITIES, validateFinding, computeFingerprint, normalizeSummary };
