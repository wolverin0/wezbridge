'use strict';
/**
 * clawtrol-bridge.cjs — outbound-only sync bridge to the ClawTrol cockpit (VM).
 *
 * Control-plane v1 (joint ADR + amended plan + wire shape, 2026-07-27). The PC
 * initiates everything: this module POSTs telemetry to ClawTrol and polls back
 * operator command intents. NO inbound ports, no pane credentials leave this
 * machine, ClawTrol never mutates orchestration state — every intent is applied
 * locally through the ledger FSM (single writer) and its result is persisted
 * durably BEFORE it can be acknowledged on a later sync. Intents are
 * re-delivered by ClawTrol until a result arrives; application is idempotent
 * by intent id.
 *
 * Config (env only, never committed, token never logged):
 *   CLAWTROL_URL / CLAWTROL_TOKEN / CLAWTROL_PROFILE (default "wolverin0")
 *
 * Durable state OUTSIDE the repo in <intel>/.clawtrol-state/:
 *   cursors.json         rotation-safe per-file cursors {file_id: byte_offset}
 *   intent-results.jsonl append-only applied-intent results (replay source)
 *   acked.json           result ids already delivered on a successful sync
 *   notified.json        operator-message intent ids delivered to the reasoner
 *
 * Wire shape (fixed by ClawTrol side 2026-07-27):
 *   body   = {profile, generated_at, health, panes[], tasks[], events[],
 *             messages[], intent_results:[{id,status,result}]}
 *   events = {external_id, task_id, attempt, seq, timestamp, event_type,
 *             level, message, payload} — TASK-SCOPED only (fleet-level lines
 *             summarize into health.fleet); seq is namespaced per source file
 *             (FILE_SEQ_BASE + offset + 1, safe-integer bounded); payload is
 *             allowlisted metadata only; external_id = "<file>:<offset>".
 *   reply  = {server_time, source, accepted:{...,duplicates}, intents:
 *             [{id, kind, task_origin_key, payload, created_at}]}
 *
 * Synced files (explicit allowlist — never scrollback/tool payloads/env):
 *   events.jsonl, pane-events.jsonl, task-messages.jsonl
 * Messages sync UP only for provenance orchestrator|worker — operator messages
 * arrive as intents and stay local.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const POLL_MS = 5_000;
const SNAPSHOT_EVERY = 6;          // every 6th poll (~30s) adds the full snapshot
const BACKOFF_MAX_MS = 300_000;
// After an intent is applied, its result + the resulting task card must not wait
// for the ordinary tick (and, for the card, the every-6th full snapshot). Measured
// operator-visible lag before this: ~115s from applied to card. We keep the
// durable-before-ack ordering exactly as-is and only shorten the NEXT sync.
const INTENT_FOLLOWUP_MS = 250;
const EVENT_BATCH_BYTES = 256 * 1024;
const EVENT_FILES = ['events.jsonl', 'pane-events.jsonl'];
const MESSAGE_FILE = 'task-messages.jsonl';
const SYNC_FILES = [...EVENT_FILES, MESSAGE_FILE];
const INTENT_KINDS = new Set(['create_task', 'message', 'approve', 'retry', 'cancel']);
const UP_PROVENANCE = new Set(['orchestrator', 'worker']);

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
}
function ledgerDir() {
  return process.env.WEZBRIDGE_LEDGER_DIR || path.join(__dirname, '..', '..', '_docs-curation');
}
function stateDir() {
  const d = path.join(intelDir(), '.clawtrol-state');
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* fail-soft */ }
  return d;
}

/**
 * Load CLAWTROL_* keys from the owner-only env file if they are not already in
 * the process env. Default location: <home>/.wezbridge/clawtrol.env (override
 * with WEZBRIDGE_CLAWTROL_ENV). KEY=VALUE lines, # comments. Values are never
 * logged. Only CLAWTROL_-prefixed keys are honored — this is a scoped secret
 * file, not a general dotenv.
 */
