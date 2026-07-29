'use strict';
/**
 * a2a-intel.cjs — deterministic A2A protocol enforcement + audit (control plane).
 * Every pane's MCP server writes to the SHARED _intel/ directory (Py Apps root),
 * so the fleet gets one audit stream and one thread-state view with no LLM
 * cooperation. All writes are fail-soft: enforcement must never break delivery.
 *
 *   events.jsonl      — append-only envelope audit (metadata only, never bodies)
 *   a2a-threads.json  — open-thread state: request opens corr, result awaits ack,
 *                       ack closes. Advisory (last-writer-wins on races).
 */
const fs = require('node:fs');
const path = require('node:path');

function intelDir() {
  const dir = process.env.WEZBRIDGE_INTEL_DIR
    || path.join(__dirname, '..', '..', '_intel');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fail-soft */ }
  return dir;
}

/**
 * Envelope v2 detection for type=result bodies.
 * Convention (docs/a2a-protocol.md): a v2 result contains a `criteria:` block
 * with per-criterion pass/fail. Detection is deliberately lenient — WARN-only
 * rollout; hard-reject is a later operator call.
 * Returns 'ok' | 'missing'.
 */
function detectV2(body) {
  const text = String(body);
  const hasCriteria = /^\s*(criteria|acceptance_criteria)\s*:/im.test(text);
  const hasVerdicts = /\b(pass(ed)?|fail(ed)?)\b/i.test(text);
  return hasCriteria && hasVerdicts ? 'ok' : 'missing';
}

/** Append one envelope-metadata event. Never throws. */
function recordEvent(evt) {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), event: 'a2a.sent', ...evt });
    fs.appendFileSync(path.join(intelDir(), 'events.jsonl'), line + '\n');
  } catch { /* fail-soft */ }
}

function readThreads(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { threads: {} }; }
}

function writeThreads(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* fail-soft */ }
}

/**
 * Update shared thread state for a sent envelope and return the sender's
 * outstanding obligations: corrs of results SENT TO this pane still awaiting
 * its ack (surfacing these in every a2a_send response kills re-send loops).
 * Never throws.
 */
function updateThreads({ fromPane, toPane, corr, type, body }) {
  const file = path.join(intelDir(), 'a2a-threads.json');
  const data = readThreads(file);
  const now = new Date().toISOString();
  const prev = data.threads[corr] || {};
  let next = data.threads;

  if (type === 'request') {
    next = { ...next, [corr]: { state: 'open', requester: fromPane, responder: toPane, opened_at: now, updated_at: now } };
  } else if (type === 'progress') {
    // Structured gate-state line (protocol addition 2026-07-27): a progress body
    // beginning "GATE:<kind>:<state>" declares an explicit gate — machine-readable,
    // replacing prose-keyword inference ("blocked from sending" et al).
    const gateMatch = /^GATE:([a-z-]+):([a-z-]+)(?:\s*[—-]\s*(.{0,120}))?/i.exec(String(body || '').trim());
    const gate = gateMatch
      ? { kind: gateMatch[1].toLowerCase(), state: gateMatch[2].toLowerCase(), detail: gateMatch[3] || null, at: now }
      : prev.gate;
    next = { ...next, [corr]: { ...prev, state: prev.state || 'open', ...(gate ? { gate } : {}), updated_at: now } };
  } else if (type === 'result') {
    next = { ...next, [corr]: { ...prev, state: 'awaiting-ack', result_from: fromPane, result_to: toPane, updated_at: now } };
  } else if (type === 'ack') {
    // An ack closes the thread ONLY when it is acknowledging a RESULT.
    //
    // The protocol defines `ack` as a fast "got it" that legitimately arrives
    // right after a request, long before any result. v1 treated every ack as
    // terminal and deleted the thread, so the normal sequence
    //   request -> ack -> progress -> result
    // deleted at the ack, then the progress recreated the thread from nothing
    // and the result parked it at awaiting-ack with nobody left to acknowledge
    // it — because the requester had already acked. The thread then sat in
    // unacked_inbound forever. Three of them accumulated over five days and
    // were only explained today by reading the audit log.
    //
    // The cost is not the stale rows: it is that a warning which is permanently
    // wrong trains every pane to ignore it, which is the exact opposite of what
    // the gate exists to do. Same failure family as a detector that no-ops.
    if (prev.state === 'awaiting-ack') {
      const { [corr]: _closed, ...rest } = next;
      next = rest;
      recordEvent({ event: 'a2a.thread-closed', corr, by: fromPane });
    } else if (prev.state) {
      // Early acknowledgement of a request: record it, keep the thread open.
      next = { ...next, [corr]: { ...prev, acked_at: now, updated_at: now } };
    }
    // An ack for a corr we have never seen creates nothing — inventing an open
    // thread from a stray acknowledgement would manufacture the same noise.
  } else if (type === 'error') {
    const { [corr]: _closed, ...rest } = next;
    next = rest;
    recordEvent({ event: 'a2a.thread-error', corr, by: fromPane });
  }

  const updated = { ...data, threads: next };
  writeThreads(file, updated);

  return Object.entries(updated.threads)
    .filter(([, t]) => t.state === 'awaiting-ack' && t.result_to === fromPane)
    .map(([c]) => c);
}

module.exports = { intelDir, detectV2, recordEvent, updateThreads };
