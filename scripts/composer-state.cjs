'use strict';
/**
 * composer-state.cjs — "que hay en el composer respecto de MI payload".
 * Un solo modulo, importado por poke-pane.cjs (T-0303: poke-pane tenia una COPIA
 * local de composerStillHolds; dos copias es como el arreglo llega a una sola).
 *  · composerContent(tail): la linea viva del composer, normalizada. Reusa
 *    inputBoxContent de src/verified-send.cjs — la misma extraccion que usa el
 *    camino MCP, y la que quita el BORDE DERECHO (│) que la copia vieja dejaba.
 *  · composerStillHolds(tail, payload): el payload sigue sin enviarse. Detecta
 *    CABEZA, COLA o cualquier fragmento (>= 4 chars) del payload, y el paste
 *    colapsado. La version anterior solo podia ver la cabeza: un envio
 *    fragmentado deja la COLA, asi que el guard era estructuralmente incapaz de
 *    disparar sobre su propio modo de falla (T-0303, medido 2026-08-30).
 *  · pasteLandedIntact(tail, payload): DESPUES de pegar y ANTES del Enter: el
 *    composer tiene que mostrar la cabeza del payload (o el paste colapsado).
 *    Si muestra otra cosa, el paste no entro como UN prompt (fragmentado con
 *    --no-paste, o texto ajeno ya estaba ahi) y NO hay que apretar Enter.
 *
 * Extracted from poke-pane.cjs on 2026-08-14: a script with no exports only
 * gets tested by grepping its source, and that test measures spelling, not
 * behaviour. Delivery is verified by the composer going EMPTY, never by echo.
 */
const { inputBoxContent } = require('../src/verified-send.cjs');

const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const COLLAPSED_PASTE_RE = /\[?pasted (text|content)|\+\s*\d+\s+lines?\]?/i;

/** @returns la linea viva del composer (sin marcador ni bordes), '' si no hay. */
function composerContent(tail) {
  if (!tail) return '';
  return inputBoxContent(String(tail).split(/\r?\n/));
}

/**
 * @param tail    recent pane text from `wezterm cli get-text`
 * @param payload what we tried to submit
 * @returns true when ANY visible piece of the payload still sits in the composer
 */
function composerStillHolds(tail, payload) {
  const norm = flat(payload);
  if (!norm) return false;
  const content = composerContent(tail);
  if (!content) return false;
  if (COLLAPSED_PASTE_RE.test(content)) return true;
  const probe = norm.slice(0, 60);
  return (
    probe.startsWith(content.slice(0, 40)) ||     // cabeza (posiblemente truncada por el ancho)
    content.startsWith(probe.slice(0, 40)) ||
    norm.endsWith(content) ||                     // cola exacta
    (content.length >= 4 && norm.includes(content.slice(0, 60)))  // cualquier fragmento
  );
}

/**
 * @returns 'intact' | 'collapsed' | 'fragmented' | 'empty'
 *   intact     el composer muestra la cabeza del payload: el paste entro entero.
 *   collapsed  "[Pasted text +N lines]": entero pero no legible; se acepta.
 *   fragmented el composer muestra OTRA cosa: una linea posterior del payload
 *              (se tipeo con --no-paste y las anteriores ya se submitearon) o
 *              texto ajeno. Apretar Enter aca es lo que fragmenta/hibrida.
 *   empty      sin linea de composer legible (shell, pane ilegible): no se
 *              puede afirmar nada; el llamador decide (poke-pane sigue y avisa).
 */
function pasteLandedIntact(tail, payload) {
  const content = composerContent(tail);
  if (!content) return 'empty';
  if (COLLAPSED_PASTE_RE.test(content)) return 'collapsed';
  const head = flat(payload).slice(0, 40);
  if (!head) return 'empty';
  const shown = content.slice(0, 40);
  if (head.startsWith(shown) || shown.startsWith(head)) return 'intact';
  return 'fragmented';
}

module.exports = { composerContent, composerStillHolds, pasteLandedIntact, COLLAPSED_PASTE_RE };
