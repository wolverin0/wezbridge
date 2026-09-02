'use strict';
/**
 * decision-relay.cjs — W3: el relay que lleva la decision del operador al pane
 * que trabaja la tarjeta. Tail de `_intel/rulings.jsonl` desde un cursor de
 * bytes, ingesta SOLO `approved|cancelled` sobre `^T-\d{4}$` con `at >= EPOCH`
 * (las 338 lineas legacy no se re-entregan nunca), resuelve el worker por la
 * tarjeta (`lease.owner = eve:<jobId>` => cola `finalorchestra` con la llamada
 * exacta + `ledger update --next`; si no, `card.repo`), entrega SOLO con send
 * verificado y SIEMPRE encola durable. Estado en `<intel>/.decision-relay/`.
 * Eventos: `decision.delivered|queued|undeliverable`. Leer junto a
 * scripts/decision-relay.cjs y scripts/fleet-drill.cjs check 5.
 *
 * POR QUE EXISTE. El operador aprobaba una tarjeta en el tablero y la decision
 * moria en `rulings.jsonl`: el pane que la trabajaba no se enteraba nunca. El
 * loop tenia un tramo sin cable justo en el unico salto que solo el humano
 * puede dar. Este modulo es ese cable, y es deliberadamente un one-pass
 * determinista (cron-able / llamable inline) y NO un loop always-on: la
 * mecanica de cursor + dedupe + cap + cooldown es la de orchestrator-waker.cjs
 * y project-queue.cjs, generalizada, no reinventada.
 *
 * DOS DECISIONES QUE NO SON OBVIAS:
 *
 *  1. EPOCH en vez de "cursor arranca en EOF". Arrancar en EOF hace que la
 *     PRIMERA corrida sea ciega a la decision que la disparo — exactamente el
 *     caso del drill, y del tablero llamando `relayOnce()` justo despues de
 *     escribir el ruling. Filtrar por `at >= EPOCH` da la misma garantia (nada
 *     legacy se replica) sin ese agujero, y no necesita un caso especial para
 *     el drill. El cursor se persiste igual: es lo que evita re-leer el archivo
 *     entero en cada pasada, no lo que evita el replay.
 *
 *  2. `unknown` NO es entrega. La verificacion vive en
 *     verified-send.classifyDelivery y solo `delivered` cuenta. Un pane que no
 *     se pudo leer es un pane al que no sabemos si le llego: se encola y lo
 *     reintenta queue-drain. Un instrumento que informa exito sobre algo que no
 *     pudo mirar es peor que no tener instrumento.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { buildEnvelope } = require('./a2a-intel.cjs');
const { enqueue } = require('./project-queue.cjs');
const { resolve: resolvePane } = require('./pane-identity.cjs');
const { composerHoldsForeignText, classifyDelivery } = require('./verified-send.cjs');

/**
 * Ninguna decision anterior a este instante se relaya. Es una constante, no una
 * config: moverla hacia atras re-entrega historia a panes vivos.
 */
const EPOCH = '2026-09-01T00:00:00Z';
const EPOCH_MS = Date.parse(EPOCH);

/** Solo las dos que RESPONDEN al operador. `dispatched`/`deferred`/... son del orquestador. */
const RELAYED_RULINGS = ['approved', 'cancelled'];
/** Una tarjeta, no un corr: `T-0004:sub` es un hilo, no algo que tenga dueno. */
const TASK_ID_RE = /^T-\d{4}$/;
/** El proyecto al que se le habla cuando el dueno de la lease es Eve. */
const EVE_PROJECT = 'finalorchestra';
const EVE_OWNER_PREFIX = 'eve:';
const BODY_CAP = 1200;

const DEFAULTS = {
  maxAttempts: 3,
  cooldownMs: 5 * 60 * 1000,
  deliveredKeep: 500,
};

