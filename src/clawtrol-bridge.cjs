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
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const POLL_MS = 5_000;
const SNAPSHOT_EVERY = 6;          // every 6th poll (~30s) adds the full snapshot
const BACKOFF_MAX_MS = 300_000;
// UNCHANGED TASK SNAPSHOTS ARE NOT SENT (Solid Cable flood, 2026-08-12).
// Every 30s this bridge shipped ~76 mirrored tasks whether or not a single byte
// had changed. The receiving ingestor assigns attributes and calls save!
// UNCONDITIONALLY, so each arrival fired task callbacks on three channels — one
// of which carries fully rendered kanban-column HTML — measured at 300-600
// messages/min, ~494k retained rows and ~5.2 GB of table in 24h.
//
// The producer is the cheapest place to break that chain: a snapshot that is
// byte-identical to the last one the server ACCEPTED tells it nothing, so it is
// omitted. Panes are deliberately NOT suppressed — they carry ctx/session/weekly
// percentages that legitimately change every tick, and they are not the
// amplification path.
//
// RECONCILE_EVERY_TICKS is the safety valve: suppression is an optimisation, not
// a source of truth, so a full task snapshot ships on a fixed cadence regardless
// of the digest. If the server's view ever diverges (restore, partial write, a
// dropped POST that still returned ok) it self-heals within this window instead
// of waiting for the next unrelated task edit.
const RECONCILE_EVERY_TICKS = 240; // ~20 min at POLL_MS=5s
// Consecutive failures before an outage is worth a log line. 1 was too eager:
// this endpoint blips and self-heals constantly, so every blip printed.
const SUSTAINED_FAILURES = 2;

/**
 * Is this consecutive-failure count worth a line? Extracted so the noise policy
 * is assertable: it produced ~25 alarming lines overnight about blips that
 * healed themselves, in the same stream the orchestrator waker logs to.
 * Silent on 1 (the retry handles it), speaks at 2, then every 5th.
 */
function shouldLogFailure(failures) {
  return failures === SUSTAINED_FAILURES || (failures > 0 && failures % 5 === 0);
}

/** A recovery is news only if the outage was worth announcing in the first place. */
function shouldLogRecovery(failures) {
  return failures >= SUSTAINED_FAILURES;
}
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
// True when the allowlist came from the real process environment rather than
// the env file. A caller who exports CLAWTROL_PROJECTS explicitly outranks the
// file, so we must not clobber them on refresh.
const PROJECTS_PINNED_BY_ENV = process.env.CLAWTROL_PROJECTS !== undefined;

