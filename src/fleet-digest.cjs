'use strict';
/**
 * fleet-digest.cjs — T-0409 (S6 re-scope): classify _intel/pane-events.jsonl entries
 * into immediate / digest / drop, batch `digest` items into ONE message per 30-min
 * window, and keep a durable cursor + send log so pokes/day to the Fleet terminal are
 * MEASURED (fleet-digest --count-day replaces the dead daemon-err.log instrument).
 * Key terms: classifyEvent, buildDigests, runOnce (durable tick), runReplay (stateless
 * dry-run over a time range), countDay, ECHO_MARKERS (reused from orca-census.cjs).
 * Read when: tuning what wakes the Fleet, adding a new pane-events `event` kind, or the
 * AC4 replay prediction drifts. See docs/operations.md "Fleet digest" for the operator view.
 *
 * WHY. The old orchestrator-waker (WezTerm-pane poke) is disarmed and structurally
 * cannot reach Orca terminals (see _intel/briefs/2026-09-24-T0409-scope-REPORT.md). The
 * fleet now runs on Orca, and orca-census.cjs already writes worker-done/suborch_* to
 * pane-events.jsonl. This module turns that firehose (turn-end + permission-wait alone
 * were ~360 lines/day on 23/09) into a bounded signal: questions and failures go out
 * immediately, completions batch into a digest every 30 min, and status/turn-end/
 * permission-wait never wake anyone.
 *
 * Pure logic lives here (no child_process, no Orca CLI). scripts/fleet-digest.cjs is
 * the CLI: it wires notify_orchestrator.py as the `send` function and parses argv.
 * This module never sends anything by itself — runOnce only calls the `send` it is
 * given, and only when `sendEnabled` is true.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ECHO_MARKERS } = require('./orca-census.cjs');

const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // greppable: the S6 digest window is 30 min

// Events that never wake anyone — high-volume, no decision attached.
const DROP_EVENTS = new Set(['suborch_status', 'turn-end', 'permission-wait']);
// Completions: batched into the next digest unless they failed.
const DONE_EVENTS = new Set(['worker-done', 'suborch_done']);

/**
 * True when an event's raw `line` only echoes a brief/template back on screen —
 * same ECHO_MARKERS orca-census.cjs already filters before writing pane-events.jsonl.
 * Checked again here as defense-in-depth: a line that slips through (or a fixture/test
 * line built without going through orca-census) must still classify to nothing.
 */
function isEchoEvent(evt) {
  const line = evt && typeof evt.line === 'string' ? evt.line : '';
  if (!line) return false;
  return ECHO_MARKERS.some((m) => line.includes(m));
}

/**
 * classifyEvent(evt) -> 'immediate' | 'digest' | 'drop'
 *   immediate: suborch_question; worker-done/suborch_done with outcome=failed
 *   digest:    worker-done/suborch_done with outcome succeeded or null/absent; suborch_handoff
 *   drop:      suborch_status, turn-end, permission-wait, an echoed brief line, anything unknown
 * Never throws — a malformed event drops rather than crashing the tick.
 */
function classifyEvent(evt) {
  if (!evt || typeof evt !== 'object') return 'drop';
  if (isEchoEvent(evt)) return 'drop';
  const kind = evt.event;
  if (!kind) return 'drop'; // no `event` field at all: nothing to classify
  if (kind === 'suborch_question') return 'immediate';
  if (DONE_EVENTS.has(kind)) return evt.outcome === 'failed' ? 'immediate' : 'digest';
  if (kind === 'suborch_handoff') return 'digest';
  if (DROP_EVENTS.has(kind)) return 'drop';
  // A kind pane-events.jsonl has never carried before (a NEW `event` value orca-census.cjs
  // starts writing) surfaces in the next digest rather than vanishing silently forever —
  // load-bearing default: the AC6 mutation test (test/fleet-digest.test.cjs) removes an
  // entry from DROP_EVENTS and checks the AC4 replay prediction goes red, proving this
  // line is not a no-op.
  return 'digest';
}

/**
 * terminal -> lane name, via src/lane-roster.cjs's roster (same prefix-match convention
 * as mergeLanes: a roster handle may be a short id, a census/event handle the full one).
 * Falls back to evt.repo (always present, always readable) when no roster entry matches.
 */
