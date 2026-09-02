'use strict';
/**
 * orchestrator-waker.cjs — daemon-side "poke pane-0 when a watched repo's pane
 * finishes a turn", con entrega HONESTA (W4): classifyDelivery da tres estados
 * (delivered|failed|unverified), un poke no verificable se reintenta una vez y
 * a la segunda se flaggea con motivo; el texto retenido del composer se
 * persiste en _intel/held-composer.jsonl con dedupe; el beacon puede aportar
 * pistas {pane, cwd} que los riders VERIFICAN contra el censo antes de usar.
 * Exporta paneRunsBypass / paneContextPct / paneHeldComposer(Detail) / panesForRepo.
 *
 * The operator's design point, verbatim from the 2026-08-05 postmortem review:
 * an in-session Monitor dies silently with the session, so the watcher must
 * live OUT HERE and wake the orchestrator the same way the orchestrator wakes
 * worker panes — by typing into its pane, verified.
 *
 * Composition of three proven patterns, gaps closed:
 *   - tail a durable JSONL from a byte cursor        (clawtrol-bridge readDelta)
 *   - intent queue, dedupe by id, atomic state,
 *     mark delivered ONLY after verified success     (clawtrol-bridge, + verification
 *                                                     it lacked — its blind send counted
 *                                                     a stuck composer as delivered)
 *   - idle gate with consecutive-tick settle         (pane-handlers SETTLE_REQUIRED)
 *   - attempt cap + cooldown + flag-and-stop         (pane0-watchdog discipline)
 *
 * Pilot scope: watches _intel/pane-events.jsonl (written by the live
 * pane-beacon.cjs Stop/Notification hook) for turn-end / permission-wait from
 * configured repos, coalesces pending intents per repo into ONE short poke,
 * and delivers it to the orchestrator pane only when that pane is idle.
 *
 * Armed by startBackgroundServices behind WEZBRIDGE_ORCH_WAKER=1 (default OFF).
 * Never spawns panes (pane0-watchdog owns absence), never touches worker panes.
 */

const fs = require('node:fs');
const { composerHoldsForeignText, inputBoxContent, classifyDelivery } = require('./verified-send.cjs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  watchRepos: ['walksim'],
  targetProject: 'wezbridge',
  intervalMs: 60 * 1000,
  settleTicks: 2, // consecutive idle observations of the target before poking
  maxAttempts: 3, // per intent; cap reached -> flagged and dropped, never retried
  cooldownMs: 5 * 60 * 1000, // between poke attempts per repo
  deliveredKeep: 500, // delivered-id ring buffer size
  // 2026-09-01: un evento mas viejo que esto no se ingesta nunca. Un turn-end de
  // hace dias no es "trabajo terminado", es historia; poke-ar por el es ruido.
  staleEventMs: 6 * 60 * 60 * 1000,
  ctxAlertPct: 80, // M2: pane context % at/above which the poke carries a handoff→/clear warning
};

function intentId(evt) {
  return crypto.createHash('sha1')
    .update(`${evt.repo}|${evt.session || ''}|${evt.time || ''}|${evt.event || ''}`)
    .digest('hex').slice(0, 16);
}

// ── mm-d216: permission-wait from a bypass-permissions pane is NOISE ────────
//
// A pane running with bypass-permissions cannot be blocked on a permission
// prompt — its "Claude is waiting for your input" Notification fires at every
// idle prompt, i.e. it marks a TURN BOUNDARY, not a gate. Poking the
// orchestrator for it is the poke-storm class this waker was built to avoid.
// The rule is applied TWICE (twin filter): at ingest when the wiring can
// already answer (cfg.isBypassPane), and again at poke time against the live
// pane list — because a pane's mode is only knowable when a pane is visible.

/** Pure mm-d216 predicate: is this event noise given the pane's bypass mode? */
function isNoiseEvent(evt, bypass) {
  return !!evt && evt.event === 'permission-wait' && !!bypass;
}

const BYPASS_RE = /bypass permissions/i;

// fromCharCode(92) es la barra invertida. Escrita asi a proposito: un literal
// escapado se rompe al pasar por capas de edicion, y ya paso dos veces.
const BS = String.fromCharCode(92);
const normPath = (v) => String(v || '').split(BS).join('/').replace(/\/+$/, '').toLowerCase();

/** ¿El cwd/proyecto normalizado de un pane es (o termina en) el repo pedido? */
function repoSuffixMatch(proj, repo) {
  const want = `/${normPath(repo)}`;
  if (want === '/' || !proj) return false;
  return proj === want.slice(1) || proj.endsWith(want);
}

/**
 * Panes CANDIDATOS para un repo, en orden de confianza. `hint` es lo que trae
 * la línea del beacon ({pane, cwd}) cuando el hook los emite.
 *
 * VERIFY-THEN-TRUST, y no es paranoia decorativa: esta máquina corre DOS mux
 * sockets que sirven los MISMOS panes con ids DISTINTOS (medido 2026-08-25,
 * ver pane-identity.cjs:166-180) — y los espacios se SOLAPAN, así que un id
 * ajeno no falla, acierta el pane equivocado. Por eso:
 *   1. cwd exacto normalizado de la pista  (el dato más fuerte que hay)
 *   2. el pane id de la pista SOLO si el censo lo pone en ese repo
 *   3. el match por sufijo de siempre      (comportamiento previo, fail-open)
 *
 * Un pane id es una PISTA, nunca una dirección.
 */
