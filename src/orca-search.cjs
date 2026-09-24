'use strict';
/**
 * orca-search.cjs — searchSessions/getIndexStatus wrappers around `orca search`
 * (T-0576, Orca v1.4.209+). Covers cross-session indexed search (`orca search <query>
 * --json` with --scope, --agent, --path, --since, --sort, --limit, --cursor, --fresh,
 * --debug) and `orca search --index-status --json`. Injectable runOrcaFn decouples
 * unit tests from the real CLI (same contract as orca-census.cjs's runOrca).
 * Key terms: searchSessions, getIndexStatus, DISABLED_INDEX_MESSAGE, defaultRunOrca,
 * buildSearchArgs.
 * Read when: adding/extending the orca_search MCP tool, or debugging "indexing is
 * currently disabled" / an empty/garbled orca_search response.
 * Never throws: CLI failures, malformed JSON, and a disabled index all resolve to
 * {ok:false, reason} — matching orca-census.cjs's contract — never an unhandled
 * rejection back to the MCP tool caller.
 */
const { execFile } = require('node:child_process');

const DEFAULT_ORCA_BIN = process.env.ORCA_CLI
  || 'C:/Users/pauol/AppData/Local/Programs/orca/resources/bin/orca.exe';

// AC2 wording (brief T-0576): a clear, actionable message for both the operator and
// the calling agent when Orca Session Search indexing is off, instead of surfacing
// the raw {kind:"unavailable",reason:"disabled"} CLI payload.
const DISABLED_INDEX_MESSAGE = "Orca Session Search indexing is currently disabled. "
  + "Enable 'Session Search / History indexing' in Orca Desktop Settings to activate cross-session search.";

/** Default CLI runner: async, bounded, never blocks the caller's event loop (mirrors orca-census.cjs's defaultRunOrca). */
function defaultRunOrca(args, { bin = DEFAULT_ORCA_BIN, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { err.message = `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`; return reject(err); }
        resolve(stdout);
      });
  });
}

/** Parse an `orca ... --json` envelope. Returns {ok, result, raw} or {ok:false, reason}. */
function parseOrcaJson(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch (e) { return { ok: false, reason: `unparseable orca output: ${e.message}` }; }
  if (!j || j.ok === false) return { ok: false, reason: `orca error: ${JSON.stringify(j && (j.error || j)).slice(0, 200)}` };
  return { ok: true, result: j.result, raw: j };
}

/** True when a search `result` reports the index is disabled (T-0576 AC2). */
function isDisabledSearchResult(result) {
  return !!result && result.kind === 'unavailable' && result.reason === 'disabled';
}

/** True when an `--index-status` `result` reports the index is disabled. */
function isDisabledStatus(result) {
  return !!result && result.enabled === false;
}

/**
 * `orca search <query> --json [flags]` argv, per `orca search --help` (v1.4.209):
 * --scope, --agent (repeatable), --path (repeatable), --since, --sort, --limit,
 * --cursor, --fresh, --debug.
 */
function buildSearchArgs(query, opts = {}) {
  const args = ['search', String(query), '--json'];
  if (opts.scope) args.push('--scope', String(opts.scope));
  const agents = opts.agent == null ? [] : (Array.isArray(opts.agent) ? opts.agent : [opts.agent]);
  for (const a of agents) args.push('--agent', String(a));
  const paths = opts.path == null ? [] : (Array.isArray(opts.path) ? opts.path : [opts.path]);
  for (const p of paths) args.push('--path', String(p));
  if (opts.since) args.push('--since', String(opts.since));
  if (opts.sort) args.push('--sort', String(opts.sort));
  if (opts.limit !== undefined && opts.limit !== null) args.push('--limit', String(opts.limit));
  if (opts.cursor) args.push('--cursor', String(opts.cursor));
  if (opts.fresh) args.push('--fresh');
  if (opts.debug) args.push('--debug');
  return args;
}

/**
 * Run `orca search <query> --json` with the given flags. Never throws: CLI
 * failures, malformed JSON, and a disabled index all resolve to {ok:false, reason}
 * (a disabled index additionally sets disabled:true and reason=DISABLED_INDEX_MESSAGE).
 * On success returns {ok:true, result} where result is the raw `orca search` result
 * object (hits/cursor/etc. — shape owned by the CLI, not reshaped here).
 */
async function searchSessions({
  query, scope, agent, path, since, sort, limit, cursor, fresh, debug,
  runOrcaFn = defaultRunOrca,
} = {}) {
  if (!query || !String(query).trim()) return { ok: false, reason: 'query is required' };
  const args = buildSearchArgs(query, { scope, agent, path, since, sort, limit, cursor, fresh, debug });
  let stdout;
  try { stdout = await runOrcaFn(args); }
  catch (e) { return { ok: false, reason: `orca cli: ${e && e.message ? e.message : String(e)}` }; }
  const parsed = parseOrcaJson(stdout);
  if (!parsed.ok) return parsed;
  const result = parsed.result;
  if (isDisabledSearchResult(result)) {
    return { ok: false, disabled: true, reason: DISABLED_INDEX_MESSAGE };
  }
  if (result && result.kind === 'unavailable') {
    return { ok: false, reason: `orca search unavailable: ${result.reason || 'unknown reason'}` };
  }
  return { ok: true, result };
}

/**
 * Run `orca search --index-status --json`. Never throws. On a disabled index
 * returns {ok:true, enabled:false, status, message: DISABLED_INDEX_MESSAGE} —
 * ok:true because the CLI call itself succeeded and reported a real state, not
 * a failure; callers check `enabled`, not `ok`, to branch on indexing state.
 */
async function getIndexStatus({ runOrcaFn = defaultRunOrca } = {}) {
  let stdout;
  try { stdout = await runOrcaFn(['search', '--index-status', '--json']); }
  catch (e) { return { ok: false, reason: `orca cli: ${e && e.message ? e.message : String(e)}` }; }
  const parsed = parseOrcaJson(stdout);
  if (!parsed.ok) return parsed;
  const result = parsed.result || {};
  if (isDisabledStatus(result)) {
    return { ok: true, enabled: false, status: result, message: DISABLED_INDEX_MESSAGE };
  }
  return { ok: true, enabled: true, status: result };
}

module.exports = {
  DEFAULT_ORCA_BIN, DISABLED_INDEX_MESSAGE,
  defaultRunOrca, buildSearchArgs, parseOrcaJson, isDisabledSearchResult, isDisabledStatus,
  searchSessions, getIndexStatus,
};