function loadEnvFile() {
  if (process.env.CLAWTROL_URL && process.env.CLAWTROL_TOKEN) return;
  const p = process.env.WEZBRIDGE_CLAWTROL_ENV
    || path.join(require('node:os').homedir(), '.wezbridge', 'clawtrol.env');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(CLAWTROL_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function config() {
  loadEnvFile();
  const url = process.env.CLAWTROL_URL;
  const token = process.env.CLAWTROL_TOKEN;
  if (!url || !token) return null;
  // Rollout canary allowlist (comma-separated repo names). FAIL-CLOSED: when
  // unset, NO task/event/message data ships — health + panes summary only.
  // Fleet expansion happens by editing the owner env file, never by default.
  const projects = new Set(String(process.env.CLAWTROL_PROJECTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean));
  return { url: url.replace(/\/+$/, ''), token, profile: process.env.CLAWTROL_PROFILE || 'wolverin0', projects };
}

// ---------- rotation-safe per-file cursors ----------

function readCursors() {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(), 'cursors.json'), 'utf8')); } catch { return {}; }
}

function writeCursors(cursors) {
  const file = path.join(stateDir(), 'cursors.json');
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cursors, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* fail-soft */ }
}

/**
 * Read new COMPLETE lines (with their byte offsets) past the stored cursor.
 * Rotation/truncation-safe: a cursor beyond current size resets to 0 — replay
 * is deduped server-side by external_id. Does NOT mutate stored cursors; the
 * caller persists them only after a successful POST, so failures replay.
 * Returns { entries: [{line, offset}], nextOffset }.
 */
function readDelta(fileId, cursors) {
  const p = path.join(intelDir(), fileId);
  let size;
  try { size = fs.statSync(p).size; } catch { return { entries: [], nextOffset: cursors[fileId] || 0 }; }
  let offset = cursors[fileId] || 0;
  if (offset > size) offset = 0;
  if (offset === size) return { entries: [], nextOffset: offset };
  const len = Math.min(size - offset, EVENT_BATCH_BYTES);
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, offset);
  } catch { return { entries: [], nextOffset: offset }; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ } }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { entries: [], nextOffset: offset };
  const entries = [];
  let cursor = offset;
  for (const line of text.slice(0, lastNl).split('\n')) {
    const byteLen = Buffer.byteLength(line, 'utf8') + 1;
    if (line.trim()) entries.push({ line, offset: cursor });
    cursor += byteLen;
  }
  return { entries, nextOffset: cursor };
}

/**
 * Map one raw jsonl line to the wire event shape — TASK-SCOPED ONLY (v1
 * boundary fixed by ClawTrol 2026-07-27: AgentActivityEvent rejects null
 * task_id/attempt). Returns null for fleet-level lines (a2a audit, beacons);
 * those summarize into health.fleet instead of uploading raw.
 */
// Deterministic per-file seq namespace: seq = base + offset + 1. Bases are 1e12
// apart, so offsets never collide across source files, and the largest value
// (3e12 + file offset) stays far below Number.MAX_SAFE_INTEGER (9e15) and
// Postgres bigint.
const FILE_SEQ_BASE = { 'events.jsonl': 1e12, 'pane-events.jsonl': 2e12, [MESSAGE_FILE]: 3e12 };

// Allowlisted payload metadata — never the raw parsed object, never content.
const PAYLOAD_FIELDS = ['event', 'state', 'repo', 'corr', 'type', 'task_id', 'attempt',
  'from_pane', 'to_pane', 'submitted', 'delivered', 'v2', 'session', 'markers', 'by', 'kind'];

function allowlistPayload(fileId, offset, parsed) {
  const out = { file: fileId, cursor: offset };
  for (const k of PAYLOAD_FIELDS) if (parsed[k] !== undefined) out[k] = parsed[k];
  return out;
}

function toWireEvent(fileId, entry) {
  let parsed = {};
  try { parsed = JSON.parse(entry.line); } catch { return null; }
  const taskId = parsed.task_id || (typeof parsed.id === 'string' && /^T-\d+$/.test(parsed.id) ? parsed.id : null);
  if (!taskId) return null;
  const eventType = parsed.event || 'task.event';
  return {
    external_id: `${fileId}:${entry.offset}`,
    task_id: taskId,
    attempt: Number(parsed.attempt) > 0 ? Number(parsed.attempt) : 1,
    seq: (FILE_SEQ_BASE[fileId] || 0) + entry.offset + 1, // per-file namespaced, safe-integer bounded
    timestamp: parsed.time || new Date().toISOString(),
    event_type: eventType,
    level: /error|fail/i.test(eventType) ? 'error' : 'info',
    message: `${eventType} ${taskId}`.slice(0, 300),
    payload: allowlistPayload(fileId, entry.offset, parsed),
  };
}

