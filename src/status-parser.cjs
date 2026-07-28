/**
 * Shared status-bar parser for Claude Code pane output.
 *
 * Extracts Ctx%, Session%, Weekly%, and model name from the status bar line(s)
 * Claude Code renders at the bottom of each pane. Used by:
 *   - omni-watcher.cjs (periodic metrics emission)
 *   - pane-discovery.cjs (expose per-pane ctx so the dashboard can show badges
 *     and the auto-handoff daemon can decide when to suggest/enforce resets)
 *
 * Returns null when no known fields matched — callers should treat that as
 * "not a Claude Code pane" / "status bar not visible yet".
 */

function parseStatusBar(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
  // ctx has FOUR real shapes in the wild and v1 only matched the oldest one, so
  // context-used silently read null on every live pane (found 2026-07-28: 0 of
  // 17 panes reported ctx while session/weekly parsed fine). Context exhaustion
  // is the single most actionable per-pane signal — a handoff is needed before
  // it hits the wall — so a null here is not cosmetic.
  //   "Ctx Used: 29.0%"   current Claude Code statusline
  //   "Ctx: 29%"          legacy Claude Code
  //   "Context 83% used"  codex
  //   "Context 47% left"  codex — inverted, must be converted
  const ctxUsed = text.match(/Ctx(?:\s+Used)?:\s*([\d.]+)%/i)
    || text.match(/Context\s+([\d.]+)%\s*used/i);
  const ctxLeft = ctxUsed ? null : text.match(/Context\s+([\d.]+)%\s*left/i);
  const session = text.match(/Session:\s*([\d.]+)%/i);
  const weekly = text.match(/Weekly:\s*([\d.]+)%/i);
  const model = text.match(/Model:\s*([^\s]+)/);
  if (!ctxUsed && !ctxLeft && !session && !weekly) return null;
  return {
    ctx: ctxUsed ? parseFloat(ctxUsed[1])
      : (ctxLeft ? Math.round((100 - parseFloat(ctxLeft[1])) * 10) / 10 : null),
    session: session ? parseFloat(session[1]) : null,
    weekly: weekly ? parseFloat(weekly[1]) : null,
    model: model ? model[1] : 'unknown',
  };
}

module.exports = { parseStatusBar };
