// verified-send.cjs — verified prompt delivery to a pane's TUI composer, plus
// classifyDelivery(): the ONE verdict function (delivered | failed | unverified)
// that the waker, the project queue and the decision relay all share.
// Extracted verbatim from mcp-server.cjs (2026-08-05, walksim-pilot chunk B) so the
// DAEMON can send with the same guarantees as the MCP path; mcp-server re-requires
// from here. Behaviour is contract: three hard-won fixes live in these functions
// (multi-line composer stuck-detection 07-10, bracketed-paste anti-splice 07-21,
// collapsed-paste false-truncation 07-25). Do not "simplify" them.
//
// createVerifiedSend(deps) returns the API bound to injectable deps for tests;
// the module's top-level exports are bound to the real wezterm module.
'use strict';

// The BOTTOM-MOST prompt-marker line (❯ / > / ›, optionally behind a box border)
// is the live input box; everything above is scrollback.
function inputBoxContent(tailLines) {
  const markers = tailLines.filter((l) => /^[\s│|]*[❯>›]/.test(l));
  const last = markers[markers.length - 1] || '';
  return last.replace(/^[\s│|]*[❯>›]\s*/, '').replace(/[\s│|]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── T-0242 / AC6 — el composer retiene texto AJENO, no entregar encima ──────
// Reproducido en vivo 2026-08-28: TRES panes (infra, memorymaster, wabot)
// tenian instrucciones del operador SIN ENVIAR, y los tres reportaban `idle`.
// `idle` NO significa composer vacio. Un envio en esa ventana no manda el
// sobre: manda "texto del operador + sobre" concatenados como UN solo prompt.
//
// Y diferir es la unica salida, no una entre varias: un Enter inyectado NO
// vacia un composer con texto tipeado a mano — medido con 3 intentos (2 por
// MCP send_key, 1 por `wezterm cli send-text` directo). El reintento de Enter
// de verifyPromptSubmission no rescata este caso.
//
// Es el MISMO predicado que verifica entrega (inputBoxContent), corrido ANTES
// en vez de DESPUES: alli se pregunta "¿sigue MI texto?", aca "¿hay texto de
// alguien?".

// Chrome del TUI que OCUPA la linea del composer sin ser texto del usuario.
// MEDIDO, no supuesto: un placeholder tratado como texto retenido cortaria
// toda entrega a ese tipo de pane — el falso positivo es peor que el bug.
const COMPOSER_PLACEHOLDERS = [
  'ask codex to do anything',   // codex CLI, medido en pane 35 (omniremote)
];

/**
 * @param tail texto reciente del pane (`wezterm cli get-text`)
 * @returns true si el composer retiene texto que el pane todavia NO envio.
 *
 * FAIL-OPEN a proposito (tail vacio/ilegible => false): misma postura que el
 * resto del camino de entrega. Un guard que falla cerrado sobre un pane que no
 * puede leer paraliza al fleet, y eso es peor que el bug que arregla.
 */
function composerHoldsForeignText(tail) {
  if (!tail) return false;
  const content = inputBoxContent(String(tail).split(/\r?\n/));
  if (!content) return false;
  return !COMPOSER_PLACEHOLDERS.includes(content);
}

// ── W4 — el tercer estado: "no se pudo verificar" no es "entregado" ─────────
//
// MEDIDO: waker, project-queue y mcp-server calculaban todos
// `ok = submitted !== 'stuck' && delivered !== 'truncated'`, y eso cuenta
// 'unknown' (pane ilegible, shell no-TUI, get-text que tiró) como ENTREGA
// VERIFICADA. El intent salía de la cola y el sobre no había llegado a ninguna
// parte. Un instrumento que informa éxito sobre algo que no pudo mirar es peor
// que no tener instrumento.
//
// Los dos vocabularios son los de este módulo, no inventados:
//   `delivered` viene de composerHoldsTail    -> 'ok' | 'truncated' | 'unknown'
//   `submitted` viene de verifyPromptSubmission -> 'submitted' | 'stuck' | 'unknown'
//
// Pura a propósito: es la MISMA regla en los tres consumidores, y cada uno
// decide qué hacer con 'unverified' (el waker reintenta y flaggea; la cola
// difiere). Lo único que ninguno puede hacer es tratarlo como entrega.
function classifyDelivery(delivered, submitted) {
  if (submitted === 'submitted' && delivered === 'ok') return 'delivered';
  if (submitted === 'stuck' || delivered === 'truncated') return 'failed';
  return 'unverified';
}

/** Motivo unico de rechazo de la primitiva; los llamadores comparan contra esto, no contra prosa. */
const REFUSED_COMPOSER_FOREIGN_TEXT = 'composer-foreign-text';
const isRefusal = (r) => Boolean(r && typeof r === 'object' && r.refused);

function createVerifiedSend({ wez, sleep, logAction = null }) {
  // Returns 'submitted' | 'stuck' | 'unknown' (pane unreadable / non-TUI shell).
  async function verifyPromptSubmission(paneId, text, { retries = 2, settleMs = 700 } = {}) {
    const norm = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
    const probe = norm.slice(0, 60);
    if (!probe) return 'unknown';
    for (let attempt = 0; attempt <= retries; attempt++) {
      await sleep(attempt === 0 ? settleMs : 900);
      let tailLines;
      try {
        wez.invalidateGetTextCache(paneId);
        tailLines = wez.getFullText(paneId, 25).split('\n');
      } catch {
        return 'unknown';
      }
      const content = inputBoxContent(tailLines);
      // MULTI-LINE fix (operator-observed 2026-07-10, new codex composer): with
      // a multi-line prompt the visible composer line is the LAST line of the
      // paste (or a "[pasted …]" placeholder), NOT the head — comparing only
      // against the head reported 'submitted' while the whole envelope sat
      // unsubmitted. Stuck if the composer shows the head, ANY slice of our
      // text, or a paste placeholder.
      const stuck = content.length > 0 && (
        probe.startsWith(content.slice(0, 40)) ||
        content.startsWith(probe.slice(0, 40)) ||
        (content.length >= 8 && norm.includes(content.slice(0, 60))) ||
        /\[?pasted (text|content)|\+\s*\d+\s+lines?\]?/i.test(content)
      );
      if (!stuck) return 'submitted';
      // Text still in the input box — a fresh, time-separated enter (empty
      // send-text + appended \r, same path as send_key('enter')) unsticks it.
      try { wez.sendText(paneId, ''); } catch { /* ignore */ }
    }
    return 'stuck';
  }

  // Lee el tail UNA vez y aplica el UNICO predicado (composerHoldsForeignText);
  // `held` es el extracto para el reporte/log, no una segunda deteccion.
  // Fail-open ante un pane ilegible, igual que verifyPromptSubmission.
  function heldForeignText(paneId) {
    try {
      wez.invalidateGetTextCache(paneId);
      const tail = wez.getFullText(paneId, 25);
      if (!composerHoldsForeignText(tail)) return null;
      return inputBoxContent(String(tail).split(/\r?\n/));
    } catch { return null; }
  }

  // Version ligada al pane: lee el tail y aplica el predicado.
  function paneComposerHoldsForeignText(paneId) {
    return heldForeignText(paneId) !== null;
  }

  // Delivery-INTEGRITY verdict, distinct from submission: 'ok' if the composer
  // visibly holds the tail of our payload before submit, 'truncated' if missing,
  // 'unknown' if unreadable or the paste is collapsed. A truncated message
  // clears the box on Enter too, so submission != integrity.
  function composerHoldsTail(paneId, text) {
    const norm = String(text).replace(/\s+/g, ' ').trim();
    const tail = norm.slice(-40).toLowerCase();
    if (tail.length < 8) return 'ok'; // too short to meaningfully verify
    let rendered;
    try {
      wez.invalidateGetTextCache(paneId);
      rendered = wez.getFullText(paneId, 40).replace(/\s+/g, ' ').toLowerCase();
    } catch { return 'unknown'; }
    if (rendered.includes(tail)) return 'ok';
    // Claude Code collapses long pastes ("[Pasted text #N ...]" / "paste again
    // to expand") — content intact but its literal tail is not rendered, which
    // read as a FALSE truncation (first seen 2026-07-25, T-0002 dispatch).
    // Collapsed paste = integrity unverifiable, not failed.
    if (/\[pasted text|paste again to expand/.test(rendered)) return 'unknown';
    return 'truncated';
  }

  // Two-phase send: BODY as a bracketed paste, then a SEPARATE real Enter.
  // Bracketed paste keeps internal newlines soft (no per-line submits / splice
  // corruption); the trailing CR is sent separately because a bracketed
  // paste's own newline is soft and never submits.
  //
  // T-0323 (2026-09-02, dano real): la defensa contra un composer con texto
  // AJENO vivia SOLO en el wrapper de la cola; la primitiva confiaba en el
  // llamador. Un llamador directo (node, script, runtime viejo) pego un sobre
  // detras de una frase del operador sin enviar y el Enter diferido submiteo el
  // hibrido. Ahora el guard vive ACA: sin `force`, la primitiva rehusa y NO
  // toca el pane — ni paste ni Enter (un Enter sobre texto ajeno lo manda).
  // Pisar a proposito exige `force: true` + `why`, y queda en action-log como
  // `composer-override` con el texto pisado. Fail-open si el pane no se lee.
  async function sendPromptDeferredEnter(paneId, text, { force = false, why = '' } = {}) {
    const held = heldForeignText(paneId);
    if (held !== null) {
      if (!force) return { refused: REFUSED_COMPOSER_FOREIGN_TEXT, held, pane: paneId };
      if (!String(why || '').trim()) {
        throw new Error(`sendPromptDeferredEnter(pane ${paneId}): force:true requires a why — the composer holds unsent text ${JSON.stringify(held.slice(0, 80))} and overriding it is an audited action`);
      }
      const logFn = logAction || require('./action-log.cjs').logAction;
      logFn('composer-override', { target: `pane-${paneId}`, why: String(why).trim(), extra: { held, bytes: Buffer.byteLength(String(text), 'utf8') } });
    }
    wez.sendTextBracketed(paneId, text); // atomic; internal newlines stay soft
    await sleep(400);
    const delivered = composerHoldsTail(paneId, text);
    wez.sendTextNoEnter(paneId, '\r'); // separate real Enter = single submit
    return delivered;
  }

  return { verifyPromptSubmission, composerHoldsTail, sendPromptDeferredEnter, paneComposerHoldsForeignText };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bound = createVerifiedSend({ wez: require('./wezterm.cjs'), sleep: defaultSleep });

module.exports = {
  inputBoxContent,
  composerHoldsForeignText,
  classifyDelivery,
  COMPOSER_PLACEHOLDERS,
  REFUSED_COMPOSER_FOREIGN_TEXT,
  isRefusal,
  createVerifiedSend,
  verifyPromptSubmission: bound.verifyPromptSubmission,
  composerHoldsTail: bound.composerHoldsTail,
  sendPromptDeferredEnter: bound.sendPromptDeferredEnter,
  paneComposerHoldsForeignText: bound.paneComposerHoldsForeignText,
};
