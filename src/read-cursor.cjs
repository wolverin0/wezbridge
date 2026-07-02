'use strict';

// read_output delta cursors (v3.5). A cursor is a base64 fingerprint of the
// last lines of a read; on the next read, everything after the fingerprint
// match is "new". Cheap polling for A2A requesters (esp. Codex, which must
// poll) without re-reading the whole tail every time.

function trimTrailingEmpty(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end);
}

function makeReadCursor(lines) {
  const trimmed = trimTrailingEmpty(lines);
  // Drop the very last line: it's the LIVE prompt/input line and mutates in
  // place ("$" becomes "$ echo next-cmd"), which both breaks matching and —
  // worse — bare prompt lines repeat, so a fingerprint ending on one can
  // match the NEWEST occurrence and swallow the whole delta. Three lines of
  // context above the live line (command + output) are effectively unique.
  const body = trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
  const fp = body.slice(-3);
  return Buffer.from(JSON.stringify(fp), 'utf-8').toString('base64');
}

// Returns lines after the cursor match, or null if the cursor no longer
// matches (scrolled out of the window / invalid) — caller falls back to full.
function sliceAfterCursor(lines, cursorB64) {
  let fp;
  try { fp = JSON.parse(Buffer.from(String(cursorB64), 'base64').toString('utf-8')); } catch { return null; }
  if (!Array.isArray(fp) || fp.length === 0 || !fp.every((l) => typeof l === 'string')) return null;
  const trimmed = trimTrailingEmpty(lines);
  for (let i = trimmed.length - fp.length; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < fp.length; j++) {
      if (trimmed[i + j] !== fp[j]) { match = false; break; }
    }
    if (match) return trimmed.slice(i + fp.length);
  }
  return null;
}

module.exports = { trimTrailingEmpty, makeReadCursor, sliceAfterCursor };
