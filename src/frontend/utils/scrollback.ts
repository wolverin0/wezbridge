/**
 * Status-bar pattern set. Used by OmniTab's "Recent DECISION lines" filter
 * to drop Claude CLI status-bar repaints / spinner frames before testing
 * for the DECISION token.
 *
 * Render fidelity itself moved to the embedded xterm.js (XtermPane) — the
 * SGR parser and CR-collapse logic that lived here previously is gone. The
 * canonical XTerm protocol implementation in @xterm/xterm renders these
 * correctly without any of our hand-rolled parsing.
 */

export const STATUS_BAR_PATTERNS: RegExp[] = [
  /^─{10,}$/,
  /^Model:\s.*Thinking:/,
  /^Ctx:\s*\d+(\.\d+)?%.*Context:/,
  /^cwd:\s.*(Reset|Session|Weekly):/,
  /^⏵⏵\s*(bypass permissions|auto mode)/,
  /^⏵⏵\s/,
  /^⏸⏸\s/,
  /^Calling plugin:.*ctrl\+o to expand/,
  /^Called plugin:.*ctrl\+o to expand/,
  /^Thinking:\s*(high|medium|low|minimal|auto)/,
  /^\s*Tip:/,
  /^\s*\?\s*for shortcuts/,
  /running stop hook/,
  /^\s*Found \d+ settings? issue/,
  /Stop hook error/,
  /thinking with .*?effort/,
  /thought for \d+s/,
  /^[\s·●✶✻✽*✢⠂⠐+]*\s*(Thinking|Hmm…|This one needs a moment|Working through it)\s*$/i,
  /^[\s·●✶✻✽*✢⠂⠐+]*\s*\w+…\s*\(\d+[ms] /,
];
