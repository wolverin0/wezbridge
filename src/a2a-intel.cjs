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
  // El bullet es OPCIONAL y `:` cuenta como separador, igual que en weakPasses.
  // Antes este regex exigía bullet `-` y no aceptaba `:`, así que sobre el MISMO
  // texto un lector veía la evidencia y este contaba cero — medido en vivo el
  // 2026-08-27 sobre un result cuyas líneas sí la traían. El contador existe
  // para decir "criteria=5, evidence=0 es un result que pide que le crean";
  // sub-contar por un separador convierte esa señal en una acusación contra
  // quien cumplió, que es peor que no tener contador.
  for (const m of String(body).matchAll(/^\s*[-*]?\s*.+?:\s*(?:pass(?:ed)?|fail(?:ed)?)\b\s*[—–:-]{1,2}\s*(\S.*)$/gim)) {
    items.push(m[1].trim());
  }
  return { count: items.length, items };
}

/**
 * UN SOLO PARSER DE CORR para gate, lease y linker (W2, 2026-09-01).
 *
 * Convención de despacho a Eve: `<T-id>:<slug>:<yyyymmdd>`, que Eve muta a
 * `…:rN` en cada revisión. Antes de esto el gate (checkDispatchGate) y la lease
 * (takeDispatchLease) matcheaban `^T-\d{4}$` PELADO, así que una tarjeta
 * despachada con la convención salía por el único camino sin gate y sin dueño —
 * exactamente el agujero que T-0238 y M1 existen para tapar, reabierto por un
 * prefijo. Tres lectores distintos del mismo string es como se llega a que uno
 * gatee y otro no.
 *
 * Los corrs con GUION (`T-0121-foo`) NO matchean, y es deliberado: nunca fueron
 * gateados, así que matchearlos ahora gatearía retroactivamente hilos vivos que
 * nadie declaró como tarjeta. Documentado en docs/a2a-protocol.md.
 *
 * Devuelve el id de tarjeta o null.
 */