function panesForRepo(panes, repo, hint = {}) {
  const list = (panes || []).filter((p) => normPath(p.project || p.cwd));
  const suffix = list.filter((p) => repoSuffixMatch(normPath(p.project || p.cwd), repo));
  const out = [];
  const hintCwd = hint && typeof hint.cwd === 'string' && hint.cwd.trim() ? normPath(hint.cwd) : null;
  if (hintCwd) out.push(...list.filter((p) => normPath(p.project || p.cwd) === hintCwd));
  if (hint && Number.isInteger(hint.pane)) {
    const byId = list.find((p) => (p.paneId ?? p.pane_id) === hint.pane);
    if (byId && repoSuffixMatch(normPath(byId.project || byId.cwd), repo)) out.push(byId);
  }
  out.push(...suffix);
  return [...new Set(out)];
}

/**
 * Does the pane working in `repo` currently show bypass-permissions mode?
 * Matches the pane whose project/cwd path ends with the repo path (repos can
 * be nested, e.g. "whatsappbot-prod - Copy - Copy/whatsappbot-final") — or the
 * one the beacon hint names, once verified — and reads the mode straight off
 * its status bar ("⏵⏵ bypass permissions on") in lastLines. No pane visible, or
 * no marker: NOT bypass — fail open, because a filter confident enough to
 * swallow a real gate would tell nobody.
 */
function paneRunsBypass(panes, repo, hint) {
  for (const p of panesForRepo(panes, repo, hint)) {
    if (BYPASS_RE.test(String(p.lastLines || p.text || ''))) return true;
  }
  return false;
}

const CTX_RE = /Ctx Used:\s*(\d+(?:\.\d+)?)%/;

/**
 * M2 (retro 2026-08-24): context watermark. wabot reached 97% context before
 * anyone noticed — the number was on its status bar the whole time, in the
 * same lastLines this waker already reads for paneRunsBypass. Returns the
 * watched repo's pane context %, or null when no pane/no marker (fail open:
 * a missing number must never fake an alert).
 */
