'use strict';
/**
 * gmail-routine-headless.cjs — T-0339: the gmail-recordatorios routine runs as a headless `claude -p`
 * instead of being poked into a pane (pane discovery is WezTerm-only; the fleet moved to Orca, and
 * no pane sharing the wezbridge cwd has the Gmail MCP). Reuses src/headless-run.cjs with the run
 * record as summaryFile: `complete`/`fail` rewriting it means "work done".
 * Least privilege: Gmail read-only tools, Read, and three exact relative Bash prefixes; every
 * mutating Gmail tool, Edit, Write and Agent are denied. No shell, no --bare (it forces API-key auth
 * and drops the claude.ai connectors), no --dangerously-skip-permissions.
 * Only metadata is returned: exit codes, outcome, per-tool call counts, byte lengths. Never mail text.
 * Exit codes: 0 ok, 3 spawn error, 4 nonzero exit or exited without complete/fail, 8 timeout with no output.
 */
const fs = require('node:fs');
const path = require('node:path');
const { routineBody } = require('./gmail-routine-dispatch.cjs');

const REPO = path.resolve(__dirname, '..');
const HEADLESS_TIMEOUT_MS = 900000;
const HEADLESS_GRACE_MS = 60000;
const ACTOR = 'gmail-recordatorios-headless';

const GMAIL = 'mcp__claude_ai_Gmail__';
const GMAIL_SEARCH_TOOL = `${GMAIL}search_threads`;
const GMAIL_READ_TOOLS = ['search_threads', 'get_thread', 'get_message'].map(n => GMAIL + n);
// Every non-read Gmail tool observed in this machine's transcripts (2026-09-24).
const GMAIL_MUTATING_TOOLS = ['trash_thread', 'trash_message', 'untrash_thread', 'untrash_message',
  'label_thread', 'label_message', 'unlabel_thread', 'unlabel_message', 'update_message_labels',
  'create_label', 'update_label', 'delete_label', 'apply_sensitive_thread_label', 'apply_sensitive_message_label',
  'create_draft', 'update_draft', 'delete_draft', 'send_message', 'reply', 'forward',
  'mark_thread_spam', 'mark_message_spam', 'unmark_thread_spam', 'unmark_message_spam',
  'authenticate', 'complete_authentication'].map(n => GMAIL + n);
const ALLOWED_TOOLS = Object.freeze([...GMAIL_READ_TOOLS, 'Read',
  'Bash(node scripts/sp-bridge.cjs remind:*)',
  'Bash(node scripts/gmail-recordatorios-run.cjs complete:*)',
  'Bash(node scripts/gmail-recordatorios-run.cjs fail:*)']);
const DISALLOWED_TOOLS = Object.freeze([...GMAIL_MUTATING_TOOLS, 'Edit', 'Write', 'NotebookEdit', 'Agent']);
const FINAL_PHASES = new Set(['completed', 'execution_failed']);

function headlessArgs({ addDir } = {}) {
  return ['-p', '--model', 'sonnet', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--max-turns', '40',
    // The user default mode may be `auto`; nothing may be approved beyond the lists below.
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...ALLOWED_TOOLS,
    '--disallowedTools', ...DISALLOWED_TOOLS,
    ...(addDir ? ['--add-dir', addDir] : [])];
}

function headlessPrompt(options) {
  const id = options.runId;
  const routines = path.join(options.intelDir, 'routines');
  return `${routineBody(options)}

[modo headless T-0339] No hay pane ni operador: nadie aprueba permisos. Solo estas herramientas funcionan:
- Gmail SOLO LECTURA: search_threads, get_thread, get_message. Nada de etiquetar, archivar, borrar, mover, redactar ni enviar.
- Read, para el spec y las exclusiones (${routines}).
- Estos comandos EXACTOS, relativos al cwd (el repo wezbridge). No uses la ruta absoluta de sp-bridge que figura en el spec:
  node scripts/sp-bridge.cjs remind "<Pagar X: $monto vence dd/mm>" --at <ISO> --ext gmail:<messageId> --notes "<remitente, fecha del mail, referencia>"
  node scripts/gmail-recordatorios-run.cjs complete --run ${id} --seen N --created N --existing N --doubtful N
  node scripts/gmail-recordatorios-run.cjs fail --run ${id} --reason "<motivo breve sin datos privados>"
El ultimo paso es SIEMPRE complete o fail con --run ${id}; despues termina.`;
}