function resolveLane(evt, roster) {
  const lanes = (roster && Array.isArray(roster.lanes)) ? roster.lanes : [];
  const terminal = evt && evt.terminal;
  if (terminal) {
    const hit = lanes.find((l) => l.handle
      && (l.handle === terminal || terminal.startsWith(l.handle) || l.handle.startsWith(terminal)));
    if (hit && hit.lane) return hit.lane;
  }
  return (evt && evt.repo) || 'unknown';
}

/** Epoch-aligned [startMs, endMs) window an event's timestamp falls into. Deterministic
 * across live ticks and replay: the SAME event always buckets into the SAME window
 * regardless of when it is processed. */
function windowBucket(evt, windowMs = DEFAULT_WINDOW_MS) {
  const t = Date.parse((evt && (evt.time || evt.ts)) || '');
  const ms = Number.isFinite(t) ? t : Date.now();
  const startMs = Math.floor(ms / windowMs) * windowMs;
  return { startMs, endMs: startMs + windowMs };
}

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * Resolve the real `_intel` dir pane-events.jsonl lives in. WEZBRIDGE_INTEL_DIR wins
 * when set (same convention as lane-roster.cjs / orca-census.cjs). Otherwise walk UP
 * from `startDir` looking for a `_intel/pane-events.jsonl` — the plain two-levels-up
 * guess those modules use (`<repo>/../../_intel`) assumes the repo sits directly under
 * Py Apps/, which is false inside a git worktree (`<repo>/.claude/worktrees/<id>/`,
 * several levels deeper). Falls back to the two-levels-up guess if nothing is found,
 * so behaviour outside a worktree is unchanged.
 */
function resolveIntelDir(startDir) {
  if (process.env.WEZBRIDGE_INTEL_DIR) return process.env.WEZBRIDGE_INTEL_DIR;
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '_intel', 'pane-events.jsonl');
    if (fs.existsSync(candidate)) return path.join(dir, '_intel');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(startDir, '..', '..', '_intel');
}

/** One line per lane per item, inside a `[FLEET DIGEST hh:mm-hh:mm Z]` header. */
function formatDigestMessage(bucket, items, roster) {
  const byLane = new Map();
  for (const evt of items) {
    const lane = resolveLane(evt, roster);
    if (!byLane.has(lane)) byLane.set(lane, []);
    const label = evt.event === 'suborch_handoff'
      ? `handoff ${evt.path || ''}`.trim()
      : `${evt.task_id || '?'} ${evt.outcome === 'failed' ? 'FAILED' : 'done'}`
        + (evt.outcome ? ` (${evt.outcome})` : '')
        + (evt.report ? ` — report=${evt.report}` : '');
    byLane.get(lane).push(label);
  }
  const hh = (ms) => new Date(ms).toISOString().slice(11, 16);
  const lines = [`[FLEET DIGEST ${hh(bucket.startMs)}-${hh(bucket.endMs)}Z]`];
  for (const [lane, laneItems] of byLane) lines.push(`${lane}: ${laneItems.join('; ')}`);
  return lines.join('\n');
}

/** A single immediate item, sent on its own. */
function formatImmediateMessage(evt, roster) {
  const lane = resolveLane(evt, roster);
  if (evt.event === 'suborch_question') {
    return `[FLEET IMMEDIATE] ${lane} ${evt.task_id || '?'} question: ${evt.q || ''}`;
  }
  const reportPart = evt.report ? ` report=${evt.report}` : '';
  return `[FLEET IMMEDIATE] ${lane} ${evt.task_id || '?'} FAILED${reportPart}`;
}

/**
 * buildDigests(events, {windowMs, roster}) -> [{windowStart, windowEnd, lanes, items, message}]
 * events must already be classify-filtered to 'immediate' | 'digest' kind (drop excluded
 * by the caller). Groups by window bucket; a bucket with zero items never appears — NO
 * EMPTY DIGESTS. immediate items are included here too (they are sent on their own AND
 * listed in the digest whose window they fall in — the "next digest" after the immediate
 * send is exactly that window's close).
 */