function paneContextPct(panes, repo, hint) {
  for (const p of panesForRepo(panes, repo, hint)) {
    const m = CTX_RE.exec(String(p.lastLines || p.text || ''));
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * El composer de este repo retiene texto que el pane NO envio todavia.
 *
 * MEDIDO 2026-08-29: tres panes tenian instrucciones del operador sin enviar y
 * el waker reporto "finished work" por cada una. El pane no habia terminado ese
 * trabajo: nunca lo habia recibido. Decir "termino" sobre un pane que no
 * proceso nada es la ficcion que el comentario del poke ya prohibe.
 *
 * Lee el MISMO lastLines que paneRunsBypass y paneContextPct. Precondicion
 * verificada contra las 12 panes vivas: son las ultimas 20 lineas NO vacias
 * (pane-discovery:130) y la linea del composer entra en las 8 panes de agente.
 *
 * Fail-open (null) si no hay pane, no hay texto o el composer esta limpio:
 * un rider que se cuelga siempre se aprende a ignorar, y eso es peor que
 * no tenerlo.
 */
function paneHeldComposerDetail(panes, repo, hint) {
  for (const p of panesForRepo(panes, repo, hint)) {
    const tail = String(p.lastLines || p.text || '');
    if (!tail) continue;
    if (!composerHoldsForeignText(tail)) continue;
    return { paneId: p.paneId ?? p.pane_id ?? null, text: inputBoxContent(tail.split(/\r?\n/)) };
  }
  return null;
}

/**
 * Wrapper historico: solo el TEXTO retenido. Se conserva porque es contrato de
 * los llamadores y tests existentes; lo nuevo (persistir la retencion) necesita
 * ademas el pane, y por eso existe paneHeldComposerDetail.
 */
function paneHeldComposer(panes, repo, hint) {
  const detail = paneHeldComposerDetail(panes, repo, hint);
  return detail ? detail.text : null;
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function createWaker(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  // Repos live beside _intel (<root>/_intel/pane-events.jsonl -> <root>/<repo>).
  if (!cfg.reposRoot && cfg.eventsPath) {
    cfg.reposRoot = path.dirname(path.dirname(cfg.eventsPath));
  }
  const {
    eventsPath, stateDir, discoverPanes, resolveTarget, send, log = () => {},
    now = () => Date.now(),
  } = cfg;
  if (!eventsPath || !stateDir || !discoverPanes || !send) {
    throw new Error('orchestrator-waker: eventsPath, stateDir, discoverPanes and send are required');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const FILES = {
    cursor: path.join(stateDir, 'cursor.json'),
    pending: path.join(stateDir, 'pending.json'),
    delivered: path.join(stateDir, 'delivered.json'),
    flags: path.join(stateDir, 'flags.json'),
    resultsSeen: path.join(stateDir, 'results-seen.json'),
    heldSeen: path.join(stateDir, 'held-seen.json'),
  };
  // Donde vive held-composer.jsonl: junto a pane-events.jsonl (ambos son _intel),
  // salvo que el llamador diga otra cosa.
  const heldLogDir = cfg.intelDir || path.dirname(eventsPath);

  // Durable state — sessions and daemon restarts are survivable because
  // everything below is re-read from disk at construction.
  // FRESH state (no cursor file) starts at END of the events file: the waker
  // signals new completions, it does not replay history. First armed live it
  // ingested 590 stale intents from the beacon backlog — this stops that.
  let savedCursor = readJson(FILES.cursor, null);
  if (!savedCursor) {
    let size = 0;
    try { size = fs.statSync(cfg.eventsPath).size; } catch { /* no file yet */ }
    savedCursor = { bytes: size, tail: null };
  }
  const state = {
    cursorBytes: savedCursor.bytes,
    // Fingerprint of the last consumed bytes: rotation/truncation to a file of
    // ANY size (even one >= the cursor) is detected by the tail no longer
    // matching, not just by the size shrinking.
    cursorTail: savedCursor.tail, // { len, hash } | null
    pending: readJson(FILES.pending, {}), // intent_id -> {repo, event, time, attempts}
    delivered: readJson(FILES.delivered, []), // ring of intent ids
    idleStreak: 0,
    lastAttemptAt: {}, // repo -> ms (in-memory: a restart re-attempting early is safe)
    resultsSeen: readJson(FILES.resultsSeen, {}), // repo -> true once its results dir has been seeded
    heldSeen: readJson(FILES.heldSeen, {}), // sha1(pane|held) -> true, dedupe de held-composer.jsonl
    lastTickAt: null, // ISO — proves the loop is running, not merely constructed
    lastPokeAt: null, // ISO — proves delivery, not merely ticking
    // W4: intentos de entrega que NO se pudieron verificar, ACUMULADOS desde el
    // arranque. Acumulado y no "los que siguen pendientes" a proposito: un
    // intent flaggeado por "unverified twice" sale de pending, y si el contador
    // viviera solo ahi el numero volveria a 0 justo cuando el problema se
    // confirmo. Medida de proceso, como lastTickAt/lastPokeAt: se reinicia con
    // el daemon.
    unverifiedAttempts: 0,
    // 2026-09-01: cuantas veces el cursor tuvo que saltar a EOF (rotacion o
    // reescritura del archivo) y cuantos eventos se descartaron por viejos.
    // Ambos contados: un salto silencioso es como se pierde un evento sin que
    // nadie lo sepa, y un descarte silencioso es como se ignora uno real.
    cursorResets: 0,
    staleDropped: 0,
  };
  const deliveredSet = new Set(state.delivered);

  function persistPending() { atomicWriteJson(FILES.pending, state.pending); }
  function persistCursor() {
    atomicWriteJson(FILES.cursor, { bytes: state.cursorBytes, tail: state.cursorTail });
  }
  function persistDelivered() {
    state.delivered = state.delivered.slice(-cfg.deliveredKeep);
    atomicWriteJson(FILES.delivered, state.delivered);
  }
  // `reason` es parametro desde W4: ahora hay DOS motivos por los que un intent
  // muere (cap de intentos fallidos, y composer ilegible dos veces seguidas) y
  // waker-gate los imprime. Un flag que solo dice "attempt cap" manda al
  // operador a mirar el pane equivocado.
  const CAP_REASON = 'attempt cap reached — poke undeliverable, needs a human look';
  function flagCapExhausted(id, intent, reason = CAP_REASON) {
    const flags = readJson(FILES.flags, {});
    flags[id] = { ...intent, flagged_at: new Date(now()).toISOString(), reason };
    atomicWriteJson(FILES.flags, flags);
  }

  /**
   * Persiste el texto que un composer retiene, UNA vez por (pane, texto).
   *
   * MEDIDO: hasta hoy la retencion se leia en vivo para colgarla del poke y
   * despues se perdia — la cita falsa del 2026-08-31 salio de reconstruir de
   * memoria algo que nunca se habia escrito. El dedupe es lo que lo hace
   * legible: sin el, un composer trabado tres horas escribe una linea por tick.
   *
   * Fail-soft entera: un log que no puede escribir no puede frenar el loop.
   */
  function recordHeldComposer(repo, detail) {
    try {
      const held = String(detail.text || '').slice(0, 200);
      if (!held) return;
      const key = crypto.createHash('sha1')
        .update(`${detail.paneId}|${held}`).digest('hex').slice(0, 16);
      if (state.heldSeen[key]) return;
      const line = JSON.stringify({
        time: new Date(now()).toISOString(), repo, pane: detail.paneId, held,
      });
      fs.appendFileSync(path.join(heldLogDir, 'held-composer.jsonl'), `${line}\n`);
      // Marcar DESPUES del append: si el append falla, la proxima pasada
      // reintenta en vez de tragarse el hecho para siempre.
      state.heldSeen[key] = true;
      atomicWriteJson(FILES.heldSeen, state.heldSeen);
    } catch { /* fail-soft */ }
  }

  // ── 1. ingest: new beacon lines since cursor -> pending intents ──────────
  function tailMatches(fd) {
    if (!state.cursorTail || state.cursorTail.len > state.cursorBytes) return true;
    const { len, hash } = state.cursorTail;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.cursorBytes - len);
    return crypto.createHash('sha1').update(buf).digest('hex') === hash;
  }

  function ingestEvents(panes = []) {
    let stat;
    try { stat = fs.statSync(eventsPath); } catch { return; } // no beacon file yet
    const fd = fs.openSync(eventsPath, 'r');
    let chunk;
    try {
      // Truncate-and-rewrite to a size >= the cursor is invisible to a size
      // check alone — verify the bytes we already consumed are still there.
      // 2026-09-01: el reinicio del cursor a 0 REPLAYO la historia entera
      // (18.697 lineas desde el 25-08: pokes de panes que ya no existen). El
      // cursor SI vuelve a 0 — un archivo rotado puede traer eventos recientes
      // y quedar ciego a ellos es peor — pero la re-lectura pasa por el filtro
      // de antiguedad (staleEventMs) y el dedupe de entregados, asi que la
      // historia no se convierte en pokes. El reinicio queda contado.
      const shrank = stat.size < state.cursorBytes;
      if (shrank || (state.cursorBytes > 0 && !tailMatches(fd))) {
        log(`orch-waker: events file ${shrank ? 'shrank' : 'rotated (tail mismatch)'} — cursor reset; re-read filtered by age (${cfg.staleEventMs} ms)`);
        state.cursorBytes = 0;
        state.cursorTail = null;
        state.cursorResets += 1;
      }
      if (stat.size === state.cursorBytes) return;
      const len = stat.size - state.cursorBytes;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.cursorBytes);
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    // Only complete lines; an in-flight partial line stays for the next tick.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return;
    const consumed = lastNewline + 1;
    let added = 0;
    let noiseDropped = 0;
    for (const line of chunk.slice(0, consumed).split('\n')) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; } // corrupt line: skip, never crash
      if (!cfg.watchRepos.includes(evt.repo)) continue;
      if (!['turn-end', 'permission-wait'].includes(evt.event)) continue;
      // Evento viejo: se descarta y se cuenta. Nunca se poke-a por historia.
      const evtMs = Date.parse(evt.time || '');
      if (cfg.staleEventMs > 0 && Number.isFinite(evtMs) && (now() - evtMs) > cfg.staleEventMs) {
        state.staleDropped += 1;
        continue;
      }
      // mm-d216 twin filter, ingest side: when the SOURCE pane is visible and
      // runs bypass-permissions, its permission-wait never becomes an intent.
      // cfg.isBypassPane overrides for tests/wiring; a throwing predicate or an
      // invisible pane keeps the event (fail open).
      if (evt.event === 'permission-wait') {
        let bypass = false;
        try {
          bypass = cfg.isBypassPane
            ? !!cfg.isBypassPane(evt)
            : paneRunsBypass(panes, evt.repo, { pane: evt.pane, cwd: evt.cwd });
        } catch { bypass = false; }
        if (isNoiseEvent(evt, bypass)) { noiseDropped += 1; continue; }
      }
      const id = intentId(evt);
      if (deliveredSet.has(id) || state.pending[id]) continue;
      // pane/cwd son OPCIONALES: el hook global los emite recien con el diff
      // propuesto de W4, y las lineas viejas (sin ellos) tienen que seguir
      // produciendo intents identicos. Se guardan solo si son del tipo correcto
      // — un `pane: null` es "no se supo", no un pane.
      const intent = { repo: evt.repo, event: evt.event, time: evt.time, attempts: 0 };
      if (Number.isInteger(evt.pane)) intent.pane = evt.pane;
      if (typeof evt.cwd === 'string' && evt.cwd.trim()) intent.cwd = evt.cwd;
      state.pending[id] = intent;
      added += 1;
    }
    // Order matters: intents first, cursor second. A crash in between re-reads
    // the same lines next tick and the id-dedupe absorbs them — never loses one.
    if (added) persistPending();
    // T-0314: el cursor es una POSICION EN BYTES (stat.size, readSync, el
    // fingerprint). `consumed` es un indice de caracteres del string decodificado:
    // con un solo acento el cursor quedaba corto, el fingerprint del tick
    // siguiente se leia desplazado y el guard de rotacion disparaba un reset
    // falso en CADA tick (medido 71 en 70 min). Se avanza en bytes.
    const consumedBytes = Buffer.from(chunk.slice(0, consumed), 'utf8');
    state.cursorBytes += consumedBytes.length;
    const fpLen = Math.min(consumedBytes.length, 256);
    state.cursorTail = {
      len: fpLen,
      hash: crypto.createHash('sha1').update(consumedBytes.subarray(consumedBytes.length - fpLen)).digest('hex'),
    };
    persistCursor();
    if (added) log(`orch-waker: ${added} new intent(s), ${Object.keys(state.pending).length} pending`);
    if (noiseDropped) log(`orch-waker: ${noiseDropped} permission-wait event(s) dropped as noise at ingest (mm-d216: pane runs bypass-permissions)`);
  }

  // ── 1b. results-file trigger: a completion signal that needs NO hook ──────
  //
  // The beacon path requires the agent's harness to fire a Stop hook. Codex
  // panes do not reliably do that — confirmed on mutual 2026-08-06: the beacon
  // hook is registered for codex and works standalone (exit 0, correct repo),
  // yet no beacon has been emitted since 2026-07-31 while the pane worked all
  // day. That is the `codex-pane: DEFERRED — no completion signal` entry in the
  // registry, and it locked every non-Claude pane out of the loop.
  //
  // A results FILE is the contract already: harvest-by-file is how the
  // orchestrator reads outcomes, and no node is complete without one. So watch
  // for it directly. This is strictly better than the beacon for the thing we
  // actually care about — a beacon says "a turn ended", which is usually noise;
  // a new results file says "a NODE COMPLETED", which is always actionable.
  //
  // Mtime is deliberately NOT the key: clock skew and touch-like rewrites make
  // it unreliable. The key is (path + size + mtime) hashed into an intent id, so
  // a genuinely rewritten result re-fires and an unchanged one never does.
  function scanResults() {
    if (!cfg.reposRoot) return 0;
    let added = 0;
    for (const repo of cfg.watchRepos) {
      const dir = path.join(cfg.reposRoot, repo, '.orchestrator', 'results');
      let names;
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch {
        // No results dir YET. Seed the repo as seen with an EMPTY history so the
        // first file it ever writes counts as NEW. Without this, a greenfield
        // repo's very first node completion is swallowed by the seeding branch
        // below as if it were pre-existing history — the silent-swallow class
        // this loop exists to prevent, and it would have eaten mutual's first
        // result (caught 2026-08-06, before it could bite).
        if (!state.resultsSeen[repo]) {
          state.resultsSeen[repo] = true;
          atomicWriteJson(FILES.resultsSeen, state.resultsSeen);
        }
        continue;
      }
      for (const name of names) {
        let st;
        try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
        const id = crypto.createHash('sha1')
          .update(`result|${repo}|${name}|${st.size}|${Math.floor(st.mtimeMs)}`)
          .digest('hex').slice(0, 16);
        if (deliveredSet.has(id) || state.pending[id]) continue;
        // First sight of a repo's results dir must not replay its whole history:
        // seed silently, exactly like the events cursor starts at end-of-file.
        if (!state.resultsSeen[repo]) continue;
        state.pending[id] = {
          repo, event: 'result-file', time: new Date(st.mtimeMs).toISOString(),
          node: name.replace(/\.json$/, ''), attempts: 0,
        };
        added += 1;
      }
      if (!state.resultsSeen[repo]) {
        state.resultsSeen[repo] = true;
        atomicWriteJson(FILES.resultsSeen, state.resultsSeen);
        for (const name of names) {
          try {
            const st = fs.statSync(path.join(dir, name));
            deliveredSet.add(crypto.createHash('sha1')
              .update(`result|${repo}|${name}|${st.size}|${Math.floor(st.mtimeMs)}`)
              .digest('hex').slice(0, 16));
          } catch { /* vanished mid-scan */ }
        }
        persistDelivered();
      }
    }
    if (added) {
      persistPending();
      log(`orch-waker: ${added} new RESULTS-FILE intent(s), ${Object.keys(state.pending).length} pending`);
    }
    return added;
  }

  // ── 2. target: resolve orchestrator pane + idle settle ───────────────────
  function findTarget(panes) {
    if (resolveTarget) return resolveTarget(panes);
    // Default: pane-identity semantics over discoverPanes output.
    // Non-Claude panes are excluded FIRST: the daemon's own shell pane shares
    // the wezbridge cwd, and without this filter resolution is permanently
    // ambiguous (two hits) and the waker fails closed forever.
    const { resolve } = require('./pane-identity.cjs');
    const mapped = panes
      .filter((p) => p.isClaude !== false)
      .map((p) => ({
        pane_id: p.paneId ?? p.pane_id,
        cwd: p.project || p.cwd || null,
        tab_title: p.title || null,
      }));
    const hit = resolve(cfg.targetProject, mapped);
    if (hit.ambiguous.length) {
      log(`orch-waker: ${hit.warning} — not poking`);
      return null;
    }
    return hit.paneId;
  }

  // A node that can still run keeps the graph open. A missing or fully
  // terminal graph means the pane's turn-ends are ordinary work, not node
  // completions — and the poke must not pretend otherwise. Absent `state` counts
  // as open: a freshly authored graph has run nothing yet.
  const TERMINAL_NODE_STATES = new Set(['done', 'failed', 'cancelled', 'skipped']);
  function openGraph(repo) {
    if (cfg.hasOpenGraph) return cfg.hasOpenGraph(repo);
    // EVERY graph file, not just graph.json. A repo accumulates them: brlite's
    // graph.json held the sealed graph-1 while the live milestone was authored
    // as graph-3.json, so reading one fixed name would have reported "no open
    // graph" about a graph dispatched minutes earlier — the same lie this check
    // exists to prevent, merely pointing the other way.
    const dir = path.join(cfg.reposRoot, repo, '.orchestrator');
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => /^graph.*\.json$/i.test(f));
    } catch {
      return false; // no .orchestrator dir -> not a graph-driven repo
    }
    for (const f of files) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (g.graph_state === 'closed') continue; // explicitly sealed
        const nodes = g.nodes;
        if (!Array.isArray(nodes) || !nodes.length) continue;
        if (nodes.some((n) => !TERMINAL_NODE_STATES.has(n && n.state))) return true;
      } catch { /* unreadable graph file is not an open graph */ }
    }
    return false;
  }

  // ── 3. deliver: one coalesced poke per repo, verified, capped ────────────
  async function deliverPending(panes) {
    const ids = Object.keys(state.pending);
    if (!ids.length) return;

    const targetId = findTarget(panes);
    if (targetId == null) { state.idleStreak = 0; return; }
    const target = panes.find((p) => (p.paneId ?? p.pane_id) === targetId);
    const status = target ? target.status : 'unknown';
    if (status !== 'idle') { state.idleStreak = 0; return; }
    state.idleStreak += 1;
    if (state.idleStreak < cfg.settleTicks) return;

    const byRepo = {};
    for (const id of ids) (byRepo[state.pending[id].repo] ||= []).push(id);

    for (const [repo, groupAll] of Object.entries(byRepo)) {
      // mm-d216 twin filter, poke side: permission-wait intents whose SOURCE
      // pane is visibly running bypass-permissions are noise — drop them here,
      // with the live pane list in hand, instead of waking the orchestrator on
      // a turn boundary. Dropped intents join the delivered ring so a restart
      // never resurrects them. A wholly-noise group consumes no cooldown.
      // Pista del beacon para los tres riders: la del intent MAS NUEVO que la
      // traiga (los eventos vienen en orden de archivo). Sigue siendo una
      // pista: panesForRepo la verifica contra el censo antes de usarla.
      const hint = {};
      for (const id of groupAll) {
        const it = state.pending[id];
        if (it && it.pane !== undefined) hint.pane = it.pane;
        if (it && it.cwd !== undefined) hint.cwd = it.cwd;
      }
      let group = groupAll;
      if (paneRunsBypass(panes, repo, hint)) {
        const noiseIds = groupAll.filter((id) => isNoiseEvent(state.pending[id], true));
        if (noiseIds.length) {
          for (const id of noiseIds) {
            delete state.pending[id];
            deliveredSet.add(id);
            state.delivered.push(id);
          }
          persistPending(); persistDelivered();
          log(`orch-waker: ${noiseIds.length} permission-wait intent(s) from ${repo} dropped as noise (mm-d216: pane runs bypass-permissions)`);
          group = groupAll.filter((id) => state.pending[id]);
          if (!group.length) continue;
        }
      }
      // undefined = never attempted — a first attempt is never cooldown-blocked
      const last = state.lastAttemptAt[repo];
      if (last !== undefined && now() - last < cfg.cooldownMs) continue;
      state.lastAttemptAt[repo] = now();
      const newest = group.map((id) => state.pending[id].time).sort().pop();
      const kinds = [...new Set(group.map((id) => state.pending[id].event))].join('+');
      // Payload-first single line: truncation eats the HEAD of long messages,
      // so the whole poke stays short and the command leads.
      //
      // Say what HAPPENED, not what to do about it. The old text always claimed
      // a graph was running and ordered a results harvest; on 2026-08-06 it fired
      // for operator-directed work against a graph that had been closed for
      // hours, pointing at four stale result files (audit hole 5). Asserting a
      // mode you have not checked is how a notification manufactures a fiction.
      const facts = `${group.length} ${kinds} event(s), latest ${newest}`;
      // A results FILE outranks a turn-end: it names a node that actually
      // completed, where a turn-end is usually mid-work noise. Lead with it.
      const nodes = [...new Set(group.map((id) => state.pending[id].node).filter(Boolean))];
      let text = nodes.length
        ? `[orch-waker] ${repo} RESULT FILE(S) written: ${nodes.join(', ')}. Harvest ${repo}/.orchestrator/results/ and advance — ${facts}.`
        : openGraph(repo)
          ? `[orch-waker] Harvest ${repo}/.orchestrator/results/ and advance the graph — ${facts}.`
          : `[orch-waker] ${repo} finished work — ${facts}. No open graph, so no node completed: check what the pane actually did.`;
      // M2: context watermark — the number was always on the pane's status
      // bar; wabot hit 97% before anyone looked. ≥ threshold rides the poke
      // so the orchestrator can arm handoff→/clear BEFORE the cliff.
      const ctxPct = paneContextPct(panes, repo, hint);
      if (ctxPct !== null && ctxPct >= cfg.ctxAlertPct) {
        text += ` CONTEXT ${ctxPct}% — arm the handoff→/clear recycle for this pane before it hits the wall.`;
      }
      // T-0242: "finished work" es FALSO si el composer retiene texto que el
      // pane nunca envio. Medido el 2026-08-29 en tres panes a la vez. Se cita
      // el texto porque sin el, el operador sabe que algo se trabo pero no QUE.
      const heldDetail = paneHeldComposerDetail(panes, repo, hint);
      if (heldDetail) {
        text += ` OJO: su composer RETIENE texto sin enviar (${JSON.stringify(heldDetail.text.slice(0, 80))}) — no proceso eso; una tecla del operador lo destraba.`;
        // El poke es efimero; el archivo no. Sin esto, el unico registro de lo
        // que se perdio vive en el scrollback de un pane.
        recordHeldComposer(repo, heldDetail);
      }
      // Tres estados, no dos (W4): un send que no se pudo VERIFICAR no es una
      // entrega. Ver classifyDelivery en verified-send.cjs.
      let verdict = 'unverified';
      try {
        const delivered = await send.sendPromptDeferredEnter(targetId, text);
        const submitted = await send.verifyPromptSubmission(targetId, text);
        verdict = classifyDelivery(delivered, submitted);
      } catch (err) {
        verdict = 'failed'; // un send que TIRA es un fallo medido, no una duda
        log(`orch-waker: poke send failed: ${err.message}`);
      }
      if (verdict === 'unverified') {
        // Ni entregado ni fallado: el pane no se pudo leer. Se reintenta una
        // vez tras el cooldown; a la segunda se flaggea con un motivo que
        // nombra el pane, porque reintentar para siempre contra un pane
        // ilegible es exactamente el poke-storm silencioso de 2026-08-13.
        let capped = 0;
        for (const id of group) {
          const intent = state.pending[id];
          intent.unverified = (intent.unverified || 0) + 1;
          state.unverifiedAttempts += 1;
          if (intent.unverified >= 2) {
            flagCapExhausted(id, intent, `unverified twice: composer unreadable (pane ${targetId})`);
            delete state.pending[id];
            capped += 1;
          }
        }
        persistPending();
        log(`orch-waker: poke to pane ${targetId} for ${repo} could NOT be verified`
          + `${capped ? ` — ${capped} intent(s) FLAGGED (unverified twice)` : ' — will retry once after cooldown'}`);
        continue;
      }
      if (verdict === 'delivered') {
        for (const id of group) {
          delete state.pending[id];
          deliveredSet.add(id);
          state.delivered.push(id);
        }
        persistPending(); persistDelivered();
        state.idleStreak = 0;
        state.lastPokeAt = new Date(now()).toISOString();
        log(`orch-waker: poked pane ${targetId} for ${repo} (${group.length} intent(s) delivered)`);
      } else {
        let capped = 0;
        for (const id of group) {
          const intent = state.pending[id];
          intent.attempts += 1;
          if (intent.attempts >= cfg.maxAttempts) {
            flagCapExhausted(id, intent);
            delete state.pending[id];
            capped += 1;
          }
        }
        persistPending();
        log(`orch-waker: poke NOT verified for ${repo}${capped ? ` — ${capped} intent(s) hit the cap and were FLAGGED` : ' — will retry after cooldown'}`);
      }
    }
  }

  async function tick() {
    state.lastTickAt = new Date(now()).toISOString();
    // Discovery moved AHEAD of ingest so the mm-d216 ingest filter can see the
    // live pane list. A discovery failure must not stop ingest (it never did):
    // panes stays [] -> the filter fails open and events are kept as before.
    let panes = [];
    let discoveryFailed = false;
    try { panes = discoverPanes() || []; } catch (err) {
      log(`orch-waker: discovery failed: ${err.message}`);
      discoveryFailed = true;
    }
    ingestEvents(panes);
    try { scanResults(); } catch (err) { log(`orch-waker: results scan failed: ${err.message}`); }
    if (discoveryFailed) return;
    await deliverPending(panes);
  }

  // session-snapshot.cjs startWatcher shape: immediate first tick, unref'd
  // interval, per-tick try/catch so one bad tick never kills the loop.
  function startWatcher() {
    const safeTick = () => { tick().catch((err) => log(`orch-waker tick failed: ${err.message}`)); };
    const handle = setInterval(safeTick, cfg.intervalMs);
    if (handle && handle.unref) handle.unref();
    safeTick();
    return () => clearInterval(handle);
  }

  // Live runtime facts for the health surface. MEASURED, never inferred: the
  // caller must be able to answer "is the loop actually consuming events?"
  // without reading logs. cursorLagBytes > 0 and growing means beacons are
  // being written and NOT read — the exact silent failure of 2026-08-06.
  function status() {
    let eventsBytes = 0;
    try { eventsBytes = fs.statSync(cfg.eventsPath).size; } catch { /* no file yet */ }
    // Age of the OLDEST undelivered intent, in minutes. This is the number that
    // makes the waker's consumer able to FAIL: a poke that sits undelivered is
    // invisible in a count ("pending: 3" looks like normal churn) but loud as an
    // age ("oldest pending: 94 min" is a stuck loop). The 2026-08-13 disarm
    // happened precisely because 55 intents accumulated with nothing measuring
    // how long they had been there.
    let pendingOldestMinutes = 0;
    for (const it of Object.values(state.pending)) {
      const t = Date.parse(it.time || '');
      if (!Number.isNaN(t)) {
        pendingOldestMinutes = Math.max(pendingOldestMinutes, Math.round((now() - t) / 60000));
      }
    }
    let flagged = 0;
    try { flagged = Object.keys(readJson(FILES.flags, {})).length; } catch { /* none */ }
    return {
      armed: true,
      repos: cfg.watchRepos,
      pending: Object.keys(state.pending).length,
      pendingOldestMinutes,
      // La perilla de fine-tuning del loop: cada 'unverified' es un lugar donde
      // el sistema no se ve a si mismo. Sin numero no hay como fallar sobre eso.
      unverified: state.unverifiedAttempts,
      cursorResets: state.cursorResets,
      staleDropped: state.staleDropped,
      flagged,
      lastTickAt: state.lastTickAt || null,
      lastPokeAt: state.lastPokeAt || null,
      cursorBytes: state.cursorBytes,
      eventsBytes,
      cursorLagBytes: Math.max(0, eventsBytes - state.cursorBytes),
    };
  }

  return { tick, startWatcher, status, _state: state, _files: FILES, _openGraph: openGraph };
}