function headlessEnv(base, intelDir) {
  const env = { ...base };
  delete env.WEZ_LANE;
  delete env.WEZTERM_PANE;
  return { ...env, WEZBRIDGE_ACTOR: ACTOR, MEMORYMASTER_DREAM_ENABLED: '0',
    // complete/fail must close THIS run's record, wherever its intel dir is.
    WEZBRIDGE_INTEL_DIR: intelDir };
}

/** claude executable, spawned without a shell. The npm shim is a .cmd, so find the real claude.exe. */
function resolveClaude(env = process.env, platform = process.platform) {
  const override = env.GMAIL_ROUTINE_CLAUDE_BIN;
  if (override) return /\.(c|m)?js$/i.test(override)
    ? { command: process.execPath, prefix: [override] } : { command: override, prefix: [] };
  if (platform !== 'win32') return { command: 'claude', prefix: [] };
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of [path.join(dir, 'claude.exe'),
      path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]) {
      if (fs.existsSync(candidate)) return { command: candidate, prefix: [] };
    }
  }
  return { command: 'claude.exe', prefix: [] };
}

/** Per-tool-name counts from stream-json tool_use events. Names only; inputs and results are ignored. */
function toolCallCounts(stdout) {
  const gmail = {}; const denied = {}; let result = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(GMAIL)) {
          gmail[block.name] = (gmail[block.name] || 0) + 1;
        }
      }
    } else if (event.type === 'result') {
      result = typeof event.subtype === 'string' ? event.subtype.slice(0, 40) : null;
      for (const d of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
        if (typeof d?.tool_name === 'string') denied[d.tool_name] = (denied[d.tool_name] || 0) + 1;
      }
    }
  }
  return { gmail, denied, result };
}

function recordPhase(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).phase; } catch { return null; }
}

async function dispatchGmailHeadless(options, deps = {}) {
  const runHeadless = deps.runHeadless || require('./headless-run.cjs').runHeadless;
  const claude = deps.claude || resolveClaude(deps.env || process.env);
  const recordFile = options.recordFile;
  if (!recordFile) throw new Error('dispatchGmailHeadless: recordFile required');
  const routines = path.join(options.intelDir, 'routines');
  let r;
  try {
    r = await runHeadless({
      command: claude.command,
      args: [...claude.prefix, ...headlessArgs({ addDir: fs.existsSync(routines) ? routines : null })],
      input: headlessPrompt(options),
      summaryFile: recordFile,
      timeoutMs: deps.timeoutMs || HEADLESS_TIMEOUT_MS,
      graceMs: deps.graceMs || HEADLESS_GRACE_MS,
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
      spawnOpts: { cwd: deps.cwd || REPO, shell: false, env: headlessEnv(deps.env || process.env, options.intelDir) },
    });
  } catch (error) {
    return { exit_status: 3, transport: 'headless', headless_outcome: 'spawn-error',
      error: String(error.message || error).slice(0, 240) };
  }
  const calls = toolCallCounts(r.stdout);
  const spawnError = r.status === null && !r.killed && /spawn error:/.test(r.stderr || '');
  const finalPhase = FINAL_PHASES.has(recordPhase(recordFile));
  let exit; let reason = null;
  if (spawnError) { exit = 3; reason = 'spawn error'; }
  else if (r.outcome === 'timeout-no-output') { exit = 8; reason = 'timeout without complete/fail'; }
  else if (r.outcome === 'completed-no-exit') exit = 0;
  else if (r.status !== 0) { exit = 4; reason = `claude exited ${r.status}`; }
  else if (!finalPhase) { exit = 4; reason = 'claude exited 0 without complete/fail'; }
  else exit = 0;
  return { exit_status: exit, transport: 'headless', headless_outcome: spawnError ? 'spawn-error' : r.outcome,
    headless_status: r.status, killed: r.killed, ...(reason ? { headless_reason: reason } : {}),
    headless_result: calls.result, gmail_tool_calls: calls.gmail, permission_denials: calls.denied,
    stdout_bytes: Buffer.byteLength(r.stdout || ''), stderr_bytes: Buffer.byteLength(r.stderr || '') };
}

module.exports = { dispatchGmailHeadless, headlessArgs, headlessPrompt, headlessEnv, resolveClaude, toolCallCounts,
  ALLOWED_TOOLS, DISALLOWED_TOOLS, GMAIL_READ_TOOLS, GMAIL_MUTATING_TOOLS, GMAIL_SEARCH_TOOL,
  HEADLESS_TIMEOUT_MS, HEADLESS_GRACE_MS };
