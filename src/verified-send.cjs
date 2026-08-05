// verified-send.cjs — verified prompt delivery to a pane's TUI composer.
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

function createVerifiedSend({ wez, sleep }) {
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
  async function sendPromptDeferredEnter(paneId, text) {
    wez.sendTextBracketed(paneId, text); // atomic; internal newlines stay soft
    await sleep(400);
    const delivered = composerHoldsTail(paneId, text);
    wez.sendTextNoEnter(paneId, '\r'); // separate real Enter = single submit
    return delivered;
  }

  return { verifyPromptSubmission, composerHoldsTail, sendPromptDeferredEnter };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bound = createVerifiedSend({ wez: require('./wezterm.cjs'), sleep: defaultSleep });

module.exports = {
  inputBoxContent,
  createVerifiedSend,
  verifyPromptSubmission: bound.verifyPromptSubmission,
  composerHoldsTail: bound.composerHoldsTail,
  sendPromptDeferredEnter: bound.sendPromptDeferredEnter,
};
