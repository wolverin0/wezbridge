'use strict';
/**
 * option-question.cjs — pure detector: does this operator blocker pose a
 * multi-option question (T-0495)? sp-bridge.cjs attached the three /act
 * links (approved/cancelled/deferred) to EVERY operator-gated card, even
 * ones asking the operator to pick among 2+ lettered/numbered options like
 * "(a) podar sin retencion, (b) dejarlo pausado". A tap on those links can't
 * say WHICH option, and approved/cancelled un-gates or completes the card
 * without answering the real question (evidence: _intel/evidence/wezbridge/
 * 2026-09-20-botones-binarios-preguntas-de-opciones.md).
 *
 * Pure: no IO, no state, no dependency on sp-bridge/action-links. A marker
 * is a single letter or digit wrapped "(a)" or bare "a)", sitting at a text
 * boundary on BOTH sides (start of string/line, or whitespace/",;:" before;
 * whitespace/".,;:" or end of string after). That boundary requirement is
 * the false-positive guard: "(a)" glued into a URL or an identifier
 * (".../act?x=(a)&y", "task(a)bort") has a non-boundary char right before
 * the "(" or the letter, so it never matches. A SINGLE marker in the whole
 * text is not a menu (own guard: hasOptionQuestion requires >= 2 distinct).
 */
const MARKER_RE = /(?:^|[\s,;:])\(?([A-Za-z0-9])\)(?=[\s.,;:]|$)/gm;

/** Distinct marker letters/digits found in text, in order of first appearance. */
function extractOptionMarkers(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text))) {
    const key = m[1].toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(m[1]); }
  }
  return out;
}

/** True when the text offers 2+ DISTINCT lettered/numbered options — a menu, not a yes/no. */
function hasOptionQuestion(text) {
  return extractOptionMarkers(text).length >= 2;
}

module.exports = { hasOptionQuestion, extractOptionMarkers };
