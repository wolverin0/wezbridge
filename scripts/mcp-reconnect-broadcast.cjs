'use strict';
/**
 * mcp-reconnect-broadcast.cjs — broadcast `/mcp reconnect <server>` to every Claude pane
 * that is IDLE with an EMPTY composer (T-0569). Reuses orca-census (src/orca-census.cjs)
 * for the terminal list + a screen read per pane, pane-discovery's STATUS_PATTERNS for
 * idle/working/permission classification, and composer-state.cjs's composerContent for
 * the empty-composer gate. A pane that is working, awaiting permission, holding composer
 * text, non-claude, or (by default) the caller's own pane is never typed into — it is
 * reported as skip:<reason>. CLI: node scripts/mcp-reconnect-broadcast.cjs <server>
 * [--dry-run] [--include-busy-self]. Key terms: classifyStatus, classifyTarget,
 * planBroadcast, sendReconnect, runBroadcast, ORCA_TERMINAL_HANDLE (the caller's own
 * pane identity, set by Orca in every spawned terminal's env).
 * Read when: MemoryMaster (or another MCP server) shows "disconnected" in several panes
 * and hand-typing `/mcp reconnect <server>` into each one is the known-working fallback.
 *
 * WHY manual PowerShell works but a Git Bash shell-out breaks: Git Bash's MSYS
 * path-conversion rewrites a leading `/mcp` into a filesystem path before the shell ever
 * sees the slash command. This script never shells a command STRING through Git Bash for
 * the send — it always calls `execFile(orcaBin, argv)` directly (same injectable runOrca
 * used by src/orca-census.cjs), so there is no shell in the loop to mangle the leading
 * slash. If a caller ever does wrap this in a Bash one-liner, set MSYS_NO_PATHCONV=1.
 */
const { runCensus, defaultRunOrca } = require('../src/orca-census.cjs');
const { STATUS_PATTERNS } = require('../src/pane-discovery.cjs');
const { composerContent } = require('./composer-state.cjs');

const SUCCESS_RE = /Successfully reconnected/i;
const FAIL_RE = /(failed to reconnect|could not reconnect|unable to reconnect|reconnect(?:ion)? failed|error (?:while )?reconnecting|✗[^\n]*reconnect)/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read a terminal's rendered screen via `orca terminal read --screen --json`. Throws on CLI/parse failure — callers turn that into a skip/fail row, never a silent empty screen. */
async function readScreen(runOrca, handle) {
  const stdout = await runOrca(['terminal', 'read', '--terminal', handle, '--screen', '--json']);
  let j;
  try { j = JSON.parse(stdout); } catch (e) { throw new Error(`unparseable read: ${e.message}`); }
  if (!j || j.ok === false) throw new Error(`orca read error: ${JSON.stringify(j && (j.error || j)).slice(0, 160)}`);
  const tail = (j.result && j.result.terminal && Array.isArray(j.result.terminal.tail)) ? j.result.terminal.tail : [];
  return tail;
}

/** Same idle/working/permission/continuation classification as src/pane-discovery.cjs, applied to an Orca screen tail instead of a WezTerm getFullText tail. */
function classifyStatus(tailLines) {
  const nonEmpty = (tailLines || []).filter((l) => String(l).trim());
  const lastLines = nonEmpty.slice(-20).join('\n');
  const matches = (patterns) => patterns.some((p) => p.test(lastLines));
  if (matches(STATUS_PATTERNS.working)) return 'working';
  if (matches(STATUS_PATTERNS.permission)) return 'permission';
  if (matches(STATUS_PATTERNS.continuation)) return 'continuation';
  if (matches(STATUS_PATTERNS.idle)) return 'idle';
  return 'unknown';
}

/**
 * The one safety gate: only a provider=claude pane that is IDLE with an EMPTY composer
 * (and, unless includeBusySelf, is not the caller's own pane) is a valid send target.
 * @returns {{target:true}|{target:false, reason:string}}
 */
function classifyTarget({ term, tailLines, selfHandle = null, includeBusySelf = false }) {
  if (term.provider !== 'claude') return { target: false, reason: 'provider-not-claude' };
  if (!includeBusySelf && selfHandle && term.handle === selfHandle) return { target: false, reason: 'self-busy' };
  const status = classifyStatus(tailLines);
  if (status !== 'idle') return { target: false, reason: `status-${status}` };
  const composer = composerContent(tailLines.join('\n'));
  if (composer) return { target: false, reason: 'composer-not-empty' };
  return { target: true };
}