/** Fleet-level summary of delta lines that do NOT upload as events (v1 boundary). */
function fleetSummary(rawEntriesByFile) {
  const beaconsByRepo = {};
  let a2aEnvelopes = 0;
  let notable = null;
  for (const [fileId, entries] of Object.entries(rawEntriesByFile)) {
    for (const e of entries) {
      let parsed;
      try { parsed = JSON.parse(e.line); } catch { continue; }
      if (fileId === 'pane-events.jsonl') {
        const repo = parsed.repo || '?';
        beaconsByRepo[repo] = (beaconsByRepo[repo] || 0) + 1;
        if (parsed.event === 'permission-wait' || (parsed.markers || []).some((m) => /^GATE:/i.test(m))) {
          notable = { repo, event: parsed.event, markers: parsed.markers || [], time: parsed.time };
        }
      } else if (fileId === 'events.jsonl') {
        a2aEnvelopes += 1;
      }
    }
  }
  return { beacons_by_repo: beaconsByRepo, a2a_envelopes: a2aEnvelopes, ...(notable ? { last_notable: notable } : {}) };
}

/** Map one task-messages.jsonl line to the wire message shape (up-sync provenance only). */
function toWireMessage(entry) {
  let parsed = {};
  try { parsed = JSON.parse(entry.line); } catch { return null; }
  if (!UP_PROVENANCE.has(parsed.provenance)) return null; // operator messages arrive as intents; never echo them up
  return {
    external_id: `${MESSAGE_FILE}:${entry.offset}`,
    task_id: parsed.task_id || null,
    provenance: parsed.provenance,
    message_type: parsed.message_type || 'note',
    content: String(parsed.content || '').slice(0, 4000),
    sender_name: parsed.sender_name || parsed.session || 'orchestrator-pane',
    timestamp: parsed.time || new Date().toISOString(),
  };
}

// ---------- intent results (durable BEFORE ack; replay-safe) ----------

function resultsFile() { return path.join(stateDir(), 'intent-results.jsonl'); }

function appliedIntentIds() {
  const ids = new Set();
  try {
    for (const line of fs.readFileSync(resultsFile(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { ids.add(JSON.parse(line).id); } catch { /* skip corrupt line */ }
    }
  } catch { /* no results yet */ }
  return ids;
}

function persistResult(result) {
  fs.appendFileSync(resultsFile(), JSON.stringify(result) + '\n');
}

function unackedResults(ackedIds) {
  const out = [];
  try {
    for (const line of fs.readFileSync(resultsFile(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (!ackedIds.has(r.id)) out.push(r); } catch { /* skip */ }
    }
  } catch { /* none */ }
  return out;
}

function readAckState() {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(stateDir(), 'acked.json'), 'utf8'))); } catch { return new Set(); }
}

function writeAckState(set) {
  const file = path.join(stateDir(), 'acked.json');
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...set]));
    fs.renameSync(tmp, file);
  } catch { /* fail-soft */ }
}

function readNotifiedState() {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(stateDir(), 'notified.json'), 'utf8'))); } catch { return new Set(); }
}