// ── utilidades de estado (idioma de project-queue.cjs) ─────────────────────
function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** El `why` entra en una llamada entre comillas: las comillas y los saltos no. */
function quotable(why, cap = 160) {
  const s = clean(why).replace(/["\\]/g, "'");
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : (s || 'sin motivo declarado');
}

/**
 * La llamada EXACTA que cierra el job de Eve. Se nombra literal a proposito:
 * "aprobala en FinalOrchestra" manda al humano a buscar el verbo; esto se
 * copia y se pega.
 */
function eveCall(ruling, jobId, why) {
  return ruling === 'cancelled'
    ? `task_cancel ${jobId} "${quotable(why)}"`
    : `task_answer ${jobId} "approved: ${quotable(why)}"`;
}

/**
 * El cuerpo que ve el worker. El `why` es lo unico que se recorta: el
 * next_action (que puede ser la llamada a Eve) tiene que sobrevivir al cap
 * entero, o el sobre llega sin la unica linea accionable que traia.
 */
function buildBody({ task, ruling, why, source, card, nextAction }) {
  const gate = (card && card.contract && card.contract.gate) || (card && card.gate) || null;
  const head = `[decision] operator ${ruling} ${task}: `;
  const tail = ` (source=${source || 'hand'}). Tarjeta ahora ${(card && card.state) || '?'}`
    + `, gate=${gate || 'none'}. next_action: ${nextAction}`;
  const budget = Math.max(40, BODY_CAP - head.length - tail.length);
  const w = clean(why) || '(sin motivo)';
  const trimmed = w.length > budget ? `${w.slice(0, budget - 1)}…` : w;
  const body = head + trimmed + tail;
  return body.length > BODY_CAP ? `${body.slice(0, BODY_CAP - 1)}…` : body;
}

/**
 * createRelay(deps) — one-pass determinista. Nunca lanza desde relayOnce().
 *
 * deps:
 *   intelDir       — raiz de _intel (obligatorio: este modulo nunca adivina el real)
 *   discoverPanes  — () => panes estilo pane-discovery
 *   send           — { sendPromptDeferredEnter, verifyPromptSubmission }
 *   runLedger      — (argv[]) => any, para `update <T> --next <llamada>`
 *   now, log, maxAttempts, cooldownMs, sinceBytes
 */
function createRelay(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const {
    intelDir, discoverPanes, send, runLedger,
    now = Date.now, log = () => {},
  } = cfg;
  if (!intelDir) throw new Error('decision-relay: intelDir is required — this module never guesses the live _intel');

  const rulingsPath = path.join(intelDir, 'rulings.jsonl');
  const eventsPath = path.join(intelDir, 'events.jsonl');
  const tasksDir = path.join(intelDir, 'tasks');
  const stateDir = path.join(intelDir, '.decision-relay');
  fs.mkdirSync(stateDir, { recursive: true });
  const FILES = {
    cursor: path.join(stateDir, 'cursor.json'),
    pending: path.join(stateDir, 'pending.json'),
    delivered: path.join(stateDir, 'delivered.json'),
    flags: path.join(stateDir, 'flags.json'),
    epoch: path.join(stateDir, 'epoch.json'),
  };

  // Primera corrida: se arranca en el offset declarado (epoch.json o sinceBytes)
  // o en 0. Escanear desde 0 es seguro porque el filtro real es `at >= EPOCH`.
  let savedCursor = readJson(FILES.cursor, null);
  if (!savedCursor) {
    const declared = readJson(FILES.epoch, null);
    const bytes = Number.isInteger(declared && declared.bytes) ? declared.bytes
      : (Number.isInteger(cfg.sinceBytes) ? cfg.sinceBytes : 0);
    savedCursor = { bytes, tail: null };
  }

  const state = {
    cursorBytes: savedCursor.bytes,
    cursorTail: savedCursor.tail, // { len, hash } — huella de rotacion/truncado
    pending: readJson(FILES.pending, {}), // id -> { task, ruling, why, at, source, attempts, notified, ledgerNexted }
    delivered: readJson(FILES.delivered, []), // ring de ids ya resueltos
    lastAttemptAt: {}, // project -> ms. En memoria a proposito (regla del waker):
    // un reinicio que reintenta antes de tiempo es seguro; un cooldown persistido
    // dejaria una decision fresca esperando cinco minutos por una vieja.
  };
  const deliveredSet = new Set(state.delivered);

  const persistPending = () => atomicWriteJson(FILES.pending, state.pending);
  const persistCursor = () => atomicWriteJson(FILES.cursor, { bytes: state.cursorBytes, tail: state.cursorTail });
  function persistDelivered() {
    state.delivered = state.delivered.slice(-cfg.deliveredKeep);
    atomicWriteJson(FILES.delivered, state.delivered);
  }
  function markResolved(id) {
    if (!deliveredSet.has(id)) { deliveredSet.add(id); state.delivered.push(id); }
    delete state.pending[id];
    persistPending(); persistDelivered();
  }
  function flagCapExhausted(id, entry, reason) {
    const flags = readJson(FILES.flags, {});
    flags[id] = { ...entry, flagged_at: new Date(now()).toISOString(), reason };
    atomicWriteJson(FILES.flags, flags);
  }

  /** events.jsonl es metadata: nunca lleva el cuerpo del sobre. Nunca lanza. */
  function recordEvent(evt) {
    try {
      fs.appendFileSync(eventsPath, `${JSON.stringify({ time: new Date(now()).toISOString(), ...evt })}\n`);
    } catch { /* fail-soft: un evento perdido no puede romper una entrega */ }
  }

  function tailMatches(fd) {
    if (!state.cursorTail || state.cursorTail.len > state.cursorBytes) return true;
    const { len, hash } = state.cursorTail;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.cursorBytes - len);
    return sha1(buf) === hash;
  }

  // ── 1. ingesta: lineas nuevas de rulings.jsonl -> pending ────────────────
  function ingest() {
    let stat;
    try { stat = fs.statSync(rulingsPath); } catch { return 0; }
    if (stat.size < state.cursorBytes) { state.cursorBytes = 0; state.cursorTail = null; }
    let chunk;
    const fd = fs.openSync(rulingsPath, 'r');
    try {
      if (state.cursorBytes > 0 && !tailMatches(fd)) {
        log('decision-relay: rulings.jsonl rotado (tail mismatch) — cursor reseteado');
        state.cursorBytes = 0; state.cursorTail = null;
      }
      if (stat.size === state.cursorBytes) return 0;
      const len = stat.size - state.cursorBytes;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.cursorBytes);
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }

    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return 0; // linea parcial: queda para la proxima pasada
    const consumed = lastNewline + 1;
    let added = 0;
    for (const line of chunk.slice(0, consumed).split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; } // linea corrupta: se salta, nunca rompe
      if (!r || !RELAYED_RULINGS.includes(r.ruling)) continue;
      if (!TASK_ID_RE.test(String(r.task || ''))) continue;
      const atMs = Date.parse(r.at || '');
      if (!Number.isFinite(atMs) || atMs < EPOCH_MS) continue; // legacy: nunca
      const id = sha1(`${r.task}|${r.ruling}|${r.at}`).slice(0, 16);
      if (deliveredSet.has(id) || state.pending[id]) continue;
      state.pending[id] = {
        task: r.task, ruling: r.ruling, why: r.why || '', at: r.at, source: r.source || null,
        attempts: 0, notified: null, ledgerNexted: false,
      };
      added += 1;
    }
    // Orden (regla del waker): pending primero, cursor despues. Un crash entre
    // los dos re-lee las mismas lineas y el dedupe por id las absorbe.
    if (added) persistPending();
    // T-0314 (tercer sitio, 2026-09-02 20:3xZ): el cursor es una posicion en BYTES;
    // `consumed` cuenta caracteres. Con los acentos de los `why` el fingerprint
    // fallaba, el cursor volvia a 0 y TODOS los rulings del dia se relayaban de
    // nuevo al pane dueno como decisiones frescas (el operador recibio ~10 sobres
    // [decision] repetidos). Se avanza en bytes.
    const bytes = Buffer.from(chunk.slice(0, consumed), 'utf8');
    state.cursorBytes += bytes.length;
    const fpLen = Math.min(bytes.length, 256);
    state.cursorTail = { len: fpLen, hash: sha1(bytes.subarray(bytes.length - fpLen)) };
    persistCursor();
    if (added) log(`decision-relay: ${added} decision(es) del operador para relayar`);
    return added;
  }

  // ── 2. worker: a QUIEN le importa esta decision ──────────────────────────
  const readCard = (task) => readJson(path.join(tasksDir, `${task}.json`), null);

  /**
   * La lease manda sobre el repo. Una tarjeta con `lease.owner = eve:<job>` la
   * esta ejecutando FinalOrchestra: mandarle la aprobacion al pane del repo
   * seria hablarle a quien no puede actuar.
   */
  function resolveWorker(entry, card) {
    const owner = card && card.lease && card.lease.owner;
    if (typeof owner === 'string' && owner.startsWith(EVE_OWNER_PREFIX)) {
      const jobId = owner.slice(EVE_OWNER_PREFIX.length).trim();
      if (jobId) {
        const call = eveCall(entry.ruling, jobId, entry.why);
        if (!entry.ledgerNexted) {
          // La tarjeta tiene que NOMBRAR la llamada: el sobre puede quedar en
          // cola, pero el tablero se lee siempre. Fallar aca no cancela la
          // entrega — es bookkeeping, no transporte.
          try {
            if (typeof runLedger === 'function') runLedger(['update', entry.task, '--next', call]);
            entry.ledgerNexted = true;
            persistPending();
          } catch (err) {
            log(`decision-relay: ledger update --next fallo para ${entry.task}: ${err.message}`);
          }
        }
        return { project: EVE_PROJECT, nextAction: call, eve: jobId };
      }
    }
    const repo = clean(card && card.repo);
    if (!repo) return { project: null, nextAction: null, eve: null };
    const declared = clean(card && card.next_action);
    return {
      project: repo,
      nextAction: declared || `retomar ${entry.task} y responder con un type=result con bloque criteria:`,
      eve: null,
    };
  }

  // ── 3. destino: se re-resuelve el pane AHORA, nunca se guarda un id ──────
  function resolveTarget(project, panes) {
    const mapped = (panes || [])
      // Un pane sin `agent` DECLARADO se acepta (los censos de test/drill no lo
      // traen); uno que lo declara `null` es una shell y no atiende sobres.
      .filter((p) => p.agent === undefined || p.agent)
      .map((p) => ({
        pane_id: p.paneId ?? p.pane_id,
        cwd: p.project || p.cwd || null,
        tab_title: p.tabTitle || p.title || null,
      }));
    const hit = resolvePane(project, mapped);
    if (hit.paneId === null) return { paneId: null, reason: 'no-pane' };
    if (hit.ambiguous.length) {
      log(`decision-relay[${project}]: ${hit.warning}`);
      return { paneId: null, reason: 'ambiguous-pane' };
    }
    return { paneId: hit.paneId, reason: null };
  }

  // ── 4. entrega ───────────────────────────────────────────────────────────

  /**
   * ¿Se puede entregar AHORA? Cada `no` tiene su propio NOMBRE: un
   * diferimiento indistinguible de una falla manda al operador a mirar el pane
   * equivocado. Ninguno de estos motivos consume un intento — el cap existe
   * para envios que fallaron, no para panes que estaban trabajando.
   */
  function gateDelivery(project, panes, stalled) {
    if (stalled.has(project)) return { paneId: null, reason: 'pane-not-accepting' };
    const target = resolveTarget(project, panes);
    if (target.reason) return { paneId: target.paneId, reason: target.reason };
    const paneId = target.paneId;
    const pane = panes.find((p) => (p.paneId ?? p.pane_id) === paneId);
    if (!pane || pane.status !== 'idle') return { paneId, reason: 'pane-busy' };
    // idle NO significa composer vacio (T-0242): entregar encima del texto sin
    // enviar del operador manda "su texto + el sobre" como UN solo prompt.
    if (composerHoldsForeignText(pane.lastLines || pane.text)) return { paneId, reason: 'composer-holds-foreign-text' };
    const last = state.lastAttemptAt[project];
    if (last !== undefined && now() - last < cfg.cooldownMs) return { paneId, reason: 'cooldown' };
    return { paneId, reason: null };
  }

  /** Un intento REAL contra el pane: consume intento y arma el cooldown. */
  async function attemptSend({ entry, project, paneId, body }) {
    state.lastAttemptAt[project] = now();
    entry.attempts += 1;
    // El sobre se arma con el pane resuelto AHORA. El destino durable es el
    // nombre del proyecto; el numero de pane es transporte de esta pasada.
    const envelope = buildEnvelope({
      fromPane: null, fromProject: 'decision-relay',
      toPane: paneId, toProject: project,
      corr: entry.task, type: 'request', body,
    });
    let deliveredCode = null;
    let submitted = null;
    try {
      deliveredCode = await send.sendPromptDeferredEnter(paneId, envelope);
      submitted = await send.verifyPromptSubmission(paneId, envelope);
    } catch (err) {
      log(`decision-relay[${project}]: send fallo: ${err.message}`);
    }
    persistPending();
    return { deliveredCode, submitted, verdict: classifyDelivery(deliveredCode, submitted) };
  }

  function resolveUndeliverable(id, entry, project, paneId, reason, out) {
    markResolved(id);
    recordEvent({ event: 'decision.undeliverable', task: entry.task, project, pane: paneId, ruling: entry.ruling, reason });
    out.undeliverable.push({ task: entry.task, project, reason });
  }

  async function processEntry(id, entry, panes, stalled, out) {
    let card;
    try { card = readCard(entry.task); } catch { card = null; }
    if (!card) return resolveUndeliverable(id, entry, null, null, 'no-card', out);
    const worker = resolveWorker(entry, card);
    if (!worker.project) return resolveUndeliverable(id, entry, null, null, 'no-repo', out);
    const project = worker.project;
    const body = buildBody({
      task: entry.task, ruling: entry.ruling, why: entry.why, source: entry.source, card, nextAction: worker.nextAction,
    });

    const gated = gateDelivery(project, panes, stalled);
    const paneId = gated.paneId;
    let reason = gated.reason;
    let attempt = { deliveredCode: null, submitted: null, verdict: null };
    if (!reason) {
      attempt = await attemptSend({ entry, project, paneId, body });
      if (attempt.verdict !== 'delivered') {
        reason = attempt.verdict === 'failed' ? 'send-failed' : 'send-unverified';
        // Un proyecto cuyo pane ya rechazo un envio en ESTA pasada no recibe
        // mas intentos: martillarle el resto de la cola no ayuda a nadie.
        stalled.add(project);
      }
    }
    const ok = attempt.verdict === 'delivered';

    // SIEMPRE durable: la linea con ok:false es la lista de trabajo de
    // queue-drain, que reintenta gratis lo que este relay no pudo verificar.
    const queued = enqueue({
      project, corr: entry.task, type: 'request', from_pane: null,
      resolved_pane: paneId, submitted: attempt.submitted, delivered: attempt.deliveredCode, ok, body,
    }, { base: intelDir });
    if (!queued.ok) {
      log(`decision-relay[${project}]: enqueue fallo (${queued.error || 'sin detalle'})`);
      if (!ok) return resolveUndeliverable(id, entry, project, paneId, 'enqueue-failed', out);
    }

    if (ok) {
      markResolved(id);
      recordEvent({ event: 'decision.delivered', task: entry.task, project, pane: paneId, ruling: entry.ruling });
      out.delivered.push({ task: entry.task, project, pane: paneId, ruling: entry.ruling });
      return;
    }

    if (entry.attempts >= cfg.maxAttempts) {
      const capReason = `attempt cap reached (${entry.attempts}) — last outcome: ${reason}`;
      flagCapExhausted(id, entry, capReason);
      resolveUndeliverable(id, entry, project, paneId, 'attempt-cap', out);
      out.flagged.push({ task: entry.task, project, reason: capReason });
      return;
    }

    // Un `queued` por MOTIVO, no por pasada: repetirlo cada minuto convierte
    // el log en ruido y esconde el cambio de motivo, que es la senal util.
    if (entry.notified !== reason) {
      entry.notified = reason;
      persistPending();
      recordEvent({ event: 'decision.queued', task: entry.task, project, pane: paneId, ruling: entry.ruling, reason });
    }
    out.queued.push({ task: entry.task, project, pane: paneId, reason });
  }

  // ── 5. la pasada ─────────────────────────────────────────────────────────
  async function relayOnce() {
    const out = { ingested: 0, delivered: [], queued: [], undeliverable: [], flagged: [] };
    try {
      out.ingested = ingest();
    } catch (err) {
      log(`decision-relay: ingesta fallo: ${err.message}`);
    }
    let panes = [];
    try { panes = (typeof discoverPanes === 'function' ? discoverPanes() : []) || []; }
    catch (err) { log(`decision-relay: censo de panes ilegible (${err.message}) — se encola sin entregar`); }
    const stalled = new Set();
    for (const id of Object.keys(state.pending)) {
      const entry = state.pending[id];
      if (!entry) continue;
      try {
        await processEntry(id, entry, panes, stalled, out);
      } catch (err) {
        // Nunca lanza: una decision que rompe no puede tapar a las demas.
        log(`decision-relay: ${entry.task} fallo la pasada (${err.message}) — queda pendiente`);
      }
    }
    return out;
  }

  function status() {
    const flags = readJson(FILES.flags, {});
    const pending = Object.values(state.pending);
    return {
      pending: pending.length,
      oldestPendingAt: pending.length ? pending.map((p) => p.at).sort()[0] : null,
      delivered: state.delivered.length,
      flagged: Object.keys(flags).length,
      cursorBytes: state.cursorBytes,
    };
  }

  return { relayOnce, status, ingest, EPOCH };
}

/** Helper de un solo tiro para llamadores inline (p.ej. el tablero tras applyTransition). */
function relayOnceWith(opts) {
  return createRelay(opts).relayOnce();
}

module.exports = {
  createRelay,
  relayOnceWith,
  EPOCH,
  EPOCH_MS,
  RELAYED_RULINGS,
  EVE_PROJECT,
  buildBody,
  eveCall,
};