/**
 * Census + per-pane screen read + classifyTarget for every provider=claude terminal.
 * Never throws: a per-pane read failure becomes a skip row, a census failure becomes
 * {ok:false, reason}.
 */
async function planBroadcast({ runOrca = defaultRunOrca, now = Date.now, selfHandle = null, includeBusySelf = false } = {}) {
  const census = await runCensus({ runOrca, now });
  if (!census.ok) return { ok: false, reason: census.reason };
  const claudeTerms = census.terminals.filter((t) => t.provider === 'claude');
  const targets = [];
  const skips = [];
  for (const term of claudeTerms) {
    const row = { handle: term.handle, title: term.title, worktreePath: term.worktreePath };
    let tailLines;
    try { tailLines = await readScreen(runOrca, term.handle); }
    catch (e) { skips.push({ ...row, reason: `read-error:${e.message}`.slice(0, 140) }); continue; }
    const verdict = classifyTarget({ term, tailLines, selfHandle, includeBusySelf });
    if (verdict.target) targets.push(row);
    else skips.push({ ...row, reason: verdict.reason });
  }
  return { ok: true, targets, skips };
}

function tailExcerpt(tailLines, n = 3) {
  return (tailLines || []).filter((l) => String(l).trim()).slice(-n).join(' | ').slice(0, 200);
}

/** Excerpt around the FIRST line matching re, not just the tail of the screen — a busy
 * pane's background-agent chatter keeps appending lines after the reconnect result
 * prints, so scanning/reporting only the last few lines missed a real "Successfully
 * reconnected" that had already scrolled up (measured live, T-0569: 2 of 3 real panes
 * classified 'unknown' this way despite the reconnect actually succeeding). */
function matchExcerpt(tailLines, re) {
  const nonEmpty = (tailLines || []).filter((l) => String(l).trim());
  const idx = nonEmpty.findIndex((l) => re.test(l));
  if (idx < 0) return tailExcerpt(tailLines);
  return nonEmpty.slice(Math.max(0, idx - 1), idx + 2).join(' | ').slice(0, 200);
}

/**
 * Sends `/mcp reconnect <server>` + Enter to one terminal, then polls the screen
 * (attempts = ceil(timeoutMs/pollMs), each attempt awaits `sleep(pollMs)` first) until
 * SUCCESS_RE / FAIL_RE matches or the budget runs out.
 * @returns {{result:'ok'|'fail'|'unknown', excerpt:string}}
 */
async function sendReconnect({ runOrca = defaultRunOrca, handle, server, sleep = defaultSleep, pollMs = 1000, timeoutMs = 10000 }) {
  try {
    await runOrca(['terminal', 'send', '--terminal', handle, '--text', `/mcp reconnect ${server}`, '--enter', '--json']);
  } catch (e) {
    return { result: 'fail', excerpt: `send-error: ${e.message}`.slice(0, 200) };
  }
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const echoRe = commandEchoRegex(server);
  let lastTail = [];
  for (let i = 0; i < attempts; i++) {
    await sleep(pollMs);
    try { lastTail = await readScreen(runOrca, handle); }
    catch (e) { lastTail = [`read-error: ${e.message}`]; continue; }
    const nonEmpty = lastTail.filter((l) => String(l).trim());
    // Only classify text after the LAST echoed command line: an OLD "Successfully
    // reconnected" from an earlier run (typed by hand, or still in scrollback) sits
    // ABOVE the new command's echo and must never count as this attempt's result. If the
    // echo isn't visible yet, keep polling instead of guessing.
    let echoIdx = -1;
    for (let j = nonEmpty.length - 1; j >= 0; j--) {
      if (echoRe.test(nonEmpty[j])) { echoIdx = j; break; }
    }
    if (echoIdx < 0) continue;
    // Scan the WHOLE remainder after the echo, not just the last few lines: a busy pane's
    // background-agent output keeps appending after the reconnect result prints, so a
    // narrow tail slice can miss a result that already scrolled up (see matchExcerpt).
    const after = nonEmpty.slice(echoIdx + 1);
    const recent = after.join('\n');
    if (SUCCESS_RE.test(recent)) return { result: 'ok', excerpt: matchExcerpt(nonEmpty.slice(echoIdx), SUCCESS_RE) };
    if (FAIL_RE.test(recent)) return { result: 'fail', excerpt: matchExcerpt(nonEmpty.slice(echoIdx), FAIL_RE) };
  }
  return { result: 'unknown', excerpt: tailExcerpt(lastTail) };
}

