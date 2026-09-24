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
 * Retry: `--retry-request <id>` is NOT a caller-chosen idempotency key — measured
 * against the real orca.exe 2026-09-24, a fresh caller-supplied UUID is refused
 * with `invalid_argument: --retry-request must be the UUID Orca reported for
 * the original request`. The real contract (confirmed empirically; `--help`'s
 * wording alone reads as either) is: send WITHOUT the flag; if Orca reports an
 * "ambiguous transport failure" it hands back an `orchestrationRequestId` in
 * the error body; REISSUE the identical command with exactly THAT id. This
 * module does that reissue internally (one retry, same call) — it does not
 * expose a caller-supplied retry id.
 */
const { execFile } = require('node:child_process');
const { inputBoxContent } = require('./verified-send.cjs');

const DEFAULT_ORCA_BIN = process.env.ORCA_CLI
  || 'C:/Users/pauol/AppData/Local/Programs/orca/resources/bin/orca.exe';

/**
 * Default CLI runner: async, bounded — same shape as orca-census.cjs's
 * defaultRunOrca. A `.cjs` bin (test doubles only — the real orca.exe never
 * ends in .cjs) is run via `node <script> <args>`: plain .cjs files have no
 * shebang association on Windows and execFile refuses to spawn them directly
 * (same reasoning as test/setup.cjs's mockCommand for the WezTerm double).
 */
function defaultRunOrca(args, { bin = DEFAULT_ORCA_BIN, timeoutMs = 20000 } = {}) {
  const [cmd, cmdArgs] = bin.endsWith('.cjs') ? [process.execPath, [bin, ...args]] : [bin, args];
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Measured 2026-09-24 against the real orca.exe: a refusal (e.g. a
        // stale terminal handle) is reported as a well-formed {ok:false,
        // error:{...}} body on STDOUT while the process ALSO exits non-zero —
        // execFile's callback sets `err` either way. Only a truly EMPTY
        // stdout is a real transport failure (spawn ENOENT, timeout); a
        // non-empty stdout is the CLI's own answer and must reach the caller
        // so it can parse `ok:false` instead of the body being silently
        // discarded here.
        if (err) {
          if (stdout && stdout.trim()) return resolve(stdout);
          err.message = `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`;
          return reject(err);
        }
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

/** Extract the orchestrationRequestId Orca reports for an ambiguous-transport refusal, if any. */
function orchestrationRequestId(errJson) {
  return (errJson && errJson.error && errJson.error.data && errJson.error.data.orchestrationRequestId) || null;
}

/**
 * Send `body` to an Orca terminal and verify via a screen read-back.
 *
 * Returns { ok, submitted: 'submitted'|'unknown', delivered: 'ok'|'unknown',
 *           handle, retryId, tail, error }. `retryId` is the orchestration id
 * Orca itself reported IF this call had to reissue once (null on a clean first
 * attempt) — purely informational for logging, not something the caller passes
 * in. `ok` is true only when the read-back confirms the body landed on screen
 * and is not stuck in the composer — the same "don't trust the transport's own
 * receipt" posture as verified-send.cjs (W4): a CLI that reports ok:true but
 * whose screen never shows the text is NOT counted as delivered.
 */
async function sendToOrcaTerminal(handle, body, {
  runOrca = defaultRunOrca, sleep = defaultSleep, waitSubmitSeconds = 3, settleMs = 500, maxRetries = 1,
} = {}) {
  const text = String(body);
  let retryId = null;
  let sendJson = null;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const args = ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'];
    if (waitSubmitSeconds) args.push('--wait-submit', String(waitSubmitSeconds));
    if (retryId) args.push('--retry-request', retryId);

    try {
      const stdout = await runOrca(args);
      try { sendJson = JSON.parse(stdout); } catch { sendJson = null; }
    } catch (e) {
      return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId, tail: null, error: e && e.message };
    }

    if (!sendJson || sendJson.ok !== false) break; // sent (or an unparseable-but-non-erroring body) — move to read-back

    lastError = `orca error: ${JSON.stringify(sendJson.error || sendJson).slice(0, 200)}`;
    const reqId = orchestrationRequestId(sendJson);
    if (!reqId || attempt >= maxRetries) {
      return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId, tail: null, error: lastError };
    }
    retryId = reqId; // reissue the IDENTICAL command with the id Orca just reported
  }

  await sleep(settleMs);
  const tail = await readScreenTail(handle, { runOrca });
  if (!tail) {
    return { ok: false, submitted: 'unknown', delivered: 'unknown', handle, retryId, tail: null, error: lastError };
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
