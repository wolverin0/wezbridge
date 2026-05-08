'use strict';
/**
 * memory-inbox.cjs — Local "Dreams" backfill (Task #7).
 *
 * Append-only JSONL inbox at vault/_memorymaster/inbox.jsonl. Tracks the
 * non-obvious, useful-for-future-sessions signals: safety blocks,
 * destructive command attempts, failed grader verdicts. Stays small
 * by design — gated by WEZBRIDGE_MM_INBOX=1 so the firehose stays off
 * in normal operation.
 *
 * Future use: a periodic compactor pulls from this inbox into
 * MemoryMaster claims (the "Dreams" cycle). For now we just persist
 * the raw events; promotion is human-curated.
 *
 * API:
 *   record({ source, kind, ...payload })   — append one line, no-op if
 *     env gate disabled. Best-effort: file errors are swallowed.
 *   readEvents()                           — read all, skip malformed
 *   isEnabled()                            — env gate check
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG = path.resolve(__dirname, '..', 'vault', '_memorymaster', 'inbox.jsonl');
const ENV_GATE = 'WEZBRIDGE_MM_INBOX';

function isEnabled() {
  return process.env[ENV_GATE] === '1';
}

function _ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Append one event. No-op if env gate is off. Returns true if written,
 * false if gated or input invalid.
 */
function record(event, opts = {}) {
  if (!opts.force && !isEnabled()) return false;
  if (!event || typeof event !== 'object' || !event.source) return false;
  const logPath = opts.logPath || DEFAULT_LOG;
  try {
    _ensureDir(logPath);
    const line = JSON.stringify({ ts: event.ts || new Date().toISOString(), ...event });
    fs.appendFileSync(logPath, line + '\n', 'utf8');
    return true;
  } catch (e) {
    if (typeof opts.log === 'function') opts.log(`memory-inbox record failed: ${e.message}`);
    return false;
  }
}

/** Read all events. Skip malformed lines. Returns [] if file absent. */
function readEvents(opts = {}) {
  const logPath = opts.logPath || DEFAULT_LOG;
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

module.exports = {
  DEFAULT_LOG,
  ENV_GATE,
  isEnabled,
  record,
  readEvents,
};
