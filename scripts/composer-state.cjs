'use strict';
/**
 * composer-state.cjs — "is the prompt still sitting unsent in the composer?"
 *
 * Extracted from poke-pane.cjs on 2026-08-14 for one reason: poke-pane.cjs is a
 * top-level script with no exports, so the only way to test it was to grep its
 * source text. That test then broke when a THIRD ARGUMENT was added to an
 * unrelated call — the behaviour was perfect, the regex was stale — and, far
 * worse, it would have stayed GREEN if the Enter write had been deleted while a
 * comment still mentioned it. A test that matches source text is measuring the
 * spelling, not the behaviour. Same fix as src/a2a-length-guard.cjs got a day
 * earlier: give the decision a module so it can be exercised with real input.
 *
 * WHY THIS DECISION MATTERS AT ALL. A successful `wezterm cli send-text` proves
 * bytes arrived, not that the pane accepted them. Bracketed paste makes some
 * TUIs hold text in the composer indefinitely. So delivery is verified by the
 * composer going EMPTY, never by finding the text echoed in the pane — echo is
 * exactly what an unsent prompt looks like.
 */

/**
 * @param tail    recent pane text from `wezterm cli get-text`
 * @param payload what we tried to submit
 * @returns true when the payload still appears to be sitting in the composer
 */
function composerStillHolds(tail, payload) {
  const flat = (value) => String(value).replace(/\s+/g, ' ').trim().toLowerCase();
  const probe = flat(payload).slice(0, 60);
  if (!probe) return false;
  const lines = String(tail).split(/\r?\n/);
  const markers = lines.filter((line) => /^[\s│|]*[❯>›]/u.test(line));
  const last = markers.at(-1) || '';
  const content = flat(last.replace(/^[\s│|]*[❯>›]\s*/u, ''));
  return Boolean(content) && (
    probe.startsWith(content.slice(0, 40)) ||
    content.startsWith(probe.slice(0, 40)) ||
    (content.length >= 8 && flat(payload).includes(content.slice(0, 60))) ||
    // A collapsed paste ("[Pasted text +12 lines]") is the composer holding the
    // payload under a different name. Treating it as cleared is how a long poke
    // gets reported delivered while it sits there untouched.
    /\[?pasted (text|content)|\+\s*\d+\s+lines?\]?/i.test(content)
  );
}

module.exports = { composerStillHolds };
