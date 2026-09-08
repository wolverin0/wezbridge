'use strict';
/**
 * project-queue.cjs — durable per-PROJECT A2A queue: _intel/queues/<project>.jsonl.
 * Encola, tailea por cursor y DRENA con entrega verificada: desde W4 el
 * veredicto es classifyDelivery (verified-send.cjs) y 'unverified' NO cuenta
 * como entrega. Desde W2 un type=result drenado se registra en
 * a2a-results.jsonl, salvo que el emisor ya lo haya marcado `recorded: true`.
 *
 * B1 (2026-08-22): `a2a_send {to_project}` resolves the pane via pane-identity
 * AT SEND TIME and ALWAYS appends a durable record here — delivery failure means
 * retry by a deterministic consumer, not a lost message. This kills the
 * "pane-8/pane-24" misroute class: nobody stores pane ids across sessions.
 *
 * The mechanics are the PROVEN queue idiom of src/orchestrator-waker.cjs,
 * generalized rather than re-invented (that was the plan's golden rule):
 *   - durable JSONL tailed from a byte cursor, tail-hash rotation detection
 *   - sha1 id dedupe against pending map + delivered ring
 *   - tmp+rename atomic state writes (cursor/pending/delivered/flags files)
 *   - attempt cap + flag-and-stop (capped entries are FLAGGED, never retried)
 *   - cooldown between delivery attempts
 *   - anti-replay: entries older than maxAgeMs are expired at ingest, so a
 *     wiped state dir can never replay ancient history into a live pane
 *     (the waker starts its cursor at EOF for the same reason; a queue must
 *     stay retryable from line one, so age is the guard here instead)
 *
 * The consumer is createConsumer(...).drain() — a ONE-PASS deterministic drain
 * driven by scripts/queue-drain.cjs (cron-able). No timer loop lives here on
 * purpose: this module must never become always-on coordinator iteration #7.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { intelDir, updateThreads, autoAckResult, recordResultBody } = require('./a2a-intel.cjs');
const { logAction } = require('./action-log.cjs');
const { classifyDelivery } = require('./verified-send.cjs');
const { decisionDisposition, queuedDecision } = require('./decision-authority.cjs');

const DEFAULTS = {
  maxAttempts: 3, // per entry; cap reached -> flagged and dropped, never retried
  cooldownMs: 5 * 60 * 1000, // between delivery attempts per project
  maxAgeMs: 24 * 60 * 60 * 1000, // entries older than this expire at ingest
  deliveredKeep: 500, // delivered-id ring buffer size
};

/** Queue files live under <intel>/queues; consumer state under queues/state/<project>/. */
function queuesDir(base) {
  return path.join(base || intelDir(), 'queues');
}

/** A project name becomes a filename — keep it boring. Dot-only names (".",
 * "..") would escape the queues dir as path segments; they are not projects. */