function writeNotifiedState(set) {
  const file = path.join(stateDir(), 'notified.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...set]));
  fs.renameSync(tmp, file);
}

// ---------- ledger integration (the ledger CLI stays the single writer) ----------

function runLedger(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ledgerDir(), 'ledger.cjs'), ...args],
      { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

/** Ledger task id from payload.task_id or the ":task:<T-NNNN>" tail of task_origin_key. */
function resolveTaskId(intent) {
  const p = intent.payload || {};
  if (p.task_id && /^T-\d+$/.test(p.task_id)) return p.task_id;
  const m = String(intent.task_origin_key || '').match(/:task:(T-\d+)\b/);
  return m ? m[1] : null;
}

/**
 * Apply one operator intent through the ledger FSM. Structured result, never
 * throws. create_task goes through ledger create, which applies the per-repo
 * graph contract — gated kinds are BORN BLOCKED no matter what ClawTrol asked
 * for (plan-review amendment 2).
 */
async function applyIntent(intent) {
  const base = { id: intent.id, status: 'rejected', result: { kind: intent.kind, applied_at: new Date().toISOString() } };
  if (!INTENT_KINDS.has(intent.kind)) {
    return { ...base, result: { ...base.result, reason: `unknown intent kind "${intent.kind}"` } };
  }
  const p = intent.payload || {};
  try {
    if (intent.kind === 'message') {
      appendTaskMessage({
        task_id: resolveTaskId(intent),
        message_type: p.message_type || 'operator_message',
        content: String(p.content || '').slice(0, 4000),
        provenance: 'operator',
        intent_id: intent.id,
      });
      return { ...base, status: 'applied' };
    }
    if (intent.kind === 'create_task') {
      // Rails/UI wire payload is {project, brief, title, kind, priority,
      // acceptance}; older callers may send {repo, goal}. Accept both.
      const repo = p.project || p.repo;
      const goal = p.brief || p.goal;
      if (!repo || !p.kind || !p.title || !goal) {
        return { ...base, result: { ...base.result, reason: 'create_task requires payload {project|repo, kind, title, brief|goal}' } };
      }
      const args = ['create', '--repo', repo, '--kind', p.kind, '--title', p.title, '--goal', goal];
      const criteria = Array.isArray(p.acceptance) ? p.acceptance.join(';') : (typeof p.acceptance === 'string' ? p.acceptance : null);
      if (criteria) args.push('--criteria', criteria);
      const r = await runLedger(args);
      if (!r.ok) return { ...base, result: { ...base.result, reason: `ledger create failed: ${r.stderr.slice(0, 300)}` } };
      const idMatch = r.stdout.match(/"id":\s*"(T-\d+)"/);
      const stateMatch = r.stdout.match(/"state":\s*"(\w+)"/);
      return {
        ...base, status: 'applied',
        result: {
          ...base.result, task_id: idMatch ? idMatch[1] : null, task_state: stateMatch ? stateMatch[1] : null,
          ...(p.priority ? { note: 'priority not persisted (ledger v1 has no priority field)' } : {}),
        },
      };
    }
    // message handled above; approve / retry / cancel — FSM transitions on an
    // existing task. Rails may omit payload.task_id and carry the id only in
    // intent.task_origin_key ("...:task:<T-NNNN>").
    const taskId = resolveTaskId(intent);
    if (!taskId) return { ...base, result: { ...base.result, reason: `${intent.kind} requires payload.task_id or a task_origin_key ending :task:<T-NNNN>` } };
    const target = intent.kind === 'approve' ? 'ready' : intent.kind === 'retry' ? 'queued' : 'cancelled';
    const r = await runLedger(['update', taskId, '--state', target, '--note', `${intent.kind} via clawtrol intent ${intent.id}`]);
    if (!r.ok || /ledger error/i.test(r.stdout + r.stderr)) {
      return { ...base, result: { ...base.result, reason: `illegal transition or ledger error: ${(r.stderr || r.stdout).slice(0, 300)}` } };
    }
    return { ...base, status: 'applied', result: { ...base.result, task_id: taskId, task_state: target } };
  } catch (e) {
    return { ...base, result: { ...base.result, reason: `apply crashed: ${String(e && e.message).slice(0, 200)}` } };
  }
}

// ---------- task messages (append-only, provenance-tagged) ----------

function appendTaskMessage(msg) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...msg });
  fs.appendFileSync(path.join(intelDir(), MESSAGE_FILE), line + '\n');
}

// ---------- snapshot builders (metadata only — never scrollback/env) ----------

