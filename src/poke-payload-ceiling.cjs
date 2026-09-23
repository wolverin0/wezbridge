'use strict';
/**
 * poke-payload-ceiling.cjs — a measured, HONEST risk ceiling for scripts/poke-pane.cjs.
 *
 * Mirrors the shape of a2a-length-guard.cjs (same escape-hatch pattern: refuse
 * before attempting, opt out with an explicit flag) but does NOT copy its claim
 * that length alone predicts delivery. It does not, for poke-pane's transport
 * (bracketed paste over `wezterm cli send-text`, T-0303).
 *
 * MEASURED 2026-09-15 (three sends against real panes, same session):
 *   433 chars  -> OK
 *   1386 chars -> HEAD LOST (the failure this ceiling exists to catch)
 *   3733 chars -> OK
 * Three points, non-monotonic: the failure sits BETWEEN two successes. So a
 * length ceiling here is a RISK ZONE, not a predictor — it would correctly have
 * flagged the 1386 failure before it happened, but it would ALSO flag the 3733
 * send that was actually fine. Both are true at once and this module does not
 * pretend otherwise (AC5). What actually determines pass/fail is presumed to be
 * terminal-buffer/timing (flush boundaries, ConPTY repaint), not char count —
 * nothing here measures that, so nothing here claims to.
 *
 * WHAT THE CEILING CAN GUARANTEE: a payload under it was, on the one session
 * measured, never the one that lost its head; sends near or above it are far
 * enough into the failure's neighbourhood that trying blind is worse than
 * asking first.
 * WHAT IT CANNOT GUARANTEE: that everything under it lands intact (unmeasured
 * — only three datapoints exist), or that everything over it fails (3733 did
 * not). `--allow-long` exists because the caller may know their payload is
 * closer to the 3733 case than the 1386 one; the ceiling cannot tell those
 * apart by length.
 */

const MEASURED_20260915 = Object.freeze([
  { chars: 433, result: 'ok' },
  { chars: 1386, result: 'head lost' },
  { chars: 3733, result: 'ok' },
]);

// Below the smallest measured failure (1386): a payload under this length was
// never, in the one session measured, the one that lost its head. Provisional,
// like a2a's 900 — tighten or widen as more sessions are measured, never
// widened past what is actually measured-safe just to silence the warning.
const configuredLimit = Number(process.env.WEZBRIDGE_POKE_SOFT_LIMIT);
const POKE_PAYLOAD_CEILING = Number.isFinite(configuredLimit) && configuredLimit > 0
  ? Math.min(configuredLimit, 1200) : 1200;

/**
 * PURE: the warning text for an over-ceiling payload, or null to proceed.
 * `allowLong` must be boolean true — same contract as a2a's allow_long: a
 * truthy string/number does not count, so a caller cannot trip the escape by
 * accident (e.g. forwarding an unrelated flag object).
 */
function pokeCeilingWarning(payloadLength, allowLong, limit = POKE_PAYLOAD_CEILING) {
  const len = Number(payloadLength) || 0;
  if (len <= limit || allowLong === true) return null;
  return `WARN: payload is ${len} chars, over the measured ceiling (${limit}). `
    + 'This is a risk zone, not a hard rule — the 2026-09-15 measurement lost a '
    + 'head at 1386 chars but landed fine at 3733; length alone did not predict '
    + 'either outcome. Refusing to try blind rather than risk another FAIL(9) '
    + 'residue lock. Shorten the payload, or re-run with --allow-long if you '
    + 'accept the risk.';
}

module.exports = { POKE_PAYLOAD_CEILING, pokeCeilingWarning, MEASURED_20260915 };