function sanitizeProject(project) {
  const name = String(project || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return !name || /^\.+$/.test(name) ? null : name;
}

function queueFile(project, base) {
  const name = sanitizeProject(project);
  return name ? path.join(queuesDir(base), `${name}.jsonl`) : null;
}

/**
 * Stable id for one logical message: same sender + corr + type + body dedupes,
 * a changed body is a NEW message. Time is deliberately excluded — including it
 * would make every enqueue unique and the dedupe permanently inert.
 */
function entryId(entry) {
  const bodyHash = crypto.createHash('sha1').update(String(entry.body || '')).digest('hex');
  return crypto.createHash('sha1')
    .update(`${entry.project}|${entry.corr || ''}|${entry.type || ''}|${entry.from_pane ?? ''}|${bodyHash}`)
    .digest('hex').slice(0, 16);
}

/**
 * Append one durable record. ALWAYS called for to_project sends, whatever the
 * delivery outcome — `ok:false` lines are the consumer's retry work-list.
 * Never throws (fail-soft: the queue must never break the delivery it records).
 * Returns { ok, id, file } — ok:false means the append itself failed.
 */
function enqueue(entry, { base } = {}) {
  try {
    // Fail-closed on empty body (T-0221): a message with no body is a caller
    // bug — the first two real dispatches passed `envelope:` instead of
    // `body:`, the lenient String(entry.body || '') swallowed it, and both
    // deliveries arrived as a bare header. Silent-empty is the dropper class
    // this control plane exists to kill, so refuse the write and say why.
    if (!entry.body || !String(entry.body).trim()) {
      return { ok: false, id: null, file: null, error: 'body required — got empty (did you pass `envelope:` instead of `body:`?)' };
    }
    const file = queueFile(entry.project, base);
    if (!file) return { ok: false, id: null, file: null };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = entryId(entry);
    const line = JSON.stringify({
      id,
      time: new Date().toISOString(),
      project: entry.project,
      corr: entry.corr,
      type: entry.type,
      from_pane: entry.from_pane,
      // T-0405: emisores sin pane (decision-relay, orquestador headless) se nombran
      // por proyecto; sin este campo el drenaje escribia "[A2A from pane-null ...]".
      from_project: entry.from_project ?? null,
      // T-0329a: el ruling viaja para que queue-drain emita decision.delivered.
      ...(entry.ruling ? { ruling: entry.ruling } : {}),
      ...(entry.decision_at ? { decision_at: entry.decision_at } : {}),
      resolved_pane: entry.resolved_pane ?? null,
      submitted: entry.submitted ?? null,
      delivered: entry.delivered ?? null,
      ok: !!entry.ok,
      // W2: el emisor (mcp-server) ya escribio este result en a2a-results.jsonl
      // al encolar. La marca viaja con la linea para que el drenaje NO lo
      // registre otra vez — el linker leeria el mismo result dos veces.
      ...(entry.recorded ? { recorded: true } : {}),
      body: String(entry.body || ''),
    });
    fs.appendFileSync(file, line + '\n');
    return { ok: true, id, file };
  } catch {
    return { ok: false, id: null, file: null };
  }
}

/**
 * T-0233: rescue an envelope whose TRANSPORT threw. Before this, only
 * to_project sends were durable — a to_pane send that hit ETIMEDOUT vanished
 * with no queue line anywhere (verified 2026-08-23 by yolo26, mm-455f: two
 * consecutive failures, zero entries in any queue; the result survived only
 * because the sender retried by hand — 5 more manual retries that same night).
 *
 * Pure-ish (enqueueFn injectable): resolves the destination PROJECT from the
 * census when the caller addressed a bare pane; unresolvable destinations go
 * to the visible `_dead-letter` queue, where the fleet-sensor's >30min flag is
 * the "needs a human look" — visible-but-stuck beats silent-and-gone.
 * Returns { queued, project, id | error }.
 */
function rescueFailedSend({ toProject, toPane, census, corr, type, fromPane, body }, enqueueFn = enqueue) {
  let project = toProject || null;
  if (!project && Array.isArray(census)) {
    const hit = census.find((p) => p.pane_id === toPane);
    if (hit && hit.cwd) {
      const parts = String(hit.cwd).replace(/^file:\/\/\/?/, '').replace(/%20/g, ' ').replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
      project = parts.length ? parts[parts.length - 1] : null;
    }
  }
  const q = enqueueFn({
    project: project || '_dead-letter',
    corr, type, from_pane: fromPane,
    resolved_pane: toPane ?? null, submitted: null, delivered: null, ok: false, body,
  });
  return q.ok
    ? { queued: true, project: project || '_dead-letter', id: q.id }
    : { queued: false, project: project || '_dead-letter', error: q.error || 'queue append failed' };
}

// ── atomic state helpers (verbatim idiom from orchestrator-waker.cjs) ────────

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * One-pass deterministic consumer for a single project queue.
 *
 * deps:
 *   project        — canonical project name (queue file + resolution key)
 *   discoverPanes  — () => pane-discovery style list (agent/status/project/…)
 *   send           — { sendPromptDeferredEnter, verifyPromptSubmission }
 *   base           — intel dir override (tests); defaults to intelDir()
 *   resolveTarget  — optional (panes) => paneId|null override
 *   log, now       — injectable for tests
 */
function createConsumer(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const {
    project, discoverPanes, send, log = () => {}, now = () => Date.now(),
    logAction: logActionFn = logAction, // injectable: tests must not write the real actions.jsonl
  } = cfg;
  if (!project || !discoverPanes || !send) {
    throw new Error('project-queue consumer: project, discoverPanes and send are required');
  }
  const base = cfg.base || intelDir();
  const qFile = queueFile(project, base);
  const stateDir = path.join(queuesDir(base), 'state', sanitizeProject(project));
  const FILES = {
    cursor: path.join(stateDir, 'cursor.json'),
    pending: path.join(stateDir, 'pending.json'),
    delivered: path.join(stateDir, 'delivered.json'),
    flags: path.join(stateDir, 'flags.json'),
    suppressed: path.join(stateDir, 'suppressed.json'),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  // T-0329a: decision.delivered lo emite quien ENTREGA — un sobre entregado por
  // la cola tiene que ser OIDO por el gate (antes solo lo emitia el relay).
  const recordEvent = (evt) => {
    try { fs.appendFileSync(path.join(base, 'events.jsonl'), `${JSON.stringify({ time: new Date(now()).toISOString(), ...evt })}
`); } catch { /* fail-soft */ }
  };

  const savedCursor = readJson(FILES.cursor, { bytes: 0, tail: null });
  const state = {
    cursorBytes: savedCursor.bytes,
    cursorTail: savedCursor.tail, // { len, hash } | null — rotation fingerprint
    pending: readJson(FILES.pending, {}), // id -> {entry fields + attempts}
    delivered: readJson(FILES.delivered, []), // ring of entry ids
    suppressed: readJson(FILES.suppressed, {}), // terminal discards/obsolete decisions, never delivery evidence
    lastAttemptAt: undefined, // in-memory; cron cadence is the real spacing
  };
  const deliveredSet = new Set(state.delivered);

  function persistPending() { atomicWriteJson(FILES.pending, state.pending); }
  function persistCursor() { atomicWriteJson(FILES.cursor, { bytes: state.cursorBytes, tail: state.cursorTail }); }
  function persistDelivered() {
    state.delivered = state.delivered.slice(-cfg.deliveredKeep);
    atomicWriteJson(FILES.delivered, state.delivered);
  }
  function flagCapExhausted(id, entry) {
    const flags = readJson(FILES.flags, {});
    flags[id] = { ...entry, flagged_at: new Date(now()).toISOString(), reason: 'attempt cap reached — undeliverable, needs a human look' };
    atomicWriteJson(FILES.flags, flags);
  }

  function tailMatches(fd) {
    if (!state.cursorTail || state.cursorTail.len > state.cursorBytes) return true;
    const { len, hash } = state.cursorTail;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.cursorBytes - len);
    return crypto.createHash('sha1').update(buf).digest('hex') === hash;
  }

  // ── 1. ingest: new queue lines since cursor -> pending (retry work-list) ──
  function ingest() {
    let stat;
    try { stat = fs.statSync(qFile); } catch { return { added: 0 }; } // no queue file yet
    if (stat.size < state.cursorBytes) { state.cursorBytes = 0; state.cursorTail = null; }
    const fd = fs.openSync(qFile, 'r');
    let chunk;
    try {
      if (state.cursorBytes > 0 && !tailMatches(fd)) {
        log(`project-queue[${project}]: queue file rotated (tail mismatch) — cursor reset`);
        state.cursorBytes = 0;
        state.cursorTail = null;
      }
      if (stat.size === state.cursorBytes) return { added: 0 };
      const len = stat.size - state.cursorBytes;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.cursorBytes);
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return { added: 0 }; // partial line stays for next pass
    const consumed = lastNewline + 1;
    let added = 0;
    let expired = 0;
    for (const line of chunk.slice(0, consumed).split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // corrupt line: skip, never crash
      const id = entry.id || entryId(entry);
      if (entry.ok) { // delivered & verified at send time — nothing to retry
        if (!deliveredSet.has(id)) { deliveredSet.add(id); state.delivered.push(id); }
        // A later verified re-send supersedes an earlier failed line of the
        // same logical message — without this, the pending copy re-delivers.
        if (state.pending[id]) { delete state.pending[id]; persistPending(); }
        continue;
      }
      if (deliveredSet.has(id) || state.pending[id] || state.suppressed[id]) continue; // sha1 dedupe
      const t = Date.parse(entry.time || '');
      if (!Number.isNaN(t) && now() - t > cfg.maxAgeMs) {
        // Anti-replay: never resurrect ancient failures into a live pane.
        deliveredSet.add(id); state.delivered.push(id); expired += 1;
        continue;
      }
      state.pending[id] = {
        project: entry.project || project,
        corr: entry.corr, type: entry.type, from_pane: entry.from_pane, from_project: entry.from_project ?? null,
        body: entry.body, time: entry.time, attempts: 0,
        ...(entry.ruling ? { ruling: entry.ruling } : {}),
        ...(entry.decision_at ? { decision_at: entry.decision_at } : {}),
        ...(entry.recorded ? { recorded: true } : {}),
      };
      added += 1;
    }
    // Order matters (waker rule): pending first, cursor second. A crash between
    // the two re-reads the same lines and the id-dedupe absorbs them.
    if (added) persistPending();
    if (expired || added) persistDelivered();
    // T-0314: mismo defecto que el waker — el cursor es una posicion en BYTES y
    // `consumed` cuenta caracteres. Con sobres con acentos, cada pasada de
    // queue-drain veia "archivo rotado", reseteaba a 0 y re-ingestaba entradas
    // ya entregadas (5 replays del mismo request el 2026-09-02). Bytes.
    const consumedBytes = Buffer.from(chunk.slice(0, consumed), 'utf8');
    state.cursorBytes += consumedBytes.length;
    const fpLen = Math.min(consumedBytes.length, 256);
    state.cursorTail = {
      len: fpLen,
      hash: crypto.createHash('sha1').update(consumedBytes.subarray(consumedBytes.length - fpLen)).digest('hex'),
    };
    persistCursor();
    if (added) log(`project-queue[${project}]: ${added} undelivered entr(y/ies) pending`);
    if (expired) log(`project-queue[${project}]: ${expired} entr(y/ies) expired (older than maxAgeMs) — not replayed`);
    return { added, expired };
  }

  // ── 2. target: re-resolve the project's pane AT DELIVERY TIME ────────────
  function findTarget(panes, destination) {
    const { resolve, projectFromCwd } = require('./pane-identity.cjs');
    const canonical = projectFromCwd(destination);
    const mapped = (panes || [])
      .filter((p) => p.agent) // agent panes only — the daemon's shell shares cwds
      .map((p) => ({
        pane_id: p.paneId ?? p.pane_id,
        cwd: p.project || p.cwd || null,
        tab_title: p.tabTitle || p.title || null,
      }));
    const hit = resolve(canonical, mapped);
    // A restored tab can retain another project's title. Only a matching cwd
    // proves that this live pane owns the queued destination.
    if (hit.matchedBy !== 'cwd') return { paneId: null, missing: true };
    if (cfg.resolveTarget) {
      const paneId = cfg.resolveTarget(panes);
      const chosen = mapped.find(pane => pane.pane_id === paneId);
      return { paneId: chosen && String(projectFromCwd(chosen.cwd)).toLowerCase() === String(canonical).toLowerCase()
        ? paneId : null, missing: false };
    }
    if (hit.paneId === null || hit.ambiguous.length) {
      log(`project-queue[${project}]: ${hit.warning} — not delivering this pass`);
      return { paneId: null, missing: false };
    }
    return { paneId: hit.paneId, missing: false };
  }

  /** Durable discard, with audit retry after interruption; never a delivery receipt. */
  function dropEntry(id, entry, reason) {
    let drop = state.suppressed[id];
    if (drop?.event !== 'queue.entry_dropped') {
      drop = { event: 'queue.entry_dropped', id, project: entry.project || project,
        corr: entry.corr, reason, time: new Date(now()).toISOString(), reported: false };
      state.suppressed = { ...state.suppressed, [id]: drop };
      atomicWriteJson(FILES.suppressed, state.suppressed);
    }
    if (!drop.reported) {
      // Unlike advisory events, this audit is mandatory. A failed append
      // leaves the tombstone and pending entry for retry, never for sending.
      const { reported, ...event } = drop;
      fs.appendFileSync(path.join(base, 'events.jsonl'), JSON.stringify(event) + '\n');
      state.suppressed = { ...state.suppressed, [id]: { ...drop, reported: true } };
      atomicWriteJson(FILES.suppressed, state.suppressed);
    }
    clearDecisionHold(id);
    state.pending = Object.fromEntries(Object.entries(state.pending).filter(([key]) => key !== id));
    persistPending();
    log(`project-queue[${project}]: entry ${id} dropped: ${drop.reason}`);
  }

  // ── 3. deliver: pending entries, verified, capped, cooled down ───────────
  function clearDecisionHold(id) {
    const flags = readJson(FILES.flags, {});
    if (!flags[id]?.decision_held) return;
    const { [id]: removed, ...remaining } = flags;
    atomicWriteJson(FILES.flags, remaining);
  }

  function screenDecision(id, entry) {
    const decision = queuedDecision(entry);
    if (!decision) return { allowed: true, flagged: 0 };
    const verdict = decision.invalid ? { status: 'unknown', reason: 'decision-body-metadata-mismatch' }
      : decisionDisposition({ intel: base, ...decision });
    if (verdict.status === 'allow') { clearDecisionHold(id); return { allowed: true, flagged: 0 }; }
    if (verdict.status === 'superseded') {
      clearDecisionHold(id);
      state.suppressed = { ...state.suppressed, [id]: { reason: verdict.reason, at: new Date(now()).toISOString() } };
      atomicWriteJson(FILES.suppressed, state.suppressed);
      delete state.pending[id];
      persistPending();
      recordEvent({ event: 'decision.suppressed', task: entry.corr, project, id, reason: verdict.reason });
      return { allowed: false, flagged: 0 };
    }
    const flags = readJson(FILES.flags, {});
    const fresh = flags[id]?.reason !== verdict.reason;
    if (fresh) {
      atomicWriteJson(FILES.flags, { ...flags, [id]: { ...entry, decision_held: true, reason: verdict.reason, flagged_at: new Date(now()).toISOString() } });
      recordEvent({ event: 'decision.held', task: entry.corr, project, id, reason: verdict.reason });
    }
    return { allowed: false, flagged: fresh ? 1 : 0 };
  }

  async function deliverPending({ dryRun = false } = {}) {
    const ids = Object.keys(state.pending);
    if (!ids.length) return { delivered: 0, flagged: 0, skipped: 0 };
    if (dryRun) return { delivered: 0, flagged: 0, skipped: ids.length, wouldDeliver: ids.length };

    // T-0242/AC6: el pane esta idle PERO su composer retiene texto que todavia
    // no envio (tipico: el operador escribio y no dio Enter). Entregar aca no
    // manda el sobre — manda "su texto + el sobre" concatenados como un solo
    // prompt. Se difiere igual que con un pane ocupado: sin consumir intentos
    // ni cooldown, asi la entrega se reanuda sola en el proximo drain cuando el
    // composer se vacie.
    //
    // El log NO es decorativo: es como se descubre un placeholder de TUI nuevo
    // que el predicado todavia no conoce. Un diferimiento silencioso se ve
    // igual que una cola vacia.
    //
    // Fail-open si el `send` inyectado no trae el helper (fakes de tests
    // viejos): un guard que no puede medir no puede frenar.

    // Cooldown (waker rule): undefined = never attempted, never blocked.
    if (state.lastAttemptAt !== undefined && now() - state.lastAttemptAt < cfg.cooldownMs) {
      return { delivered: 0, flagged: 0, skipped: ids.length };
    }
    let delivered = 0;
    let flagged = 0;
    let dropped = 0;
    for (const id of ids) {
      const entry = state.pending[id];
      if (!entry) continue;
      if (state.suppressed[id]?.event === 'queue.entry_dropped') {
        dropEntry(id, entry, state.suppressed[id].reason); dropped += 1; continue;
      }
      let panes;
      try {
        panes = discoverPanes();
        if (!Array.isArray(panes)) throw new Error('invalid pane census');
      } catch (err) { log(`project-queue[${project}]: discovery failed: ${err.message}`); break; }
      const destination = entry.project || project;
      const targetHit = findTarget(panes, destination);
      if (targetHit.missing) { dropEntry(id, entry, 'project-not-live'); dropped += 1; continue; }
      const targetId = targetHit.paneId;
      const target = panes.find(pane => (pane.paneId ?? pane.pane_id) === targetId);
      if (!target || target.status !== 'idle') break;
      if (typeof send.paneComposerHoldsForeignText === 'function'
          && send.paneComposerHoldsForeignText(targetId)) {
        log(`project-queue[${project}]: pane-${targetId} idle pero su composer retiene texto sin enviar `
          + `— difiriendo ${Object.keys(state.pending).length} entrada(s), reintento en el proximo drain`);
        return { delivered, flagged, dropped, skipped: Object.keys(state.pending).length,
          deferredComposer: Object.keys(state.pending).length };
      }
      const decision = screenDecision(id, entry);
      flagged += decision.flagged;
      if (!decision.allowed) continue;
      // Envelope is REBUILT with the pane resolved NOW — the pane the original
      // send saw may be long dead; the project is the durable address.
      // El destino se direcciona por NOMBRE, que es lo unico estable: esta cola
      // ES por proyecto, y el pane que la drena se resolvio recien. Poner el
      // pane-id aca era doblemente enganoso — el numero cambia entre espacios
      // MCP/CLI Y el pane resuelto hoy no es el que vio el emisor original.
      const envelope = require('./a2a-intel.cjs').buildEnvelope({
        fromPane: entry.from_pane,
        fromProject: entry.from_project,
        toPane: targetId,
        toProject: destination,
        corr: entry.corr,
        type: entry.type,
        body: entry.body,
      });
      let ok = false;
      let submitted = 'unknown';
      let integrity = 'unknown';
      state.lastAttemptAt = now();
      try {
        integrity = await send.sendPromptDeferredEnter(targetId, envelope);
        // T-0323: el pre-chequeo corre por sobre; la primitiva
        // vuelve a mirar antes de escribir (el operador pudo tipear entre medio) y
        // rehusa sin escribir. Sin verify: reintentaria Enter sobre ese texto.
        if (integrity && integrity.refused) {
          log(`project-queue[${project}]: pane-${targetId} composer retiene texto sin enviar ${JSON.stringify(String(integrity.held).slice(0, 60))} — sobre ${id} diferido`);
        } else {
          submitted = await send.verifyPromptSubmission(targetId, envelope);
        }
        // W4, gemelo del waker: un send que NO se pudo verificar no es una
        // entrega. La regla vive una sola vez, en verified-send.cjs. Aca
        // 'unverified' se trata como fallo (reintento con cooldown y cap), que
        // es la postura correcta para la ULTIMA copia durable de un sobre.
        ok = classifyDelivery(integrity, submitted) === 'delivered';
      } catch (err) {
        log(`project-queue[${project}]: send failed: ${err.message}`);
      }
      // T-0329c: submit no verificado PERO el cuerpo ya en el pane = aterrizo,
      // falso negativo. Se cuenta entregado en vez de reintentar y duplicar.
      if (!ok && (integrity == null || !integrity.refused)
          && typeof send.paneShowsSubmittedBody === 'function'
          && send.paneShowsSubmittedBody(targetId, entry.body)) {
        log(`project-queue[${project}]: sobre ${id} ya visible en pane-${targetId} (submit falso-negativo) — entregado sin reintentar`);
        ok = true;
        submitted = 'submitted';
      }
      if (ok) {
        delete state.pending[id];
        deliveredSet.add(id);
        state.delivered.push(id);
        persistPending(); persistDelivered();
        delivered += 1;
        if (entry.from_project === 'decision-relay' && entry.ruling) {
          recordEvent({ event: 'decision.delivered', task: entry.corr, project, pane: targetId, ruling: entry.ruling });
        }
        logActionFn('queue_deliver', {
          target: `pane-${targetId}`,
          why: `corr=${entry.corr}`,
          extra: { project, type: entry.type, id, attempts: entry.attempts + 1 },
        });
        // Keep the advisory thread state consistent with what actually reached
        // the pane, then automate the bookkeeping acuse for verified results —
        // same rule as the live a2a_send path (judgement ack stays human).
        try {
          // W2: un result que viaja por la cola tambien tiene que aterrizar en
          // a2a-results.jsonl. La rama `to_project` sin pane vivo retornaba
          // ANTES de recordResultBody, asi que el sobre drenado no dejaba
          // rastro: el linker no podia mover la tarjeta de un result que, para
          // el archivo de resultados, nunca existio. `recorded` es la marca del
          // emisor: si ya lo escribio al encolar, aca no se duplica.
          if (entry.type === 'result' && entry.recorded !== true) {
            recordResultBody({ corr: entry.corr, fromPane: entry.from_pane, toPane: targetId, v2: require('./a2a-intel.cjs').detectV2(entry.body), body: entry.body });
          }
          updateThreads({ fromPane: entry.from_pane, toPane: targetId, corr: entry.corr, type: entry.type, body: entry.body });
          if (entry.type === 'result' && submitted === 'submitted' && autoAckResult({ corr: entry.corr, byPane: entry.from_pane })) {
            logActionFn('auto_ack', { target: `corr=${entry.corr}`, why: 'verified queue redelivery of type=result — bookkeeping acuse automated (B1)' });
          }
        } catch { /* advisory — never breaks the drain */ }
      } else {
        entry.attempts += 1;
        if (entry.attempts >= cfg.maxAttempts) {
          flagCapExhausted(id, entry);
          delete state.pending[id];
          flagged += 1;
        }
        persistPending();
        // One failed attempt ends the pass for this project: the pane is not
        // accepting input — hammering the rest of the queue at it helps nobody.
        break;
      }
    }
    if (delivered) log(`project-queue[${project}]: delivered ${delivered} entr(y/ies) using current project identity`);
    if (flagged) log(`project-queue[${project}]: ${flagged} entr(y/ies) hit the attempt cap and were FLAGGED`);
    return { delivered, flagged, dropped, skipped: Object.keys(state.pending).length };
  }

  /** One pass: finish discard audits, ingest, then resolve each current destination. */
  async function drain({ dryRun = false } = {}) {
    let recoveredDrops = 0;
    if (!dryRun) for (const [id, drop] of Object.entries(state.suppressed)) {
      if (drop.event !== 'queue.entry_dropped' || drop.reported) continue;
      dropEntry(id, state.pending[id] || drop, drop.reason);
      recoveredDrops += 1;
    }
    const ingested = dryRun ? { added: 0 } : ingest();
    const outcome = await deliverPending({ dryRun });
    return { project, ...ingested, ...outcome, dropped: (outcome.dropped || 0) + recoveredDrops,
      pending: Object.keys(state.pending).length };
  }

  function status() {
    let pendingOldestMinutes = 0;
    for (const e of Object.values(state.pending)) {
      const t = Date.parse(e.time || '');
      if (!Number.isNaN(t)) pendingOldestMinutes = Math.max(pendingOldestMinutes, Math.round((now() - t) / 60000));
    }
    return {
      project,
      pending: Object.keys(state.pending).length,
      pendingOldestMinutes,
      flagged: Object.keys(readJson(FILES.flags, {})).length,
      cursorBytes: state.cursorBytes,
    };
  }

  return { drain, ingest, status, _state: state, _files: FILES };
}

/** All projects that currently have a queue file. */
function listQueues({ base } = {}) {
  try {
    return fs.readdirSync(queuesDir(base))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.replace(/\.jsonl$/, ''));
  } catch { return []; }
}

module.exports = { DEFAULTS, entryId, enqueue, queueFile, queuesDir, sanitizeProject, createConsumer, listQueues, rescueFailedSend };