async function buildPanes() {
  try {
    const discovery = require('./pane-discovery.cjs');
    const panes = await discovery.discoverPanes();
    return panes.filter((p) => p.isClaude || p.isCodex).map((p) => ({
      pane_id: p.paneId, agent: p.agent, status: p.status,
      project: p.project ? path.basename(String(p.project)) : null,
    }));
  } catch { return []; }
}

function buildTasks(projects = new Set()) {
  try {
    const dir = path.join(intelDir(), 'tasks');
    const tasks = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean)
      .filter((t) => projects.has(t.repo)); // canary allowlist — fail-closed on empty
    return tasks.map((t) => ({
      id: t.id, title: t.title, brief: t.goal || null, project: t.repo, kind: t.kind,
      state: t.state, priority: t.priority || null, attempt: t.attempt,
      depends_on: t.depends_on || [], blocker: t.blocker || null,
      next_action: t.next_action || null,
      lease: t.lease ? { owner: t.lease.owner, expires_at: t.lease.expires_at } : null,
      acceptance: t.acceptance_criteria || null, evidence: t.evaluator_evidence || null,
      summary: t.summary || null, outcome: t.outcome || null, updated_at: t.updated_at,
    }));
  } catch { return []; }
}

// ---------- the sync loop ----------

const state = {
  running: false, timer: null, tick: 0, failures: 0, inFlight: false,
  lastOkAt: null, lastError: null, notifyOperatorMessage: null,
  // Set when a sync applied at least one intent: the next sync is expedited AND
  // forced to carry a full snapshot so the new task card ships with the ack.
  forceSnapshot: false,
};

/** Task ids belonging to allowlisted canary projects (fail-closed on empty allowlist). */
function allowedTaskIds(projects) {
  const ids = new Set();
  if (!projects || !projects.size) return ids;
  try {
    const dir = path.join(intelDir(), 'tasks');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (projects.has(t.repo)) ids.add(t.id);
      } catch { /* skip corrupt */ }
    }
  } catch { /* no tasks dir */ }
  return ids;
}

async function deliverOperatorMessages(projects, notify) {
  if (typeof notify !== 'function') return { delivered: 0, pending: 0 };
  const allowed = allowedTaskIds(projects);
  const notified = readNotifiedState();
  const pending = [];
  try {
    for (const line of fs.readFileSync(path.join(intelDir(), MESSAGE_FILE), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.provenance !== 'operator' || !message.intent_id || !allowed.has(message.task_id)) continue;
      if (!notified.has(String(message.intent_id))) pending.push(message);
    }
  } catch { return { delivered: 0, pending: 0 }; }

  let delivered = 0;
  for (const message of pending) {
    try {
      if (await notify(message) === false) continue;
      notified.add(String(message.intent_id));
      writeNotifiedState(notified);
      delivered += 1;
    } catch { /* keep pending; retry on the next poll */ }
  }
  return { delivered, pending: pending.length - delivered };
}

