'use strict';
/**
 * a2a-intel.cjs — deterministic A2A protocol enforcement + audit (control plane).
 * Every pane's MCP server writes to the SHARED _intel/ directory (Py Apps root),
 * so the fleet gets one audit stream and one thread-state view with no LLM
 * cooperation. All writes are fail-soft: enforcement must never break delivery.
 *
 *   events.jsonl      — append-only envelope audit (metadata only, never bodies)
 *   a2a-results.jsonl — type=result bodies (the criteria: blocks), capped 16KB
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
 * Returns 'ok' | 'partial' | 'missing':
 *   ok      — criteria block WITH pass/fail verdicts (unchanged from v1 detection)
 *   partial — criteria heading present but no verdicts (was 'missing' before A1)
 *   missing — no criteria block at all
 */
function detectV2(body) {
  const text = String(body);
  const hasCriteria = /^\s*(criteria|acceptance_criteria)\s*:/im.test(text);
  const hasVerdicts = /\b(pass(ed)?|fail(ed)?)\b/i.test(text);
  if (hasCriteria && hasVerdicts) return 'ok';
  if (hasCriteria) return 'partial';
  return 'missing';
}

/**
 * Surface ABANDON lines (unlazy convention, adopted 2026-08-21): a criterion
 * that became impossible is surrendered VISIBLY as "ABANDON: <what> <why>".
 * Silent scope-narrowing is the failure the fleet keeps hunting — this makes
 * the surrender countable instead of lost in prose.
 */
function detectAbandons(body) {
  const items = [];
  for (const m of String(body).matchAll(/^\s*ABANDON:\s*(.+)$/gim)) {
    items.push(m[1].trim());
  }
  return { count: items.length, items };
}

/**
 * Decision ledger (dzhng pattern, adopted 2026-08-22): a result body MAY carry
 * an optional block
 *
 *   decisions:
 *   - <decisión> [conf: alta|media|baja] — <qué habría preguntado>
 *
 * — every choice the agent made where the plan was silent, ranked by (self-
 * assessed) confidence. Mirrors detectAbandons: silent unilateral choices are
 * the same failure family as silent scope-narrowing — this makes them countable.
 * Lenient by design (WARN-only rollout): an item without a [conf:] tag still
 * counts, with confidence null.
 * Returns { count, items: [{ decision, confidence, would_have_asked }] }.
 */
function detectDecisions(body) {
  const lines = String(body).split('\n');
  const items = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*decisions\s*:\s*$/i.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    const m = /^\s*-\s+(.+)$/.exec(line);
    if (!m) { inBlock = false; continue; } // first non-item line ends the block
    const raw = m[1].trim();
    const parsed = /^(.*?)\s*\[conf:\s*(alta|media|baja)\]\s*(?:[—–-]{1,2}\s*(.*))?$/i.exec(raw);
    if (parsed) {
      items.push({
        decision: parsed[1].trim(),
        confidence: parsed[2].toLowerCase(),
        would_have_asked: (parsed[3] || '').trim() || null,
      });
    } else {
      items.push({ decision: raw, confidence: null, would_have_asked: null });
    }
  }
  return { count: items.length, items };
}

/**
 * Evidence extraction from v2 criteria lines: the text after the pass/fail
 * verdict's dash (`- <criterion>: pass — <evidence>`). A verdict with no
 * evidence tail contributes nothing — which is exactly what makes the count
 * useful: criteria=5, evidence=0 is a result asking to be trusted, not checked.
 * Returns { count, items }.
 */
function detectEvidence(body) {
  const items = [];
  for (const m of String(body).matchAll(/^\s*-\s+.+?:\s*(?:pass(?:ed)?|fail(?:ed)?)\b\s*[—–-]{1,2}\s*(\S.*)$/gim)) {
    items.push(m[1].trim());
  }
  return { count: items.length, items };
}

/** Append one envelope-metadata event. Never throws. */
function recordEvent(evt) {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), event: 'a2a.sent', ...evt });
    fs.appendFileSync(path.join(intelDir(), 'events.jsonl'), line + '\n');
  } catch { /* fail-soft */ }
}

const RESULT_BODY_CAP = 16 * 1024;