/**
 * Where arming lives. Precedence: env override > durable config file > OFF.
 *
 * The env var alone was the whole bug on 2026-08-06: the waker ran fine for
 * hours, the daemon was restarted with the documented `npm run dashboard`, and
 * the arming vanished with the old shell — silently, because the old code just
 * fell through a bare `if`. A restart must not be able to disarm the loop, and
 * when it IS off the caller must be handed a reason to log.
 *
 * Returns { enabled, repos, source, reason } — reason is always populated.
 */
function resolveWakerConfig({ env = process.env, intelDir, readFile } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const parseRepos = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

  const envFlag = env.WEZBRIDGE_ORCH_WAKER;
  if (envFlag === '0') {
    return { enabled: false, repos: [], source: 'env', reason: 'WEZBRIDGE_ORCH_WAKER=0 (explicit off)' };
  }

  let file = null;
  if (intelDir) {
    try {
      file = JSON.parse(read(path.join(intelDir, 'orch-waker.json')));
    } catch { /* absent or unparseable -> treated as no config */ }
  }

  if (envFlag === '1') {
    const repos = parseRepos(env.WEZBRIDGE_ORCH_WAKER_REPOS)
      || [];
    const fromFile = Array.isArray(file && file.repos) ? file.repos : [];
    const chosen = repos.length ? repos : fromFile;
    if (!chosen.length) {
      return { enabled: false, repos: [], source: 'env', reason: 'WEZBRIDGE_ORCH_WAKER=1 but no repos configured (set WEZBRIDGE_ORCH_WAKER_REPOS or _intel/orch-waker.json)' };
    }
    return { enabled: true, repos: chosen, source: 'env', reason: `armed by WEZBRIDGE_ORCH_WAKER=1 (repos: ${chosen.join(',')})` };
  }

  if (file && file.enabled === true) {
    const repos = Array.isArray(file.repos) ? file.repos.filter(Boolean) : [];
    if (!repos.length) {
      return { enabled: false, repos: [], source: 'file', reason: '_intel/orch-waker.json has enabled:true but an empty repos list' };
    }
    return { enabled: true, repos, source: 'file', reason: `armed by _intel/orch-waker.json (repos: ${repos.join(',')})` };
  }

  // A DELIBERATE disarm is not a fault, and conflating the two is expensive in
  // one specific direction: bridge_health raises an alert and pins ok:false
  // forever over a decision someone made on purpose, which trains every reader
  // to ignore its alerts. The config carries its own decision record — a
  // `_disarmed_*` key holding why it was turned off and what would justify
  // re-arming — so read it instead of inferring a problem from `enabled:false`.
  const disarmKey = file
    ? Object.keys(file).find((k) => k.startsWith('_disarmed'))
    : null;
  if (disarmKey) {
    return {
      enabled: false,
      repos: Array.isArray(file.repos) ? file.repos.filter(Boolean) : [],
      source: 'file',
      deliberate: true,
      decidedAt: disarmKey.replace(/^_disarmed_?/, '').replace(/_/g, '-') || null,
      decision: String(file[disarmKey]),
      reason: 'disarmed ON PURPOSE — see the decision record in _intel/orch-waker.json',
    };
  }

  return {
    enabled: false,
    repos: [],
    source: 'default',
    deliberate: false,
    reason: file
      ? '_intel/orch-waker.json present but enabled is not true, and it carries NO decision record explaining why'
      : 'not armed — no WEZBRIDGE_ORCH_WAKER=1 and no _intel/orch-waker.json',
  };
}

module.exports = { createWaker, intentId, DEFAULTS, resolveWakerConfig, isNoiseEvent, paneRunsBypass, paneContextPct, paneHeldComposer, paneHeldComposerDetail, panesForRepo };