async function syncOnce(cfg, { fullSnapshot, notifyOperatorMessage = state.notifyOperatorMessage }) {
  const cursors = readCursors();
  const nextCursors = { ...cursors };
  const canaryIds = allowedTaskIds(cfg.projects);
  const events = [];
  const rawEntriesByFile = {};
  for (const f of EVENT_FILES) {
    const { entries, nextOffset } = readDelta(f, cursors);
    rawEntriesByFile[f] = entries;
    for (const e of entries) {
      const wire = toWireEvent(f, e);
      // Canary allowlist: only events for tasks in allowlisted projects ship.
      if (wire && canaryIds.has(wire.task_id)) events.push(wire);
    }
    nextCursors[f] = nextOffset;
  }
  const messages = [];
  {
    const { entries, nextOffset } = readDelta(MESSAGE_FILE, cursors);
    for (const e of entries) {
      const m = toWireMessage(e);
      // Canary boundary: ONLY messages tied to an allowlisted task ship.
      // Task-less notes are dropped entirely — unrelated fleet prose must
      // never leak into the canary (review round 3 correction).
      if (m && m.task_id && canaryIds.has(m.task_id)) messages.push(m);
    }
    nextCursors[MESSAGE_FILE] = nextOffset;
  }
  const acked = readAckState();
  const body = {
    profile: cfg.profile,
    generated_at: new Date().toISOString(),
    health: {
      status: state.failures === 0 ? 'ok' : 'degraded',
      failures: state.failures, last_ok: state.lastOkAt, last_error: state.lastError,
      fleet: fleetSummary(rawEntriesByFile),
    },
    ...(events.length ? { events } : {}),
    ...(messages.length ? { messages } : {}),
    intent_results: unackedResults(acked),
    ...(fullSnapshot ? { tasks: buildTasks(cfg.projects), panes: await buildPanes() } : {}),
  };

  const res = await fetch(`${cfg.url}/api/v1/orchestration/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`sync HTTP ${res.status}`);
  const reply = await res.json().catch(() => ({}));

  // POST accepted: cursors advance; delivered results are acked (server-side
  // external_id/intent-id dedup makes any re-send harmless).
  writeCursors(nextCursors);
  for (const r of body.intent_results) acked.add(r.id);
  writeAckState(acked);

  // Apply pending intents — idempotent by intent id; the result is persisted
  // BEFORE it can ever be acknowledged (ships on the NEXT successful sync).
  const done = appliedIntentIds();
  let appliedNow = 0;
  for (const intent of Array.isArray(reply.intents) ? reply.intents : []) {
    if (!intent || !intent.id || done.has(intent.id)) continue;
    const result = await applyIntent(intent);
    persistResult(result);                 // durable BEFORE any ack — unchanged
    done.add(intent.id);
    appliedNow += 1;
  }
  await deliverOperatorMessages(cfg.projects, notifyOperatorMessage);
  return {
    sent_events: events.length, sent_messages: messages.length,
    intents: (reply.intents || []).length, applied: appliedNow,
  };
}

async function tick() {
  const cfg = config();
  if (!cfg || state.inFlight) return;
  state.inFlight = true;
  try {
    state.tick += 1;
    const fullSnapshot = state.forceSnapshot || state.tick % SNAPSHOT_EVERY === 1;
    state.forceSnapshot = false;           // consume before the await; re-set below if needed
    const r = await syncOnce(cfg, { fullSnapshot });
    state.failures = 0;
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    // An applied intent expedites exactly ONE follow-up sync carrying a full
    // snapshot, so the operator sees the result and the new card together.
    // Serialized by the same timer + inFlight guard as any other tick — this is
    // a shortened delay, never a recursive or parallel POST. The failure path
    // below is untouched, so backoff still wins.
    if (r && r.applied > 0) {
      state.forceSnapshot = true;
      schedule(INTENT_FOLLOWUP_MS);
    } else {
      schedule(POLL_MS);
    }
  } catch (e) {
    state.failures += 1;
    state.lastError = String(e && e.message).slice(0, 200);
    const backoff = Math.min(POLL_MS * 2 ** state.failures, BACKOFF_MAX_MS);
    schedule(backoff + Math.floor(Math.random() * 1000)); // jitter
  } finally {
    state.inFlight = false;
  }
}

function schedule(ms) {
  if (!state.running) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(tick, ms);
  if (state.timer.unref) state.timer.unref();
}

function start({ notifyOperatorMessage } = {}) {
  if (!config()) return false; // unconfigured → disabled silently (fail-soft)
  if (state.running) return true;
  state.notifyOperatorMessage = typeof notifyOperatorMessage === 'function' ? notifyOperatorMessage : null;
  state.running = true;
  schedule(1000);
  return true;
}

function stop() {
  state.running = false;
  clearTimeout(state.timer);
}

function health() {
  return { enabled: Boolean(config()), running: state.running, failures: state.failures, last_ok: state.lastOkAt, last_error: state.lastError };
}

module.exports = {
  start, stop, health,
  // exported for tests
  readDelta, readCursors, writeCursors, toWireEvent, toWireMessage,
  fleetSummary, applyIntent, resolveTaskId, appendTaskMessage,
  appliedIntentIds, persistResult, unackedResults, readAckState,
  writeAckState, readNotifiedState, writeNotifiedState,
  deliverOperatorMessages, syncOnce, buildTasks, INTENT_KINDS, SYNC_FILES,
  FILE_SEQ_BASE, PAYLOAD_FIELDS,
};