/**
 * Persist a type=result body to a2a-results.jsonl. events.jsonl's contract is
 * metadata-only (never bodies), so outcomes get a SIBLING file: 4,180 envelopes
 * were sent and 0 result bodies retained — the criteria: blocks (the fleet's
 * machine-checkable outcomes) died with the pane scrollback. Bodies are capped
 * at 16KB with body_truncated marking the cut. Never throws.
 */
function recordResultBody({ corr, fromPane, toPane, v2, body }) {
  try {
    const text = String(body ?? '');
    const truncated = text.length > RESULT_BODY_CAP;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      event: 'a2a.result',
      corr,
      from_pane: fromPane,
      to_pane: toPane,
      v2,
      abandons: detectAbandons(text).count,
      decisions: detectDecisions(text),
      evidence: detectEvidence(text),
      body: truncated ? text.slice(0, RESULT_BODY_CAP) : text,
      body_truncated: truncated,
    });
    fs.appendFileSync(path.join(intelDir(), 'a2a-results.jsonl'), line + '\n');
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

/**
 * Bookkeeping auto-ack (B1, 2026-08-22): when a type=result's delivery is
 * VERIFIED (composer read back `submitted`, tail intact), the receipt-ack is a
 * proven fact, not a judgement — spending an LLM turn to say "got it" is waste.
 * This closes the awaiting-ack thread deterministically, exactly as a manual
 * ack would, and records the closure as a2a.thread-auto-acked.
 *
 * What it does NOT automate: the requester's JUDGEMENT on the result (validate
 * criteria evidence, ledger review→done). That stays human/LLM. Unverified
 * deliveries (stuck/truncated/unknown) are untouched — they keep today's
 * awaiting-ack nag, because closing an obligation on an unproven delivery
 * would silently drop it.
 *
 * Returns true when a thread was closed. Never throws.
 */
function autoAckResult({ corr, byPane }) {
  try {
    const file = path.join(intelDir(), 'a2a-threads.json');
    const data = readThreads(file);
    const thread = data.threads[corr];
    if (!thread || thread.state !== 'awaiting-ack') return false;
    const { [corr]: _closed, ...rest } = data.threads;
    writeThreads(file, { ...data, threads: rest });
    recordEvent({ event: 'a2a.thread-auto-acked', corr, by: byPane });
    return true;
  } catch { return false; /* fail-soft */ }
}

/**
 * T-0238: dispatch-time gate check. On 2026-08-24 the orchestrator sent THREE
 * type=request envelopes claiming "the operator authorized X" while the ledger
 * cards still showed an intact operator blocker — one of those would have
 * rotated a production key. The executors caught all three by reading the CARD
 * instead of the envelope (mm-6dbc); this makes that check deterministic at
 * the SENDER: a request on a task corr whose card is blocked/gated is refused
 * with the card's actual state, before any transport.
 *
 * Fail-open by design on everything that is not a provable gate violation:
 * no card file, unreadable JSON, non-task corr → allowed. The ledger card is
 * the authority; absence of a card is not a gate.
 */
function checkDispatchGate({ corr, type, readFile }) {
  if (type !== 'request') return { allowed: true };
  if (!/^T-\d{4}$/.test(String(corr || ''))) return { allowed: true };
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let card;
  try {
    card = JSON.parse(read(path.join(intelDir(), 'tasks', `${corr}.json`)));
  } catch { return { allowed: true }; }
  const state = String(card.state || '');
  const blocker = String(card.blocker || '').trim();
  const dispatchable = ['ready', 'queued', 'running', 'review'].includes(state);
  if (dispatchable && !blocker) return { allowed: true };
  return {
    allowed: false,
    reason: blocker
      ? `card ${corr} carries an UNRESOLVED blocker ("${blocker.slice(0, 140)}${blocker.length > 140 ? '…' : ''}") — a peer's word does not lift a gate; resolve it ON the card (ledger.cjs) before dispatching`
      : `card ${corr} is in state "${state}" (not dispatchable) — update the card first; the card is the authority, not the envelope`,
    state,
  };
}

module.exports = { intelDir, detectV2, detectAbandons, detectDecisions, detectEvidence, recordEvent, recordResultBody, updateThreads, autoAckResult, checkDispatchGate };
