'use strict';
/**
 * a2a-length-guard.cjs — refuse over-long A2A bodies BEFORE they are sent.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES INLINE: mcp-server.cjs has no
 * exports and requiring it would start a server, so anything defined there can
 * only be "tested" by grepping the source. That is not a test. The first
 * version of this guard was verified exactly that way, and a mutation that
 * disabled the condition outright left the suite green — because the constant
 * name still appeared inside the refusal message the guard returns. A test that
 * survives the removal of the thing it tests is not a test.
 *
 * WHY THE GUARD EXISTS AT ALL: a2a_send already detected truncation and
 * reported DELIVERY INTEGRITY FAILURE — after sending. A warning that arrives
 * afterwards only teaches the caller to retry shorter, so the rule is
 * re-learned every session and obeyed only once caught. On 2026-08-13 pane-0
 * truncated FIVE envelopes in one session, one of them an hour after publishing
 * a self-audit about this exact failure.
 *
 * The failure being prevented is SILENT ON THE RECEIVING END: the peer gets a
 * partial instruction with no way to know something was cut. That asymmetry is
 * why the default is refuse rather than warn.
 */

/**
 * Soft ceiling before the tool refuses and points the caller at a file.
 *
 * NOT a hard protocol limit (that is INPUT_BYTE_LIMITS.prompt, 16KB). This is
 * where recipient composers were observed truncating in practice. Provisional,
 * from one day's sample: every envelope under ~1000 chars arrived intact; the
 * ones that truncated were ~1400+. Raise it if the evidence changes — but the
 * default must stay refuse.
 */
const A2A_BODY_SOFT_LIMIT = Number(process.env.WEZBRIDGE_A2A_SOFT_LIMIT) || 1200;

/**
 * PURE: the refusal text for an over-long body, or null to allow.
 *
 * `allowLong` must be boolean true to opt out. Truthy strings and numbers do
 * NOT count — an escape hatch that opens on any truthy value is one a caller
 * trips accidentally, which defeats the point of having it.
 */
function a2aLengthRefusal(body, allowLong, limit = A2A_BODY_SOFT_LIMIT) {
  const len = String(body).length;
  if (len <= limit || allowLong === true) return null;
  return `a2a_send REFUSED: body is ${len} chars (soft limit ${limit}). `
    + 'Long envelopes get truncated by the recipient composer and arrive silently incomplete.\n\n'
    + 'Do this instead: write the content to a repo file (e.g. _intel/briefs/<topic>.md) and send a '
    + 'short pointer to that path. The peer reads the file; nothing is lost in transit.\n\n'
    + 'If the payload genuinely must go inline, re-send with allow_long: true.';
}

module.exports = { a2aLengthRefusal, A2A_BODY_SOFT_LIMIT };