function taskIdFromCorr(corr) {
  const s = String(corr || '').replace(/:r\d+$/i, '');
  const m = /^(T-\d{4})(?::|$)/.exec(s);
  return m ? m[1] : null;
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
 *
 * W2 (2026-09-01): devuelve `{ time }` — el instante que quedó PERSISTIDO. Es
 * la única forma de que el linker apunte la evidencia a la línea exacta
 * (`a2a-results.jsonl#time=<iso>`) en vez de a "llegó un result": dos results
 * del mismo corr en el mismo minuto son indistinguibles sin él. Devuelve null
 * si el append falló (fail-soft: el llamador simplemente no liga).
 */
function recordResultBody({ corr, fromPane, toPane, v2, body }) {
  try {
    const text = String(body ?? '');
    const truncated = text.length > RESULT_BODY_CAP;
    const time = new Date().toISOString();
    const line = JSON.stringify({
      time,
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
    return { time };
  } catch { return null; /* fail-soft */ }
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
/**
 * Palabras de ruling que declaran CIERRE. Igualdad exacta contra un Set de una
 * sola palabra, deliberadamente: ~20 líneas de rulings.jsonl llevan párrafos
 * doctrinales enteros dentro del campo `ruling`, y cualquier `.includes()`
 * sobre eso da match accidental. `cancelled` queda AFUERA por medición: sumaba
 * 3 falsos positivos y 0 verdaderos.
 */
const CLOSING_RULINGS = new Set(['resolved']);

/**
 * ¿Hay un ruling de cierre POSTERIOR al último movimiento de la tarjeta?
 *
 * Compara contra un HECHO del archivo de la tarjeta (`state_changed_at`, con
 * fallback a `updated_at`), no contra "el último ruling de cualquier tipo".
 * Esa elección es lo que impide que el guard se auto-silencie: el hábito real
 * de la flota es escribir el cierre y DESPUÉS anexar la narrativa del
 * despacho — las tres tareas más recientes tienen esa forma — así que una
 * regla de "último gana" se apagaría sola con prosa, que es exactamente la
 * falla que toda esta cadena existe para impedir.
 *
 * Fail-open en todo lo que no sea una violación probable: archivo ausente,
 * ilegible, línea corrupta, `at` impresentable, tarjeta sin marca temporal.
 */
function closingRulingAfterMove(corr, card, read) {
  const moved = Date.parse(card.state_changed_at || card.updated_at || '');
  if (!Number.isFinite(moved)) return null;
  let raw;
  try { raw = read(path.join(intelDir(), 'rulings.jsonl')); } catch { return null; }
  let hit = null;
  for (const l of String(raw).split('\n')) {
    if (!l.trim()) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }   // una línea rota no tumba la lectura
    if (!r || r.task !== corr || !CLOSING_RULINGS.has(r.ruling)) continue;
    const at = Date.parse(r.at || '');
    if (!Number.isFinite(at) || at <= moved) continue;
    if (!hit || at > hit.ms) hit = { ms: at, at: r.at };
  }
  return hit;
}

/**
 * Arma el header del envelope, direccionando por NOMBRE DE PROYECTO cuando se
 * lo conoce y cayendo a pane-N cuando no.
 *
 * El pane-id NO es una direccion: vive en dos espacios —el que publica el MCP y
 * el del CLI de wezterm— y el mismo pane es 11 en uno y 15 en el otro. Medido
 * el 2026-08-29: la pane de infra reporto DOS VECES un misruteo que no existia,
 * porque leia el id MCP del header contra el suyo del CLI. El envio estaba
 * bien; el formato no podia expresar la direccion real.
 *
 * El fallback a pane-N no es cortesia: hay envelopes headless y panes sin cwd
 * resoluble. Un header sin direccion es peor que uno ambiguo.
 *
 * Los dos parsers (handlers/shared.cjs y telegram-streamer.cjs) aceptan las dos
 * formas, asi que los panes con servidor viejo pueden seguir emitiendo pane-N
 * sin que nadie los pierda.
 */
function buildEnvelope({ fromPane, fromProject, toPane, toProject, corr, type, body }) {
  const addr = (project, pane) => {
    const name = String(project || '').trim();
    return name || `pane-${pane}`;
  };
  return `[A2A from ${addr(fromProject, fromPane)} to ${addr(toProject, toPane)} | corr=${corr} | type=${type}]\n${body}`;
}

/**
 * El vocabulario cerrado de kinds, o null si no se puede establecer.
 *
 * Acepta las dos formas que el registro tuvo en la practica — lista pelada y
 * objeto con `kinds` — porque adivinar mal la forma seria peor que no mirar:
 * daria un vocabulario vacio y refutaria TODOS los kinds. Devolver null ante
 * cualquier duda es lo que mantiene el gate fail-open.
 */
function readKnownKinds(read) {
  let raw;
  try { raw = read(path.join(intelDir(), 'kinds.json')); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const list = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed && parsed.kinds) ? parsed.kinds
      : (parsed && typeof parsed.kinds === 'object' && parsed.kinds ? Object.keys(parsed.kinds)
        : (parsed && typeof parsed === 'object' ? null : null)));
  if (!Array.isArray(list) || !list.length) return null;
  const names = list
    .map((k) => (typeof k === 'string' ? k : (k && typeof k === 'object' ? k.name || k.kind || k.id : null)))
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim());
  return names.length ? new Set(names) : null;
}

function checkDispatchGate({ corr, type, readFile }) {
  if (type !== 'request') return { allowed: true };
  // W2: el corr puede venir con la convencion de Eve (`T-0301:slug:20260901`,
  // `…:r2`); la tarjeta es la misma. taskIdFromCorr es el UNICO parser.
  const taskId = taskIdFromCorr(corr);
  if (!taskId) return { allowed: true };
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let card;
  try {
    card = JSON.parse(read(path.join(intelDir(), 'tasks', `${taskId}.json`)));
  } catch { return { allowed: true }; }
  const state = String(card.state || '');
  const blocker = String(card.blocker || '').trim();
  const dispatchable = ['ready', 'queued', 'running', 'review'].includes(state);

  // Un kind fuera del vocabulario cerrado NO MATCHEA NINGUNA REGLA, y por eso
  // no pasa por ningun gate de contrato: es el unico camino de despacho sin
  // control. Medido el 2026-08-29 con T-0262 (kind "data-fix"), que un
  // orchestrator headless despacho como DELETE sobre la DB de un TERCERO. El
  // test R.2 de intel-registries venia gritandolo desde el 25-ago; nadie lo
  // conecto con el despacho porque el gate no lo miraba.
  //
  // Se chequea ANTES del estado a proposito: si la tarjeta no esta gobernada,
  // que este "ready" es irrelevante. Fail-open si kinds.json no se puede leer
  // o no se entiende — un gate que falla cerrado sobre su propio registro
  // paraliza el fleet, que es peor que el agujero que tapa.
  const kind = String(card.kind || '').trim();
  if (dispatchable && kind) {
    const known = readKnownKinds(read);
    if (known && !known.has(kind)) {
      return {
        allowed: false,
        state,
        reason: `card ${taskId} declares kind "${kind}", which is NOT in kinds.json — it matches no contract rule, so it passes no gate. Dispatching it is dispatching through the one unchecked path. Either add "${kind}" to the closed vocabulary (an operator decision: it defines what the kind is allowed to do) or retag the card to a governed kind`,
      };
    }
  }

  if (dispatchable && !blocker) {
    const closed = closingRulingAfterMove(taskId, card, read);
    if (!closed) return { allowed: true };
    return {
      allowed: false,
      state,
      reason: `card ${taskId} is open in state "${state}" but a ruling dated ${closed.at} declares it RESOLVED, and the card has not moved since — the ledger and rulings.jsonl disagree. Either move the card (ledger.cjs) or append a ruling declaring the reopen; do not dispatch finished work`,
    };
  }
  return {
    allowed: false,
    reason: blocker
      ? `card ${taskId} carries an UNRESOLVED blocker ("${blocker.slice(0, 140)}${blocker.length > 140 ? '…' : ''}") — a peer's word does not lift a gate; resolve it ON the card (ledger.cjs) before dispatching`
      : `card ${taskId} is in state "${state}" (not dispatchable) — update the card first; the card is the authority, not the envelope`,
    state,
  };
}

/**
 * R2 (robo swarm-forge, 2026-08-24): validate the DRAFT before transport.
 * swarm-forge's handoff daemon rejects malformed handoff files before queuing;
 * here the fleet contract is "every type=result carries a criteria: block with
 * per-criterion pass|fail" (docs/a2a-protocol.md), and until today it was
 * detected (detectV2) but never enforced — prose-only results kept arriving.
 *
 * Enforced only at the SENDER whose server has this code (runtime≠repo:
 * old servers keep sending unchecked until restarted — mm-fe58 class).
 * Escape hatch: WEZBRIDGE_RESULT_SHAPE_ENFORCE=0 reverts to warn-only.
 */
function checkResultShape({ type, body }) {
  if (type !== 'result') return { allowed: true };
  if (process.env.WEZBRIDGE_RESULT_SHAPE_ENFORCE === '0') return { allowed: true };
  const shape = detectV2(body);
  if (shape === 'ok') return { allowed: true };
  return {
    allowed: false,
    shape,
    reason: shape === 'missing'
      ? 'type=result requires a criteria: block (fleet contract, docs/a2a-protocol.md). Add:\ncriteria:\n- <criterion>: pass|fail — <evidence>\n(plus files_changed / next_action). Re-send with the block included.'
      : 'the criteria: block has no pass|fail verdicts — each criterion needs an explicit "pass — <evidence>" or "fail — <reason>" line. Re-send with verdicts.',
  };
}

/**
 * M1 (retro 2026-08-24): lease-on-dispatch. T-0222 sat 15h in `running` with
 * lease:null — an orphan nobody was executing, invisible until a steward
 * finding caught it. A dispatched request now TAKES the card's lease for the
 * executor (project name preferred: pane ids die on wezterm restart, T-0235),
 * so "running without an owner" becomes impossible by construction for any
 * work dispatched through a2a_send.
 *
 * Refuses only on a PROVABLE conflict (card leased to someone else, unexpired).
 * Everything else fails OPEN with a warning: lease plumbing breaking must not
 * take fleet comms down with it. ledger.cjs stays the only tasks/ writer —
 * this shells out to its CLI instead of touching the JSON.
 */
function takeDispatchLease({ corr, type, owner, minutes = 90, runLease } = {}) {
  if (type !== 'request') return { ok: true, skipped: 'not-a-request' };
  // W2: mismo parser que el gate — un corr prefijado sigue tomando la lease de
  // SU tarjeta. Antes, todo despacho con la convencion de Eve corria sin dueno.
  const taskId = taskIdFromCorr(corr);
  if (!taskId) return { ok: true, skipped: 'not-a-task-corr' };
  if (!owner) return { ok: true, warning: 'no owner resolvable — lease not taken' };
  const run = runLease || ((id, own, min) => {
    const { execFileSync } = require('node:child_process');
    const ledger = path.join(intelDir(), '..', '_docs-curation', 'ledger.cjs');
    return execFileSync(process.execPath, [ledger, 'lease', id, '--owner', String(own), '--minutes', String(min)], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
  });
  try {
    run(taskId, owner, minutes);
    return { ok: true, leased: { corr, owner, minutes } };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/already leased by/i.test(msg)) {
      const m = msg.match(/already leased by (\S+) until (\S+)/i);
      return {
        ok: false,
        reason: `card ${taskId} is already leased by ${m ? m[1] : 'another owner'}${m ? ` until ${m[2]}` : ''} — two executors on one card is the orphan-running bug in reverse. Release the lease (ledger.cjs release ${taskId}) or dispatch to the current owner.`,
      };
    }
    return { ok: true, warning: `lease not taken (${msg.slice(0, 120)}) — dispatch allowed, but the card has no owner on record` };
  }
}

/**
 * Name the `pass` verdicts whose evidence cites nothing checkable.
 *
 * The most repeated failure of 2026-08-24/25, five separate instances across
 * three panes: a Checkpoint task returning 0 while writing no backup; a green
 * suite while it emptied a profile; a PPR-7 check reporting PASS while counting
 * 6,752 unrecorded outcomes; a test file CI never executes because of its
 * marker; and a reviewer reporting "missing tests" for ten covered functions
 * because it counted definitions instead of invocations. Same shape every time:
 * "it finished without error" was accepted as "it did the thing".
 *
 * The rule that survived all five: a green check counts only if you can NAME
 * the artifact it produced — the backup file, the row, the SHA, the count, the
 * test that ran. So this looks for an artifact TOKEN in each passing
 * criterion's evidence: a number, a path, a hash, a URL, or quoted output.
 *
 * It never blocks and never calls a criterion wrong — it only says which passes
 * cite nothing. Blocking on a heuristic would punish honest phrasing, and a
 * guard that fires on compliant work is worse than no guard at all: it teaches
 * people to spend context appeasing it.
 */
const ARTIFACT_TOKEN = /\d|[/\\][\w.-]|https?:\/\/|`[^`]+`|\.(js|cjs|ts|py|json|md|sql|gz|yml|yaml)\b/i;

// Naming a thing is citing it even without a number: "CSP completa, HSTS,
// nosniff, X-Frame DENY" is real evidence and must never be flagged — that
// exact line came from a live result and this guard tried to bite it. But an
// acronym that carries no information about WHAT was produced does not count.
const EMPTY_ACRONYMS = new Set(['OK', 'PASS', 'FAIL', 'SI', 'NO', 'YES', 'TODO', 'NA']);
const NAMED_TOKEN = /\b[A-Z][A-Z0-9-]+\b/g;

function citesArtifact(evidence) {
  if (ARTIFACT_TOKEN.test(evidence)) return true;
  for (const m of evidence.matchAll(NAMED_TOKEN)) {
    if (!EMPTY_ACRONYMS.has(m[0])) return true;
  }
  return false;
}

function weakPasses(body) {
  const lines = String(body || '').split('\n');
  const weak = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]?\s*(.+?):\s*pass\b\s*(?:[—:-]\s*(.*))?$/i);
    if (!m) continue;
    const criterion = m[1].trim();
    const evidence = (m[2] || '').trim();
    if (!citesArtifact(evidence)) weak.push(criterion);
  }
  return weak;
}

/**
 * Detect an A2A envelope hand-written into a raw prompt.
 *
 * Every fleet safety control — the dispatch gate, the result-shape check, the
 * lease, the durable queue, the audit event — lives in a2a_send. send_prompt
 * has none of them. So typing the envelope by hand and pushing it through
 * send_prompt is not a shortcut, it is the bypass: the receiving pane cannot
 * tell the two apart, and nothing anywhere records that the message existed.
 *
 * Measured 2026-08-25 (mm-6043): a request to delete a 16 GB LIVE database
 * volume reached a pane signed "orchestrator-headless" on corr T-0192, and
 * events.jsonl — holding 4789 a2a.sent records, provably logging other
 * envelopes of that same corr within 90 seconds — had no record of it at all.
 * The pane refused because it re-derived against the system, not because any
 * control caught it. There was no control to catch it.
 *
 * Matches the envelope SHAPE rather than a specific sender, because the sender
 * field is exactly the part a hand-written envelope is free to invent.
 */
function detectSmuggledEnvelope(text) {
  const s = String(text || '');
  const m = s.match(/\[A2A\b[^\]]*\|\s*corr=([^\s|\]]+)[^\]]*\|\s*type=([a-z]+)[^\]]*\]/i);
  if (!m) return { smuggled: false, corr: null, type: null };
  return { smuggled: true, corr: m[1], type: m[2].toLowerCase() };
}

module.exports = { intelDir, buildEnvelope, taskIdFromCorr, detectV2, detectAbandons, detectDecisions, detectEvidence, recordEvent, recordResultBody, updateThreads, autoAckResult, checkDispatchGate, checkResultShape, takeDispatchLease, detectSmuggledEnvelope, weakPasses };
