'use strict';
/**
 * orca-send.cjs — T-0596: the LAST HOP of a2a_send when the resolved destination
 * is an Orca terminal instead of a WezTerm pane. Orca is transport only — every
 * fleet control (dispatch gate, result-shape check, lease, durable queue, audit)
 * stays in mcp-server.cjs's a2a_send; this module only types+submits text via
 * `orca terminal send` and verifies delivery with a screen read-back, returning
 * the SAME submitted/delivered vocabulary as verified-send.cjs's classifyDelivery
 * ('submitted'|'stuck'|'unknown' and 'ok'|'truncated'|'unknown') so callers don't
 * need a transport-specific branch to interpret the result.
 * Key terms: sendToOrcaTerminal, screenShowsSubmittedBody, readScreenTail.
 * Read when: a2a_send resolves to_project to an Orca terminal (pane-identity.cjs
 * resolveOrca) and needs to deliver the envelope there.
 *
 * Idempotent retry: `orca terminal send --retry-request <id>` binds a retry id to
 * the exact payload + terminal incarnation (per `orca terminal send --help`). The
 * caller MUST derive that id from the queue entry (project-queue.cjs's entryId)
 * so a resend of the SAME envelope reuses the SAME id — a fresh random id per
 * call would defeat the whole point of the flag (see mcp-server.cjs a2a_send).
 */
const { execFile } = require('node:child_process');
const { inputBoxContent } = require('./verified-send.cjs');

const DEFAULT_ORCA_BIN = process.env.ORCA_CLI
  || 'C:/Users/pauol/AppData/Local/Programs/orca/resources/bin/orca.exe';

/** Default CLI runner: async, bounded — same shape as orca-census.cjs's defaultRunOrca. */
function defaultRunOrca(args, { bin = DEFAULT_ORCA_BIN, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { err.message = `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`; return reject(err); }
        resolve(stdout);
      });
  });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True when `body`'s distinctive head is visible in the terminal's tail lines
 * AND is not just sitting unsent in the composer line — same predicate shape as
 * verified-send.cjs's paneShowsSubmittedBody, generalized to a plain tailLines
 * array (Orca has no wez.getFullText, only `terminal read --screen`).
 * Fail-open (true) on a body too short to meaningfully verify, same stance as
 * the WezTerm primitives this mirrors.
 */
function screenShowsSubmittedBody(tailLines, body) {
  const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const probe = norm(body).slice(0, 60);
  if (probe.length < 12) return true;
  const key = probe.slice(0, 40).toLowerCase();
  const lines = Array.isArray(tailLines) ? tailLines : [];
  const composer = norm(inputBoxContent(lines)).toLowerCase();
  const tail = norm(lines.join(' ')).toLowerCase();
  const inComposer = composer.length > 0 && (composer.includes(key) || key.includes(composer.slice(0, 40)));
  return tail.includes(key) && !inComposer;
}

/** Read the rendered screen tail for one terminal. Returns an array of lines, or null (unreadable). */
async function readScreenTail(handle, { runOrca = defaultRunOrca, limit = 40 } = {}) {
  try {
    const stdout = await runOrca(['terminal', 'read', '--terminal', handle, '--screen', '--limit', String(limit), '--json']);
    const j = JSON.parse(stdout);
    if (!j || j.ok === false) return null;
    const r = (j && j.result) || {};
    const lines = (r.terminal && Array.isArray(r.terminal.tail)) ? r.terminal.tail : (Array.isArray(r.lines) ? r.lines : null);
    return Array.isArray(lines) ? lines : null;
  } catch { return null; }
}

/**
 * Send `body` to an Orca terminal and verify via a screen read-back.
 *
 * Returns { ok, submitted: 'submitted'|'unknown', delivered: 'ok'|'unknown',
 *           handle, retryId, tail, error }. `ok` is true only when the
 * read-back confirms the body landed on screen and is not stuck in the
 * composer — the same "don't trust the transport's own receipt" posture as
 * verified-send.cjs (W4): a CLI that reports ok:true but whose screen never
 * shows the text is NOT counted as delivered.
 */
async function sendToOrcaTerminal(handle, body, {
  runOrca = defaultRunOrca, sleep = defaultSleep, retryId = null, waitSubmitSeconds = 3, settleMs = 500,
} = {}) {
  const text = String(body);
  const args = ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'];
  if (waitSubmitSeconds) args.push('--wait-submit', String(waitSubmitSeconds));
  if (retryId) args.push('--retry-request', retryId);

  let sendJson = null;
  try {
    const stdout = await runOrca(args);
    try { sendJson = JSON.parse(stdout); } catch { sendJson = null; }
  } catch (e) {
    return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId, tail: null, error: e && e.message };
  }
  if (sendJson && sendJson.ok === false) {
    return {
      ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId, tail: null,
      error: `orca error: ${JSON.stringify(sendJson.error || sendJson).slice(0, 200)}`,
    };
  }

  await sleep(settleMs);
  const tail = await readScreenTail(handle, { runOrca });
  if (!tail) {
    return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId, tail: null, error: null };
  }

  const shown = screenShowsSubmittedBody(tail, text);
  return {
    ok: shown,
    submitted: shown ? 'submitted' : 'unknown',
    delivered: shown ? 'ok' : 'unknown',
    handle, retryId, tail, error: null,
  };
}

module.exports = { DEFAULT_ORCA_BIN, defaultRunOrca, screenShowsSubmittedBody, readScreenTail, sendToOrcaTerminal };