function buildDigests(events, opts = {}) {
  const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
  const roster = opts.roster || { lanes: [] };
  const buckets = new Map();
  for (const evt of events || []) {
    const { startMs, endMs } = windowBucket(evt, windowMs);
    if (!buckets.has(startMs)) buckets.set(startMs, { startMs, endMs, items: [] });
    buckets.get(startMs).items.push(evt);
  }
  const out = [];
  for (const startMs of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(startMs);
    if (!bucket.items.length) continue; // defensive: buckets are only created with >=1 item
    out.push({
      windowStart: new Date(bucket.startMs).toISOString(),
      windowEnd: new Date(bucket.endMs).toISOString(),
      lanes: [...new Set(bucket.items.map((i) => resolveLane(i, roster)))],
      items: bucket.items.map((i) => ({
        task_id: i.task_id || null, outcome: i.outcome || null, report: i.report || null,
        lane: resolveLane(i, roster), event: i.event,
      })),
      message: formatDigestMessage(bucket, bucket.items, roster),
    });
  }
  return out;
}

// ── durable cursor (same shape as orchestrator-waker.cjs's: bytes + tail fingerprint) ──

function readCursorFile(file, eventsPath) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = null; }
  if (saved && typeof saved.bytes === 'number') return saved;
  // Fresh state starts at EOF: a digest signals new activity, it does not replay history.
  let size = 0;
  try { size = fs.statSync(eventsPath).size; } catch { /* no events file yet */ }
  return { bytes: size, tail: null };
}

function writeCursorFile(file, cursor) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cursor, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function tailMatches(fd, cursor) {
  if (!cursor.tail || cursor.tail.len > cursor.bytes) return true;
  const { len, hash } = cursor.tail;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, cursor.bytes - len);
  return sha1(buf) === hash;
}

/** New complete-line events since `cursor` (byte offset + tail hash). Rotation/truncation
 * (size shrank, or the tail bytes no longer match) resets the cursor to 0 and re-reads —
 * same recovery as orchestrator-waker.cjs's ingestEvents. An in-flight partial last line
 * is left for the next tick. Never throws on a missing file or a corrupt JSON line. */
function tailNewEvents(eventsPath, cursor) {
  let stat;
  try { stat = fs.statSync(eventsPath); } catch { return { events: [], newCursor: cursor }; }
  const fd = fs.openSync(eventsPath, 'r');
  let events = [];
  let newCursor = { ...cursor };
  try {
    const shrank = stat.size < cursor.bytes;
    if (shrank || (cursor.bytes > 0 && !tailMatches(fd, cursor))) {
      newCursor = { bytes: 0, tail: null };
    }
    if (stat.size === newCursor.bytes) return { events: [], newCursor };
    const len = stat.size - newCursor.bytes;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, newCursor.bytes);
    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return { events: [], newCursor };
    const consumedStr = chunk.slice(0, lastNewline + 1);
    for (const line of consumedStr.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* corrupt line: skip, never crash */ }
    }
    const newBytes = newCursor.bytes + Buffer.byteLength(consumedStr, 'utf8');
    const tailLen = Math.min(256, newBytes);
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, newBytes - tailLen);
    newCursor = { bytes: newBytes, tail: { len: tailLen, hash: sha1(tailBuf) } };
  } finally { fs.closeSync(fd); }
  return { events, newCursor };
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function appendSent(sentFile, entry) {
  fs.mkdirSync(path.dirname(sentFile), { recursive: true });
  fs.appendFileSync(sentFile, `${JSON.stringify(entry)}\n`);
}

/**
 * One durable tick: ingest new events since the cursor, send every `immediate` item
 * right away, and flush the pending digest window once its close time has passed.
 * `send(message)` is caller-supplied (the CLI wires notify_orchestrator.py); this
 * function calls it ONLY when sendEnabled is true — the default is dry-run: classify
 * and log what WOULD be sent to sent.jsonl with delivered:null, but call nothing.
 * Every send (real or dry-run) is appended to stateDir/sent.jsonl as
 * {at, kind, n_events, lanes, message_sha1, delivered}. delivered is null in dry-run,
 * true/false once a real `send` call is made.
 */