function loadEnvFile() {
  const secretsCached = Boolean(process.env.CLAWTROL_URL && process.env.CLAWTROL_TOKEN);
  const canRefreshAllowlist = !PROJECTS_PINNED_BY_ENV;
  if (secretsCached && !canRefreshAllowlist) return;
  const p = process.env.WEZBRIDGE_CLAWTROL_ENV
    || path.join(require('node:os').homedir(), '.wezbridge', 'clawtrol.env');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(CLAWTROL_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    // The allowlist is the ONE key re-read on every tick. It is a fail-closed
    // security boundary the operator widens by hand, and caching it at boot
    // meant editing the file did nothing until someone remembered to restart
    // the daemon — a silent no-op on a security control, which is the same
    // "confidently wrong, no error" family as the frozen-feed and null-ctx
    // defects. Secrets stay cached: rotating those SHOULD require a restart.
    if (m[1] === 'CLAWTROL_PROJECTS' && canRefreshAllowlist) process.env[m[1]] = m[2];
    else if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
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
// `role`/`markers_prose_only` matter for TRUST: without them the cockpit cannot
// tell an orchestrator REPORTING that a peer deployed from a peer actually
// deploying, and cannot tell a marker scraped from prose from a real event
// (both real 2026-07-28 defects — mm-ad08, mm-978b). `owner`/`minutes` carry
// lease ownership; `message`/`reason`/`resolution` are short structured strings
// already written by our own tooling (e.g. "Claude is waiting for your input"),
// NOT free user content — the no-scrollback rule is unaffected.
const PAYLOAD_FIELDS = ['event', 'state', 'repo', 'corr', 'type', 'task_id', 'attempt',
  'from_pane', 'to_pane', 'submitted', 'delivered', 'v2', 'session', 'markers', 'by', 'kind',
  'role', 'markers_prose_only', 'markers_may_be_reports', 'owner', 'minutes',
  'message', 'reason', 'resolution'];

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
        // NEVER trust the shape of a line written by another process. On
        // 2026-07-28 a hook edited mid-flight emitted `markers` as an OBJECT;
        // `.some()` threw, the sync loop caught it, backed off exponentially and
        // froze the operator's board for over an hour. One malformed line must
        // not be able to wedge the control plane — coerce, do not assume.
        const markers = Array.isArray(parsed.markers) ? parsed.markers
          : (parsed.markers && Array.isArray(parsed.markers.markers) ? parsed.markers.markers : []);
        if (parsed.event === 'permission-wait' || markers.some((m) => /^GATE:/i.test(String(m)))) {
          notable = { repo, event: parsed.event, markers, time: parsed.time };
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

/**
 * La tarjeta que el ledger REALMENTE escribio, parseada de su stdout (el CLI
 * imprime `JSON.stringify(task, null, 2)`).
 *
 * T-0296: antes habia dos formas de contestar "en que estado quedo" y ninguna
 * miraba la respuesta completa — `create_task` la scrapeaba con un regex sobre
 * stdout, y el camino de transicion devolvia directamente `target`, o sea el
 * estado que el intent PIDIO. Confundir la intencion con el resultado es lo
 * mismo que T-0293 cerro en el retorno de `update()`, pero una capa mas arriba:
 * en lo que el operador LEE, que es la base de su proxima decision. Y el ledger
 * SI fuerza estados: un kind gateado nace `blocked` sin importar el pedido.
 *
 * Devuelve null cuando no hay JSON legible. Ese null se reporta tal cual: "no
 * se" es honesto, repetir el pedido es inventar, y un estado inventado es peor
 * que ninguno porque el operador no puede distinguirlo de uno medido.
 */
function parseLedgerTask(stdout) {
  const text = String(stdout || '');
  const i = text.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i)); } catch { return null; }
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
      // blocked_by es obligatorio en el ledger (assertBlockedBy, T-0183): una
      // tarea abierta debe declarar a quien espera. Un intent del operador crea
      // trabajo que queda esperando a un AGENTE; si el kind resulta gateado, el
      // ledger mismo lo sobreescribe a 'operator' al forzar el gate.
      const blockedBy = ['operator', 'third_party', 'agent'].includes(p.blocked_by) ? p.blocked_by : 'agent';
      const args = ['create', '--repo', repo, '--kind', p.kind, '--title', p.title, '--goal', goal, '--blocked-by', blockedBy];
      const criteria = Array.isArray(p.acceptance) ? p.acceptance.join(';') : (typeof p.acceptance === 'string' ? p.acceptance : null);
      if (criteria) args.push('--criteria', criteria);
      const r = await runLedger(args);
      if (!r.ok) return { ...base, result: { ...base.result, reason: `ledger create failed: ${r.stderr.slice(0, 300)}` } };
      const created = parseLedgerTask(r.stdout);
      const taskId = created ? created.id : null;
      if (p.kind === 'question' && taskId) {
        appendTaskMessage({
          task_id: taskId,
          message_type: 'operator_question',
          content: [p.title, goal].filter(Boolean).join('\n\n').slice(0, 4000),
          provenance: 'operator',
          sender_name: 'ClawTrol operator',
          intent_id: intent.id,
        });
      }
      return {
        ...base, status: 'applied',
        result: {
          ...base.result, task_id: taskId, task_state: created ? created.state : null,
          ...(p.priority ? { note: 'priority not persisted (ledger v1 has no priority field)' } : {}),
        },
      };
    }
    // message handled above; approve / retry / cancel — FSM transitions on an
    // existing task. Rails may omit payload.task_id and carry the id only in
    // intent.task_origin_key ("...:task:<T-NNNN>").
    const taskId = resolveTaskId(intent);
    if (!taskId) return { ...base, result: { ...base.result, reason: `${intent.kind} requires payload.task_id or a task_origin_key ending :task:<T-NNNN>` } };
    // `retry` apunta a `ready`, NO a `queued` (T-0292). Medido, no elegido por
    // gusto: `queued` no es destino de ninguna arista del FSM, asi que todo
    // retry fallaba con "illegal transition ... (allowed: ready)" — el propio
    // ledger nombraba la respuesta en su mensaje de error.
    //
    // POR QUE `ready` Y NO ABRIR `<estado> -> queued`:
    //  · `ledger.cjs:427` incrementa `attempt` SOLO en failed -> ready, y es el
    //    unico escritor del campo despues de la creacion. clawtrol le devuelve
    //    ese contador al operador (:493) y fleet-status lo renderiza (:103). Un
    //    segundo camino de reintento por `queued` no lo tocaria, asi que los
    //    reintentos del operador quedarian fuera del tablero que este mismo
    //    archivo dibuja — la misma familia de dropper silencioso que T-0282.
    //  · `queued` es el estado de nacimiento (`ledger.cjs:288`) y no tiene
    //    aristas de entrada a proposito: significa "todavia no la triage nadie".
    //    Volver ahi borraria el hecho de que la tarjeta ya fue trabajada.
    //  · Abrir `-> queued` pediria aristas desde 5 estados para no ganar nada:
    //    `dispatchable()` ya toma `ready` y `queued` por igual.
    // Desde `running` sigue rechazando, y esta bien: esa tarjeta tiene dueno.
    const target = intent.kind === 'approve' ? 'ready' : intent.kind === 'retry' ? 'ready' : 'cancelled';
    const r = await runLedger(['update', taskId, '--state', target, '--note', `${intent.kind} via clawtrol intent ${intent.id}`]);
    if (!r.ok || /ledger error/i.test(r.stdout + r.stderr)) {
      return { ...base, result: { ...base.result, reason: `illegal transition or ledger error: ${(r.stderr || r.stdout).slice(0, 300)}` } };
    }
    // T-0293: el ledger ahora DECLARA cuando el estado pedido era el que la
    // tarjeta ya tenia. Sin esto, el operador ve `applied` sobre una tarjeta que
    // no se movio y no tiene forma de saberlo — el silencio que hacia que el
    // retry roto de T-0292 pareciera funcionar justo donde no hacia nada.
    // Sigue siendo `applied` a proposito: pedir un estado que ya se tiene es
    // benigno, y devolver error ahi seria un guard disparando sobre lo correcto.
    // Lo que cambia es que ahora lo DICE.
    // T-0296: el estado se lee de la RESPUESTA, no de `target`. Y el no-op sale
    // de `state_unchanged`, la senal que el ledger declara desde T-0293, en vez
    // de inferirlo con un regex sobre el mismo texto.
    const moved = parseLedgerTask(r.stdout);
    const unchanged = Boolean(moved && moved.state_unchanged === true);
    return {
      ...base,
      status: 'applied',
      result: {
        ...base.result, task_id: taskId, task_state: moved ? moved.state : null,
        ...(unchanged ? { note: `already in "${moved.state}" — nothing moved` } : {}),
      },
    };
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
    // v1 shipped only 4 fields, so the cockpit could show a pane existed but not
    // whether it was about to die of context exhaustion, which model it was
    // burning, or what role it plays. All of these are ALREADY parsed by
    // status-parser.cjs and sat unused — this is copying fields, not new
    // instrumentation. The withholding rule is unchanged and deliberate:
    // never scrollback (lastLines/rawText), never full paths, never env.
    return panes.filter((p) => p.isClaude || p.isCodex).map((p) => ({
      pane_id: p.paneId, agent: p.agent, status: p.status,
      project: p.project ? path.basename(String(p.project)) : null,
      title: p.title || null,
      persona: p.persona || null,
      model: p.model || null,
      ctx: p.ctx ?? null,                 // context-window used %
      session_pct: p.sessionPct ?? null,  // usage-limit %
      weekly_pct: p.weeklyPct ?? null,
      confidence: p.confidence ?? null,   // agent-detection confidence
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
      // The CONTRACT is the most decision-relevant object in the task file and
      // was never sent: the cockpit could show a task was blocked but not that
      // the graph contract blocked it, nor which kind/gate/mode did so. Without
      // this the operator sees an effect with no cause.
      contract: t.contract || null,
      corr: t.corr || null,               // ties a task to its live A2A thread
      context_refs: t.context_refs || [], // the verification/evidence narrative
      created_at: t.created_at || null,
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
  // Digest of the task snapshot the server last ACCEPTED (committed only after
  // res.ok, exactly like cursors — a snapshot that failed to land must never be
  // treated as delivered, or the next identical one would be suppressed and the
  // change would be lost until the reconcile tick).
  // Deliberately in-memory: a daemon restart re-baselines by sending one
  // snapshot, which is the correct behaviour after losing knowledge of server
  // state, and it avoids adding a state file that could itself drift.
  lastTasksDigest: null,
  lastTasksSentTick: 0,
  tasksSent: 0,
  tasksSuppressed: 0,
};

/** Stable digest of the task snapshot — key order is code-determined, so JSON is stable. */
function tasksDigest(tasks) {
  return crypto.createHash('sha1').update(JSON.stringify(tasks)).digest('hex');
}

/**
 * Does this tick owe the server a task snapshot?
 * Forced (an intent was applied, the operator is waiting on the card) and the
 * reconcile cadence both win over suppression; otherwise only a CHANGED
 * snapshot ships.
 */
function shouldSendTasks({ forced, digest, lastDigest, tick, lastSentTick }) {
  if (forced) return true;
  if (digest !== lastDigest) return true;
  return (tick - lastSentTick) >= RECONCILE_EVERY_TICKS;
}

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

async function syncOnce(cfg, { fullSnapshot, forcedTasks = false, notifyOperatorMessage = state.notifyOperatorMessage }) {
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

  // Tasks and panes are decided SEPARATELY. Panes ride every full snapshot as
  // before; tasks ship only when they actually differ from what the server last
  // accepted (or when forced/reconciling) — see RECONCILE_EVERY_TICKS above.
  let tasks = null;
  let digest = null;
  if (fullSnapshot) {
    tasks = buildTasks(cfg.projects);
    digest = tasksDigest(tasks);
    if (!shouldSendTasks({
      forced: forcedTasks,
      digest,
      lastDigest: state.lastTasksDigest,
      tick: state.tick,
      lastSentTick: state.lastTasksSentTick,
    })) {
      tasks = null;                       // unchanged: the server learns nothing from it
      state.tasksSuppressed += 1;
    }
  }

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
    ...(tasks ? { tasks } : {}),
    ...(fullSnapshot ? { panes: await buildPanes() } : {}),
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
  // Same durable-before-ack ordering as cursors: a snapshot counts as delivered
  // ONLY after the server accepted it. Committing the digest on the optimistic
  // path would let a failed POST suppress the retry of a real change.
  if (tasks) {
    state.lastTasksDigest = digest;
    state.lastTasksSentTick = state.tick;
    state.tasksSent += 1;
  }
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
    const forcedTasks = state.forceSnapshot;   // an applied intent owes the operator a card
    const fullSnapshot = state.forceSnapshot || state.tick % SNAPSHOT_EVERY === 1;
    state.forceSnapshot = false;           // consume before the await; re-set below if needed
    const r = await syncOnce(cfg, { fullSnapshot, forcedTasks });
    // Recovery from a SUSTAINED outage is news; recovery from a single blip is
    // not. Without this line an outage had a beginning and no end in the log,
    // so a reader could never tell whether it was still happening.
    if (shouldLogRecovery(state.failures)) {
      process.stdout.write(`[clawtrol-bridge] sync RECOVERED after ${state.failures} consecutive failures\n`);
    }
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
    // The sync stalled TWICE on 2026-07-28 for over an hour each time with ZERO
    // output: failures were counted into state and never printed, so exponential
    // backoff quietly stretched to 5-minute retries while /api/panes kept
    // answering 200. The operator's board silently froze and nothing said so.
    // A background loop that can die without emitting a line is unobservable by
    // construction — so a persistent outage MUST be visible. But logging the
    // FIRST failure made the opposite mistake: this endpoint blips once every
    // few minutes and recovers immediately, so `failures` returned to 0 each
    // time and every isolated blip printed "1 consecutive". Overnight that was
    // ~25 alarming lines about nothing, in the same output where the waker's
    // lines appear — noise that helped hide a real 2h45m outage (audit hole 6).
    // Threshold at the SECOND consecutive failure: a blip the retry already
    // handles is not an event, a sustained outage still is, and recovery is
    // logged above so an outage has an end as well as a beginning.
    if (shouldLogFailure(state.failures)) {
      process.stdout.write(`[clawtrol-bridge] sync FAILING (${state.failures} consecutive, next retry ${Math.round(backoff / 1000)}s, last ok ${state.lastOkAt || 'never'}): ${state.lastError}\n`);
    }
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

/**
 * ClawTrol burial (T-0191, 2026-08-20). The cockpit was retired by operator
 * ruling 2026-08-13 and the bridge kept polling a corpse: 274 consecutive sync
 * failures against a 404, dirtying health on every surface. The burial is a
 * DECISION RECORD, not an env flag: _intel/clawtrol-bridge.json carries a
 * `_disarmed_*` key with the reason and the re-arm condition — the exact
 * convention resolveWakerConfig reads for the orchestrator waker. While the
 * record exists the bridge refuses to arm even with CLAWTROL_URL/TOKEN still
 * exported somewhere; deleting the record (an operator act) restores the old
 * env-driven behavior. Absent or unparseable record → fail-soft, env decides.
 */
function resolveClawtrolDecision({ intelDir: dir, readFile } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let file = null;
  try {
    file = JSON.parse(read(path.join(dir || intelDir(), 'clawtrol-bridge.json')));
  } catch { return { disarmed: false, deliberate: false }; }
  const disarmKey = file && typeof file === 'object'
    ? Object.keys(file).find((k) => k.startsWith('_disarmed'))
    : null;
  if (!disarmKey) return { disarmed: false, deliberate: false };
  return {
    disarmed: true,
    deliberate: true,
    decidedAt: disarmKey.replace(/^_disarmed_?/, '').replace(/_/g, '-') || null,
    decision: String(file[disarmKey]),
    reason: 'disarmed ON PURPOSE — see the decision record in _intel/clawtrol-bridge.json',
  };
}

function start({ notifyOperatorMessage } = {}) {
  // The burial outranks the env: a machine that still exports the creds must
  // not be able to resurrect a bridge the operator buried.
  if (resolveClawtrolDecision().disarmed) return false;
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
  // `running` only means the timer is armed — it stays true through an endless
  // backoff loop. `stalled` is the field a caller should actually assert on: it
  // answers "has this loop done its job recently", which is what an HTTP 200
  // from the host server can never tell you.
  const lastOkMs = state.lastOkAt ? Date.parse(state.lastOkAt) : NaN;
  const staleSeconds = Number.isNaN(lastOkMs) ? null : Math.round((Date.now() - lastOkMs) / 1000);
  return {
    enabled: Boolean(config()),
    running: state.running,
    failures: state.failures,
    last_ok: state.lastOkAt,
    last_error: state.lastError,
    stale_seconds: staleSeconds,
    stalled: state.failures > 0 || staleSeconds === null || staleSeconds > 120,
    // Flood containment, made OBSERVABLE. Without these two counters the fix is
    // unfalsifiable from outside: a suppressed snapshot and a snapshot that was
    // never built look identical. tasks_suppressed climbing while tasks_sent
    // stays flat is the fix working; both flat means the loop is not running.
    tasks_sent: state.tasksSent,
    tasks_suppressed: state.tasksSuppressed,
  };
}

module.exports = {
  start, stop, health, resolveClawtrolDecision,
  // exported for tests
  shouldLogFailure, shouldLogRecovery,
  readDelta, readCursors, writeCursors, toWireEvent, toWireMessage,
  fleetSummary, applyIntent, resolveTaskId, appendTaskMessage,
  appliedIntentIds, persistResult, unackedResults, readAckState,
  writeAckState, readNotifiedState, writeNotifiedState,
  deliverOperatorMessages, syncOnce, buildTasks, buildPanes, INTENT_KINDS, SYNC_FILES,
  // Solid Cable flood containment (2026-08-12) — unchanged snapshots must not ship.
  tasksDigest, shouldSendTasks, RECONCILE_EVERY_TICKS,
  // config() is internal; tests need it to prove the allowlist refresh path.
  __test_config: config,
  FILE_SEQ_BASE, PAYLOAD_FIELDS,
};