/** Loosely matches the echoed prompt line for the reconnect command just sent, e.g.
 * `❯ /mcp reconnect memorymaster`. Used to find where the NEW attempt's output starts,
 * so a stale success/fail line left over from an earlier reconnect (run by hand or by a
 * prior poll, still visible in scrollback) is never classified as this attempt's result. */
function commandEchoRegex(server) {
  const escaped = String(server).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\/mcp\\s+reconnect\\s+${escaped}\\b`, 'i');
}

function manualCommand(handle, server) {
  return `orca terminal send --terminal ${handle} --text "/mcp reconnect ${server}" --enter --json`;
}

/**
 * The whole broadcast: plan targets/skips, then (unless dryRun) send + classify each
 * target. Rows are handle/title/worktreePath/result/excerpt, ready for printTable.
 * exitCode is 0 iff every TARGETED pane classified 'ok' (vacuously 0 with no targets).
 */
async function runBroadcast({
  server, dryRun = false, includeBusySelf = false, runOrca = defaultRunOrca,
  selfHandle = process.env.ORCA_TERMINAL_HANDLE || null, sleep = defaultSleep, now = Date.now,
} = {}) {
  if (!server) return { ok: false, reason: 'server name required', rows: [], exitCode: 1 };
  const plan = await planBroadcast({ runOrca, now, selfHandle, includeBusySelf });
  if (!plan.ok) return { ok: false, reason: plan.reason, rows: [], exitCode: 1 };

  const rows = plan.skips.map((s) => ({
    handle: s.handle, title: s.title, worktreePath: s.worktreePath, result: `skip:${s.reason}`,
    excerpt: s.reason === 'self-busy' ? `manual: ${manualCommand(s.handle, server)}` : '',
  }));

  if (dryRun) {
    for (const t of plan.targets) {
      rows.push({ handle: t.handle, title: t.title, worktreePath: t.worktreePath, result: 'dry-run:target', excerpt: '' });
    }
    return { ok: true, rows, exitCode: 0 };
  }

  let allOk = true;
  for (const t of plan.targets) {
    const r = await sendReconnect({ runOrca, handle: t.handle, server, sleep });
    if (r.result !== 'ok') allOk = false;
    rows.push({ handle: t.handle, title: t.title, worktreePath: t.worktreePath, result: r.result, excerpt: r.excerpt });
  }
  return { ok: true, rows, exitCode: allOk ? 0 : 1 };
}

function projectName(worktreePath) {
  if (!worktreePath) return '';
  return String(worktreePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

function printTable(rows, log = console.log) {
  const header = ['handle', 'project', 'result', 'excerpt'];
  const data = rows.map((r) => [r.handle || '', projectName(r.worktreePath), r.result || '', r.excerpt || '']);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => String(d[i]).length)));
  const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  |  ');
  log(fmt(header));
  log(widths.map((w) => '-'.repeat(w)).join('--|--'));
  for (const d of data) log(fmt(d));
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const includeBusySelf = argv.includes('--include-busy-self');
  const server = argv.find((a) => !a.startsWith('--'));
  if (!server) {
    console.error('Usage: node scripts/mcp-reconnect-broadcast.cjs <server> [--dry-run] [--include-busy-self]');
    process.exit(2);
    return;
  }
  const result = await runBroadcast({ server, dryRun, includeBusySelf });
  if (!result.ok) {
    console.error(`mcp-reconnect-broadcast: ${result.reason}`);
    process.exit(1);
    return;
  }
  printTable(result.rows);
  process.exit(result.exitCode);
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });
}

module.exports = {
  SUCCESS_RE, FAIL_RE, readScreen, classifyStatus, classifyTarget, planBroadcast,
  sendReconnect, runBroadcast, printTable, projectName, manualCommand,
};