function runOnce(opts) {
  const {
    eventsPath, stateDir, windowMs = DEFAULT_WINDOW_MS, now = () => Date.now(),
    send, sendEnabled = false, roster = { lanes: [] },
  } = opts;
  if (!eventsPath || !stateDir) throw new Error('fleet-digest: eventsPath and stateDir are required');
  fs.mkdirSync(stateDir, { recursive: true });
  const cursorFile = path.join(stateDir, 'cursor.json');
  const sentFile = path.join(stateDir, 'sent.jsonl');
  const pendingFile = path.join(stateDir, 'pending-digest.json');

  const cursor = readCursorFile(cursorFile, eventsPath);
  const { events, newCursor } = tailNewEvents(eventsPath, cursor);
  writeCursorFile(cursorFile, newCursor);

  const classified = events.map((e) => ({ ...e, kind: classifyEvent(e) })).filter((e) => e.kind !== 'drop');
  const immediates = classified.filter((e) => e.kind === 'immediate');
  const digestEvents = classified; // immediate items also land in the digest (see buildDigests doc)

  const result = { immediateSent: [], digestSent: null };

  function record(message, kind, items) {
    const lanes = [...new Set(items.map((i) => resolveLane(i, roster)))];
    const entry = {
      at: new Date(now()).toISOString(), kind, n_events: items.length, lanes,
      message_sha1: sha1(message), delivered: null,
    };
    if (sendEnabled) {
      if (typeof send !== 'function') throw new Error('fleet-digest: sendEnabled requires a send function');
      const r = send(message);
      entry.delivered = !!(r && r.ok);
    }
    appendSent(sentFile, entry);
    return { message, entry };
  }

  for (const evt of immediates) {
    result.immediateSent.push(record(formatImmediateMessage(evt, roster), 'immediate', [evt]));
  }

  const pending = readJsonFile(pendingFile, { items: [] });
  pending.items.push(...digestEvents);
  if (pending.items.length) {
    const bucket = windowBucket(pending.items[0], windowMs);
    if (now() >= bucket.endMs) {
      const message = formatDigestMessage(bucket, pending.items, roster);
      result.digestSent = record(message, 'digest', pending.items);
      pending.items = [];
    }
  }
  writeJsonFile(pendingFile, pending);
  return result;
}

/**
 * runReplay — STATELESS dry-run prediction over [from, to). Reads eventsPath read-only,
 * never touches stateDir/cursor/sent.jsonl. Used by `--dry-run --replay` (AC4): predicts
 * sends/day for a time range against the real pane-events.jsonl without ever writing to
 * _intel/.fleet-digest.
 */
function runReplay({ eventsPath, from, to, windowMs = DEFAULT_WINDOW_MS, roster = { lanes: [] } }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error(`fleet-digest replay: invalid range from=${from} to=${to}`);
  }
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8').split('\n'); } catch { raw = []; }
  const inRange = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    const t = Date.parse(evt.time || evt.ts || '');
    if (!Number.isFinite(t) || t < fromMs || t >= toMs) continue;
    inRange.push(evt);
  }
  const classified = inRange.map((e) => ({ ...e, kind: classifyEvent(e) })).filter((e) => e.kind !== 'drop');
  const immediates = classified.filter((e) => e.kind === 'immediate');
  const digests = buildDigests(classified, { windowMs, roster });
  const totalSends = immediates.length + digests.length;
  const rangeHours = (toMs - fromMs) / 3600000;
  const predictedSendsPerDay = rangeHours > 0 ? totalSends * (24 / rangeHours) : totalSends;
  return {
    rawEvents: inRange.length,
    immediateCount: immediates.length,
    digestMessageCount: digests.length,
    totalSends,
    predictedSendsPerDay,
    digests,
    immediates,
  };
}

/** Sends recorded on `day` (YYYY-MM-DD, UTC prefix of `at`). Replaces daemon-err.log as
 * the S6 instrument (that file is dead — see the T-0409 scope report). */
function countDay(stateDir, day) {
  const sentFile = path.join(stateDir, 'sent.jsonl');
  let lines;
  try { lines = fs.readFileSync(sentFile, 'utf8').split('\n').filter((l) => l.trim()); } catch { return 0; }
  let n = 0;
  for (const line of lines) {
    try { if (JSON.parse(line).at.startsWith(day)) n += 1; } catch { /* skip corrupt */ }
  }
  return n;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  resolveIntelDir,
  classifyEvent,
  isEchoEvent,
  resolveLane,
  windowBucket,
  buildDigests,
  formatDigestMessage,
  formatImmediateMessage,
  readCursorFile,
  writeCursorFile,
  tailNewEvents,
  runOnce,
  runReplay,
  countDay,
  sha1,
};
