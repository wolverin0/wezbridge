#!/usr/bin/env node
/**
 * WezBridge MCP Server — exposes terminal session management as Claude Code tools.
 *
 * This is the core of the "omni" Claude concept: one Claude Code instance gets
 * MCP tools to see, read, and command all other Claude sessions running in WezTerm.
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP standard).
 * IMPORTANT: All logging goes to stderr — stdout is the protocol stream.
 *
 * Tools exposed:
 *   discover_sessions  — Scan WezTerm for all active Claude Code sessions
 *   read_output        — Read terminal output from a specific pane
 *   send_prompt        — Send a prompt/instruction to a specific pane
 *   get_status         — Get detailed status of a specific session
 *   list_projects      — List all projects with active Claude sessions
 *   send_key           — Send special keys (Enter, y, Ctrl+C) to a pane
 */

// Opt-in destructive-op guard. No-op unless WEZBRIDGE_GUARD_SHIMS=1.
require('./guard-bootstrap.cjs');

const safetyPolicy = require('./safety-policy.cjs');
const discovery = require('./pane-discovery.cjs');
const wez = require('./wezterm.cjs');

/**
 * T-0281 AC4: ninguna tool que MUTA una pane (send_prompt, send_key, kill_session,
 * set_tab_title) direcciona por pane_id sin verificarlo contra el mux vivo. Con dos
 * muxes vivos los espacios de id se solapan y un id viejo no falla: llega a OTRA
 * sesion. Regla mm-c03b: un censo que NO responde no condena a nadie (se deja pasar
 * y se dice `unverified`); solo un censo que responde y no lo lista lo rechaza.
 * read_output queda fail-open: leer una pane equivocada es ruido, no daño.
 * Escape para diagnostico: WEZBRIDGE_TARGET_GUARD=off.
 */
function guardPaneTarget(paneId, tool) {
  if (process.env.WEZBRIDGE_TARGET_GUARD === 'off') return null;
  const id = Number(paneId);
  let ids = null;
  try { ids = wez.listPanes().map((p) => Number(p.pane_id ?? p.paneid ?? p.PANEID)); } catch { ids = null; }
  if (!ids || !ids.length) return null; // censo mudo: no prueba ausencia
  if (ids.includes(id)) return null;
  return {
    content: [{
      type: 'text',
      text: `target-guard: ${tool} rehusado — pane ${paneId} no existe en el mux vivo (ids: ${ids.join(', ')}). `
        + 'Los pane_id se renumeran y con dos muxes vivos se solapan (T-0281): corre discover_sessions y direcciona por proyecto (a2a_send to_project) o usa un id del censo actual.',
    }],
    isError: true,
  };
}
const a2aIntel = require('./a2a-intel.cjs');

/**
 * Agent-pane census in the shape pane-identity expects. Returns [] when
 * discovery is down, which resolveSelfPane treats as "cannot prove my own
 * pane" rather than as absence — an unanswering instrument is not evidence.
 */
function selfCensusFor() {
  try {
    return discovery.discoverPanes()
      .filter((p) => p.agent)
      .map((p) => ({ pane_id: p.paneId, cwd: p.project, tab_title: p.tabTitle || p.title || null }));
  } catch { return []; }
}

const os = require('os');
const path = require('path');
const fs = require('fs');

// ─── Persona Resolution ──────────────────────────────────────────────────

const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

function resolvePersona(name) {
  // 1. Exact match: AGENTS_DIR/<name>.md
  const exact = path.join(AGENTS_DIR, `${name}.md`);
  if (fs.existsSync(exact)) return exact;
  // 2. One-level nested: AGENTS_DIR/*/<name>.md
  try {
    const dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const d of dirs) {
      const nested = path.join(AGENTS_DIR, d.name, `${name}.md`);
      if (fs.existsSync(nested)) return nested;
    }
  } catch { /* AGENTS_DIR may not exist */ }
  return null;
}

// ─── JSON-RPC 2.0 Helpers ─────────────────────────────────────────────────

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message, data) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function log(...args) {
  // MCP rule: all output to stderr, stdout is the protocol stream
  process.stderr.write(`[wezbridge-mcp] ${args.join(' ')}\n`);
}

const RESUME_SESSION_RE = /^[0-9a-f-]{8,}$/i;
const VALID_PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
const INPUT_BYTE_LIMITS = {
  prompt: 16 * 1024,
  key: 64,
  focus: 256,
  name: 256,
  args: 4096,
};
const MIN_SWITCH_WORKSPACE_WEZTERM_VERSION = 20230408;

// Refuse over-long A2A bodies BEFORE sending. Lives in its own module because
// this file has no exports and requiring it would start a server, so anything
// defined here can only be "tested" by grepping source — which is how the first
// version of this guard passed a mutation that disabled it entirely.
const { a2aLengthRefusal, a2aSpill, A2A_BODY_SOFT_LIMIT } = require('./a2a-length-guard.cjs');

function isValidResumeSession(resume) {
  return resume === 'last' || RESUME_SESSION_RE.test(String(resume || ''));
}

function shellQuoteArg(arg) {
  const text = String(arg);
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

function isValidPersonaName(name) {
  const text = String(name || '');
  return /^[a-zA-Z0-9._-]+$/.test(text) &&
    !text.includes('..') &&
    !text.includes('/') &&
    !text.includes('\\') &&
    !path.isAbsolute(text) &&
    !/^[a-zA-Z]:[\\/]/.test(text);
}

// Model alias reaching a shell command — keep it to a safe charset (aliases and
// full model ids only), never anything that could break out of the argv token.
function isValidModelName(model) {
  return /^[a-zA-Z0-9._-]+$/.test(String(model || ''));
}

// Non-blocking sleep. The stdio JSON-RPC loop is single-threaded — the old
// execFileSync('timeout'/'sleep') pattern froze EVERY concurrent tool call
// while one handler waited. Async handlers resolve out of order (the dispatch
// layer supports promises), so awaiting a timer keeps the server responsive.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-flight async tool responses — drained on stdin close (see shutdown hook).
const pendingAsyncCalls = new Set();

// ─── Verified prompt submission (claim-8945 fix at source) ────────────────
// Extracted to src/verified-send.cjs (2026-08-05) so the daemon shares the
// exact same delivery guarantees (multi-line stuck detection, bracketed-paste
// anti-splice, collapsed-paste handling). Same functions, same behaviour.
const { verifyPromptSubmission, sendPromptDeferredEnter } = require('./verified-send.cjs');

// read_output delta cursors — see src/read-cursor.cjs
const { makeReadCursor, sliceAfterCursor } = require('./read-cursor.cjs');

function mcpError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function validateByteLength(field, value, limit) {
  if (value === undefined || value === null) return null;
  const length = Buffer.byteLength(String(value), 'utf8');
  if (length <= limit) return null;
  return mcpError(`Error: ${field} exceeds ${limit} byte limit`);
}

function validateJsonArgsByteLength(value) {
  if (value === undefined || value === null) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_err) {
    return mcpError('Error: args must be JSON serializable');
  }
  const length = Buffer.byteLength(serialized || '', 'utf8');
  if (length <= INPUT_BYTE_LIMITS.args) return null;
  return mcpError(`Error: args exceeds ${INPUT_BYTE_LIMITS.args} byte limit`);
}

function redactHomePath(value) {
  if (typeof value !== 'string' || !value) return value;
  const home = os.homedir();
  if (!home) return value;
  const normalizedValue = value.replace(/\\/g, '/');
  const normalizedHome = home.replace(/\\/g, '/').replace(/\/$/, '');
  const valueForCompare = process.platform === 'win32' ? normalizedValue.toLowerCase() : normalizedValue;
  const homeForCompare = process.platform === 'win32' ? normalizedHome.toLowerCase() : normalizedHome;
  if (valueForCompare === homeForCompare) return '~';
  if (valueForCompare.startsWith(`${homeForCompare}/`)) {
    return `~${normalizedValue.slice(normalizedHome.length)}`;
  }
  return value;
}

function formatLastText(text, verbose) {
  const value = String(text || '');
  return verbose || value.length <= 500 ? value : `${value.slice(0, 500)}...`;
}

function detectSwitchWorkspaceSupport() {
  try {
    const output = require('child_process').execFileSync(wez.WEZTERM, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    }).trim();
    const match = output.match(/(\d{8})/);
    if (!match) {
      return { supported: false, reason: `unable to parse WezTerm version from "${output}"` };
    }
    const version = Number(match[1]);
    if (version < MIN_SWITCH_WORKSPACE_WEZTERM_VERSION) {
      return { supported: false, version, reason: `WezTerm ${version} is older than ${MIN_SWITCH_WORKSPACE_WEZTERM_VERSION}` };
    }
    return { supported: true, version };
  } catch (err) {
    return { supported: false, reason: `unable to probe WezTerm version: ${err.message}` };
  }
}

const SWITCH_WORKSPACE_SUPPORT = detectSwitchWorkspaceSupport();

// ─── Tool Definitions ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'discover_sessions',
    description: 'Scan all WezTerm terminal panes and discover which ones are running Claude Code sessions. Returns a list of all detected sessions with their project, status (idle/working/permission), pane ID, and confidence score. Use this first to see what sessions are available.',
    inputSchema: {
      type: 'object',
      properties: {
        only_claude: {
          type: 'boolean',
          description: 'If true, only return panes detected as Claude Code sessions. Default: true — which HIDES codex and shell panes. For any fleet census, health check or oversight pass pass false, or you will miss peer executors and daemons. When the filter drops panes the response sets filtered:true plus total_unfiltered/omitted.',
        },
        verbose: {
          type: 'boolean',
          description: 'If true, return full path and output fields without redaction or truncation.',
        },
      },
    },
  },
  {
    name: 'read_output',
    description: 'Read the terminal output from a specific WezTerm pane. Returns the last N lines of scrollback. Use this to see what a Claude session has been doing or what it responded with. DELTA MODE for cheap polling: pass with_cursor: true on the first read to get a cursor token, then pass it back as since on later reads to receive only the NEW lines since (response becomes JSON {new_output, cursor, cursor_found}).',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'number',
          description: 'The WezTerm pane ID to read from (get this from discover_sessions).',
        },
        lines: {
          type: 'number',
          description: 'Number of scrollback lines to read. Default: 100. Max: 500.',
        },
        since: {
          type: 'string',
          description: 'Cursor token from a previous read — return only lines after it. If it no longer matches, the full tail is returned with cursor_found: false.',
        },
        with_cursor: {
          type: 'boolean',
          description: 'Include a cursor token in the response (JSON shape) without filtering. Use on the first read of a polling loop.',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'send_prompt',
    description: 'Send a text prompt to a Claude/Codex session running in a WezTerm pane. The text is typed, Enter is pressed, and submission is VERIFIED by reading the pane back (retrying Enter if the text is still sitting in the input box). Returns {submitted: submitted|stuck|unknown} — no follow-up send_key("enter") needed unless it reports stuck. IMPORTANT: Only send to sessions that are in "idle" status, not "working".',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'number',
          description: 'The WezTerm pane ID to send to.',
        },
        text: {
          type: 'string',
          description: 'The prompt text to send to the Claude session.',
        },
      },
      required: ['pane_id', 'text'],
    },
  },
  {
    name: 'get_status',
    description: 'Get detailed status of a specific WezTerm pane — whether it\'s running Claude Code, its current status (idle/working/permission), the project it\'s in, and the last few lines of output.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'number',
          description: 'The WezTerm pane ID to check.',
        },
        verbose: {
          type: 'boolean',
          description: 'If true, return full path and output fields without redaction or truncation.',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all projects that have active Claude Code sessions, with session count and status breakdown per project. Quick overview of what\'s running across your development environment.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'send_key',
    description: 'Send a special key or short text to a pane WITHOUT pressing Enter. Useful for answering y/n permission prompts, pressing Enter to continue, or sending Ctrl+C to cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'number',
          description: 'The WezTerm pane ID.',
        },
        key: {
          type: 'string',
          description: 'The key to send. Special values: "y" (yes), "n" (no), "enter" (Enter key), "ctrl+c" (cancel). Or any short text.',
        },
      },
      required: ['pane_id', 'key'],
    },
  },
  {
    name: 'wait_for_idle',
    description: 'Poll a pane until the Claude session becomes idle (shows the ❯ prompt), then return the new output. Use after send_prompt to wait for the result. Times out after max_wait seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'number',
          description: 'The WezTerm pane ID to watch.',
        },
        max_wait: {
          type: 'number',
          description: 'Maximum seconds to wait before giving up. Default: 60. Max: 300.',
        },
        poll_interval: {
          type: 'number',
          description: 'Seconds between polls. Default: 3.',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'spawn_session',
    description: 'Launch a new agent session (Claude Code by default, or Codex, or a plain shell) in a new WezTerm pane. Starts a FRESH session by default (v3.5: no more implicit --continue). Optionally provide a project directory and an initial prompt (submission is verified). Returns the new pane ID.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Working directory for the new session (project path). Default: current directory.',
        },
        agent: {
          type: 'string',
          enum: ['claude', 'codex', 'shell'],
          description: "Which CLI to boot: 'claude' (default), 'codex', or 'shell' (leave the pane as a plain shell, no command typed). persona/resume/continue/permission flags apply to claude only.",
        },
        prompt: {
          type: 'string',
          description: 'Optional initial prompt to send after the agent starts up. The session will start, wait for the input prompt, then send this text and VERIFY it submitted.',
        },
        continue: {
          type: 'boolean',
          description: 'If true, launch with --continue (resume the most recent session for that cwd). Default false — fresh session. Before v3.5 --continue was the implicit default; it could wake a "new" peer inside an old conversation.',
        },
        resume: {
          type: 'string',
          description: 'Resume a specific named session. Pass the session name (e.g. "fork-webdesign").',
        },
        split_from: {
          type: 'number',
          description: 'If set, split from this pane ID instead of opening a new tab.',
        },
        dangerously_skip_permissions: {
          type: 'boolean',
          description: 'If true, launch Claude with --dangerously-skip-permissions. Default: false.',
        },
        persona: {
          type: 'string',
          description: "Name of a Claude agent persona from ~/.claude/agents/ to inject via --append-system-prompt-file. Example: 'coder', 'reviewer', 'dev-backend-api'. The persona .md file must exist in ~/.claude/agents/ (flat or nested in category dirs).",
        },
        permission_mode: {
          type: 'string',
          enum: ['default', 'plan', 'acceptEdits', 'bypassPermissions'],
          description: "Claude Code permission mode for the spawned session. 'plan' = read-only (good for reviewers), 'acceptEdits' = auto-approve edits (good for devs), 'bypassPermissions' = skip all (current default).",
        },
        model: {
          type: 'string',
          description: "Model alias for the spawned session, passed as --model (e.g. 'sonnet', 'haiku', 'opus'). Use to right-size executor panes per model-tiering (mechanical work -> haiku, routine -> sonnet). Omit to inherit the default model.",
        },
        spawned_by_pane_id: {
          type: 'number',
          description: "Pane ID of the coordinator that is spawning this peer. If provided, the initial prompt is wrapped with a [PEER-PANE CONTEXT] header telling the executor its own pane_id and the coordinator's pane_id, plus how to report back via A2A envelopes. Always set this when you are a peer pane spawning another peer.",
        },
      },
    },
  },
  {
    name: 'kill_session',
    description: 'Kill a WezTerm pane, terminating whatever is running in it. Use with caution — this force-kills the process.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: {
          type: 'number',
          description: 'The WezTerm pane ID to kill.',
        },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'split_pane',
    description: 'Split an existing pane into a new one (horizontal = side-by-side, vertical = top/bottom) without launching Claude automatically. Useful for opening a shell, Codex, or any other program next to an existing session. Returns the new pane ID.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'number', description: 'The source pane to split from.' },
        direction: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Split direction. Default: horizontal (side-by-side).' },
        cwd: { type: 'string', description: 'Working directory for the new pane. Default: same as source.' },
        program: { type: 'string', description: 'Program to launch in the new pane (e.g. "bash", "codex", "claude"). Default: user shell.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the program.' },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'set_tab_title',
    description: 'Set the WezTerm tab title for a pane. Useful for labeling A2A peer panes (e.g. "app-codex", "app-claude") so both sides of a multi-pane project are identifiable in the tab bar.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'number', description: 'The pane whose tab to rename.' },
        title: { type: 'string', description: 'The new tab title (recommended: "<project>-<agent>" when two panes share a project).' },
      },
      required: ['pane_id', 'title'],
    },
  },
  {
    name: 'spawn_ssh_domain',
    description: 'Spawn a pane connected to a WezTerm SSH domain. Requires the domain to be pre-configured in ~/.wezterm.lua. Returns the new pane ID. Use for running a remote Claude/Codex session on another machine while still controlling it from local wezbridge.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The SSH domain name as declared in wezterm.lua.' },
        cwd: { type: 'string', description: 'Remote working directory. Default: remote home.' },
        program: { type: 'string', description: 'Remote program to run. Default: remote shell.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the program.' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'list_workspaces',
    description: 'List all WezTerm workspaces and the panes in each. Returns {workspaces: [{name, panes: [...pane_ids]}]}. Some older WezTerm versions may not support workspaces — check the CHANGELOG if calls fail.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_workspace',
    description: 'Switch the active WezTerm workspace. Creates it if it does not exist. Not supported on all WezTerm versions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Target workspace name.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'spawn_in_workspace',
    description: 'Spawn a new pane in a named workspace. Creates the workspace if absent. Useful for grouping related panes (e.g. all Paperclip-app peers in a "paperclip" workspace). Returns the new pane ID.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name.' },
        cwd: { type: 'string', description: 'Working directory for the new pane.' },
        program: { type: 'string', description: 'Program to launch (default: user shell).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the program.' },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'auto_handoff',
    description: 'Trigger an intelligent auto-handoff on a pane: readiness check -> handoff file -> /clear -> continuation inject. The pane will self-report if it is ready (READY/NOT_READY). Use focus to guide what the handoff should prioritize.',
    inputSchema: {
      type: 'object',
      properties: {
        pane_id: { type: 'number', description: 'Target pane ID' },
        focus: { type: 'string', description: 'Optional: what should the handoff prioritize?' },
        force: { type: 'boolean', description: 'Skip readiness check (use when you know the pane is at a break point)' },
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'bridge_health',
    description: 'One-call self-diagnosis of the wezbridge stack: is the WezTerm CLI reachable, is the :4200 daemon up (and its version), is the session-snapshot crash-restore watcher armed, and how many panes are visible. Call this first when a wezbridge tool errors unexpectedly or when you are unsure whether the daemon is running.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clawtrol_task_reply',
    description: 'Append a provenance-tagged reply/note on a ledger task to the ClawTrol task thread (_intel/task-messages.jsonl, append-only). The bridge syncs it to the cockpit on its next poll. Use to answer an operator message that arrived from ClawTrol or to leave a durable task-thread note.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Ledger task id (T-NNNN) the message belongs to.' },
        message_type: { type: 'string', description: 'Message type, e.g. "reply", "note", "status". Default: "reply".' },
        content: { type: 'string', description: 'Message body (plain text, ≤4000 chars).' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'a2a_send',
    description: 'Send an A2A protocol envelope to a peer pane in ONE call: builds "[A2A from pane-N to pane-M | corr=<id> | type=<t>]\\n<body>", sends it with VERIFIED submission (no follow-up send_key needed), and returns {submitted, corr}. from_pane defaults to this session\'s own pane (WEZTERM_PANE env). Use this instead of hand-formatting envelopes with send_prompt. PREFER to_project over to_pane: pane ids reset on WezTerm restart (the misroute class); a project name is resolved to its live pane at send time AND the message is durably queued in _intel/queues/<project>.jsonl for deterministic retry if delivery fails.',
    inputSchema: {
      type: 'object',
      properties: {
        to_pane: { type: 'number', description: 'Target pane ID. Prefer to_project — pane ids are volatile across WezTerm restarts.' },
        to_project: { type: 'string', description: 'Target PROJECT name (canonical folder or tab label). Resolved to a live pane via pane-identity at send time; the envelope is always recorded to the durable per-project queue (_intel/queues/<project>.jsonl) so a failed delivery is retried by scripts/queue-drain.cjs instead of lost. Mutually exclusive with to_pane.' },
        body: { type: 'string', description: 'Envelope body (the actual message).' },
        type: { type: 'string', enum: ['request', 'ack', 'progress', 'result', 'error'], description: 'A2A message type. Default: request.' },
        corr: { type: 'string', description: 'Correlation id — keep it stable across a thread. Default: generated (returned in the response; reuse it for follow-ups).' },
        from_pane: { type: 'number', description: 'Sender pane ID. Default: WEZTERM_PANE env (your own pane).' },
        allow_long: { type: 'boolean', description: `Send a body over ${A2A_BODY_SOFT_LIMIT} chars anyway. Long envelopes are TRUNCATED in transit by the recipient's composer; the fix is almost always to write the content to a repo file and send a short pointer. Only set this when you have a specific reason the payload must go inline.` },
      },
      required: ['body'],
    },
  },
].filter(tool => tool.name !== 'switch_workspace' || SWITCH_WORKSPACE_SUPPORT.supported);

// ─── Tool Implementations ─────────────────────────────────────────────────

function handleToolCall(name, args) {
  switch (name) {
    case 'discover_sessions': {
      const onlyClaude = args.only_claude !== false; // default true
      const verbose = args.verbose === true;
      const panes = discovery.discoverPanes();
      const filtered = onlyClaude ? panes.filter(p => p.isClaude) : panes;

      // Don't send huge lastLines in the listing
      const summary = filtered.map(p => ({
        pane_id: p.paneId,
        // T-0281: contra que socket vale este pane_id, y si get-text contra ESE
        // socket devolvio texto que nombra al proyecto atribuido. socket null =
        // el wrapper no enumera sockets; verify dice por que no se verifico.
        socket: p.socket ?? null,
        verified: p.verified === true,
        verify: p.verify || 'socket-unknown',
        is_claude: p.isClaude,
        is_codex: p.isCodex,
        agent: p.agent,
        status: p.status,
        project: verbose ? p.project : redactHomePath(p.project),
        project_name: p.projectName,
        title: p.title,
        tab_title: p.tabTitle,
        workspace: p.workspace,
        confidence: p.confidence,
        last_line: formatLastText(
          verbose ? p.lastLines : p.lastLines.split('\n').filter(l => l.trim()).slice(-3).join('\n'),
          verbose
        ),
      }));

      const statusCounts = {};
      for (const p of filtered) {
        statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      }

      // A filtered count must NEVER present itself as the fleet. On 2026-07-28 a
      // bare call returned 8 while `wezterm cli list` showed 17 — the omitted 9
      // included the codex executor under active oversight and the daemon pane —
      // and the response said only `total: 8`, so 34 oversight passes ran blind.
      // `total` now always means "rows returned"; when a filter dropped panes we
      // say so, and say how many there really are.
      const dropped = panes.length - filtered.length;
      // T-0281: los sockets vivos con su conteo, y cuantas filas NO se verificaron.
      // Un pane_id sin socket es una direccion sin ciudad: se publica igual, pero
      // la respuesta lo dice, y el consumidor tiene que direccionar por proyecto.
      const socketCounts = {};
      for (const p of panes) { const k = p.socket ?? 'unknown'; socketCounts[k] = (socketCounts[k] || 0) + 1; }
      const unverified = filtered.filter((p) => p.verified !== true).length;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: filtered.length,
            sockets: socketCounts,
            unverified,
            ...(unverified > 0 ? { unverified_note: `${unverified} fila(s) sin verificar (ver campo verify por fila): su pane_id no se confirmo contra el mux con texto del proyecto — direcciona por proyecto, no por id.` } : {}),
            ...(dropped > 0 ? {
              filtered: true,
              total_unfiltered: panes.length,
              omitted: dropped,
              omitted_note: `${dropped} pane(s) hidden by only_claude=true (codex and shell panes). Pass only_claude:false for a full fleet census.`,
            } : { filtered: false, total_unfiltered: panes.length }),
            status_summary: statusCounts,
            sessions: summary,
          }, null, 2),
        }],
      };
    }

    case 'read_output': {
      const paneId = args.pane_id;
      const lines = Math.min(args.lines || 100, 500);

      try {
        const text = wez.getFullText(paneId, lines);
        // Strip empty trailing lines
        const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();

        // Delta mode: with a cursor (or with_cursor: true), respond with a
        // JSON object carrying only the NEW lines plus the next cursor.
        if (args.since !== undefined || args.with_cursor === true) {
          const allLines = cleaned.split('\n');
          const cursor = makeReadCursor(allLines);
          let newOutput = cleaned;
          let cursorFound = null;
          if (args.since !== undefined) {
            const delta = sliceAfterCursor(allLines, args.since);
            cursorFound = delta !== null;
            newOutput = cursorFound ? delta.join('\n') : cleaned;
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                new_output: newOutput,
                cursor,
                cursor_found: cursorFound,
                note: cursorFound === false ? 'cursor no longer matches (output scrolled past or invalid) — returning the full tail' : undefined,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{ type: 'text', text: cleaned }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error reading pane ${paneId}: ${err.message}` }],
          isError: true,
        };
      }
    }

    case 'send_prompt': {
      const paneId = args.pane_id;
      const text = args.text;
      const _guard = guardPaneTarget(paneId, 'send_prompt');
      if (_guard) return _guard;
      const promptLimitError = validateByteLength('prompt', text, INPUT_BYTE_LIMITS.prompt);
      if (promptLimitError) return promptLimitError;

      const _safety = safetyPolicy.evaluate({ action: 'send_prompt', paneId, prompt: text });
      if (!_safety.allowed) {
        if (_safety.tripwire) {
          return {
            content: [{ type: 'text', text: _safety.response }],
          };
        }
        return {
          content: [{ type: 'text', text: `safety-policy: BLOCKED send_prompt — ${_safety.reason}. Set WEZBRIDGE_SAFETY_OVERRIDE=1 to bypass.` }],
          isError: true,
        };
      }

      if (!text || !text.trim()) {
        return {
          content: [{ type: 'text', text: 'Error: empty prompt text' }],
          isError: true,
        };
      }

      // A hand-written envelope pushed through here would skip every control
      // a2a_send applies and leave no trace (mm-6043 / T-0265). Refuse it: the
      // gates are not optional just because a cheaper door exists.
      const smuggled = a2aIntel.detectSmuggledEnvelope(text);
      if (smuggled.smuggled) {
        a2aIntel.recordEvent({
          event: 'a2a.smuggled_envelope_refused',
          to_pane: paneId, corr: smuggled.corr, type: smuggled.type,
        });
        return {
          content: [{
            type: 'text',
            text: `smuggled-envelope: BLOCKED send_prompt — this text contains an A2A envelope (corr=${smuggled.corr}, type=${smuggled.type}). send_prompt applies NO dispatch gate, NO result-shape check, NO lease, NO durable queue and writes NO audit record, so hand-writing an envelope here bypasses every fleet control and leaves nothing behind. Use a2a_send (pass from_pane explicitly if you are a headless sender).`,
          }],
          isError: true,
        };
      }

      // Audit EVERY prompt, envelope or not: an unlogged write path into a
      // pane is how a request to delete a live 16 GB database arrived with no
      // record of who sent it. The body is hashed, never stored.
      try {
        // Recording only the DESTINATION was not enough: on 2026-08-25 this
        // audit caught two identical 16KB prompts sent to a pane that does not
        // exist, and could not name the sender — the exact question the audit
        // existed to answer. Identify the caller the same way a2a_send does.
        const promptSelf = require('./pane-identity.cjs').resolveSelfPane({
          envPane: parseInt(process.env.WEZTERM_PANE || '', 10),
          cwd: process.cwd(),
          panes: selfCensusFor(),
        });
        a2aIntel.recordEvent({
          event: 'prompt.sent',
          to_pane: paneId,
          from_pane: Number.isInteger(promptSelf.paneId) ? promptSelf.paneId : null,
          from_project: promptSelf.project || null,
          from_source: promptSelf.source,
          caller_cwd: process.cwd(),
          bytes: Buffer.byteLength(text, 'utf8'),
          body_sha256: require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16),
        });
      } catch { /* the audit must never block the send it is auditing */ }

      return (async () => {
        try {
          const sent = await sendPromptDeferredEnter(paneId, text);
          // T-0323: la primitiva rehusa si el composer retiene texto ajeno. NO
          // verificar despues: verifyPromptSubmission reintenta Enter y eso
          // mandaria el texto del operador.
          if (sent && sent.refused) {
            return { content: [{ type: 'text', text: `REFUSED (${sent.refused}): pane ${paneId} composer holds UNSENT text ${JSON.stringify(String(sent.held).slice(0, 120))} — nothing was typed. A key from the operator unblocks it; a script that must override calls verified-send with force:true + why (audited as composer-override).` }], isError: true };
          }
          // Read back instead of firing blind extra enters (claim-8945 fix):
          // confirm the text actually left the input box, retry enter if not.
          const submitted = await verifyPromptSubmission(paneId, text);
          log(`Sent prompt to pane ${paneId} [${submitted}]: ${text.slice(0, 80)}...`);
          const note = {
            submitted: 'Prompt sent to pane ' + paneId + ' and VERIFIED submitted (left the input box). Use read_output or get_status later for the result. No follow-up send_key("enter") needed.',
            stuck: 'Prompt was typed into pane ' + paneId + ' but still sits UNSUBMITTED in the input box after retries. Send send_key("enter") manually or check the pane state with get_status.',
            unknown: 'Prompt sent to pane ' + paneId + '. Submission could not be verified (pane unreadable or non-TUI shell prompt) — enter was sent; check with read_output if in doubt.',
          }[submitted];
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: submitted !== 'stuck', submitted, message: note }, null, 2) }],
            isError: false,
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error sending to pane ${paneId}: ${err.message}` }],
            isError: true,
          };
        }
      })();
    }

    case 'get_status': {
      const paneId = args.pane_id;
      const verbose = args.verbose === true;

      try {
        const allPanes = discovery.discoverPanes();
        const pane = allPanes.find(p => p.paneId === paneId);

        if (!pane) {
          return {
            content: [{ type: 'text', text: `Pane ${paneId} not found. Run discover_sessions to see available panes.` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              pane_id: pane.paneId,
              is_claude: pane.isClaude,
              is_codex: pane.isCodex,
              agent: pane.agent,
              status: pane.status,
              project: verbose ? pane.project : redactHomePath(pane.project),
              project_name: pane.projectName,
              title: pane.title,
              tab_title: pane.tabTitle,
              workspace: pane.workspace,
              confidence: pane.confidence,
              last_lines: formatLastText(
                verbose ? pane.lastLines : pane.lastLines.split('\n').filter(l => l.trim()).slice(-10).join('\n'),
                verbose
              ),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error checking pane ${paneId}: ${err.message}` }],
          isError: true,
        };
      }
    }

    case 'list_projects': {
      const summary = discovery.getSummary();

      const projects = {};
      for (const [name, panes] of Object.entries(summary.projects)) {
        projects[name] = {
          session_count: panes.length,
          pane_ids: panes.map(p => p.paneId),
          statuses: panes.map(p => `${p.paneId}:${p.status}`),
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total_sessions: summary.total,
            status_breakdown: summary.byStatus,
            projects,
          }, null, 2),
        }],
      };
    }

    case 'send_key': {
      const paneId = args.pane_id;
      let key = args.key;
      const _guard = guardPaneTarget(paneId, 'send_key');
      if (_guard) return _guard;
      const keyLimitError = validateByteLength('key', key, INPUT_BYTE_LIMITS.key);
      if (keyLimitError) return keyLimitError;

      const _safety = safetyPolicy.evaluate({ action: 'send_key', paneId, key });
      if (!_safety.allowed) {
        return {
          content: [{ type: 'text', text: `safety-policy: BLOCKED send_key — ${_safety.reason}. Set WEZBRIDGE_SAFETY_OVERRIDE=1 to bypass.` }],
          isError: true,
        };
      }

      try {
        switch (key.toLowerCase()) {
          case 'enter':
            wez.sendText(paneId, ''); // sendText adds \r
            break;
          case 'ctrl+c':
          case 'ctrl-c':
            // Send ETX (Ctrl+C = ASCII 3)
            wez.sendTextNoEnter(paneId, '\x03');
            break;
          case 'alt+m':
          case 'meta+m':
            // ESC + m = Alt+M (toggle permission mode in Claude Code)
            wez.sendTextNoEnter(paneId, '\x1bm');
            break;
          case 'y': case '1':
            wez.sendTextNoEnter(paneId, '1'); // Select option 1 (Yes)
            break;
          case 'n': case '2':
            wez.sendTextNoEnter(paneId, '2'); // Select option 2
            break;
          case '3':
            wez.sendTextNoEnter(paneId, '3'); // Select option 3
            break;
          default:
            wez.sendTextNoEnter(paneId, key);
            break;
        }

        return {
          content: [{ type: 'text', text: `Key "${key}" sent to pane ${paneId}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error sending key to pane ${paneId}: ${err.message}` }],
          isError: true,
        };
      }
    }

    case 'wait_for_idle': return (async () => {
      const paneId = args.pane_id;
      const maxWait = Math.min(args.max_wait || 60, 300);
      const pollInterval = Math.max(args.poll_interval || 3, 1);

      const startTime = Date.now();
      const deadline = startTime + maxWait * 1000;

      let lastText = '';
      let timedOut = true;

      while (Date.now() < deadline) {
        try {
          // We're explicitly waiting for a state CHANGE — a stale cached read
          // defeats the purpose, so bust this pane's text cache each poll.
          wez.invalidateGetTextCache(paneId);
          const text = wez.getFullText(paneId, 50);
          const lines = text.split('\n').filter(l => l.trim());
          lastText = lines.slice(-20).join('\n');

          // Check if idle: any of the last 15 lines is a bare prompt ❯ or >
          // (Claude Code renders the prompt above the status bar, so the literal
          // last line is usually "⏵⏵ bypass permissions on ...", not ❯)
          const tail = lines.slice(-15);
          const isIdle = tail.some(l => /^\s*[❯>]\s*$/.test(l));
          if (isIdle) {
            timedOut = false;
            break;
          }

          // Also check permission prompts — those also need attention
          const hasPermissionPrompt = tail.some(l => /\(y\/n\)|\(Y\/n\)|Allow .+\? \[y\/N\]|Do you want to proceed/i.test(l));
          if (hasPermissionPrompt) {
            timedOut = false;
            break;
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error reading pane ${paneId}: ${err.message}` }],
            isError: true,
          };
        }

        await sleep(pollInterval * 1000);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (timedOut) {
        return {
          content: [{
            type: 'text',
            text: `Timed out after ${elapsed}s waiting for pane ${paneId} to become idle.\n\nLast output:\n${lastText}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Pane ${paneId} is now idle (waited ${elapsed}s).\n\nOutput:\n${lastText}`,
        }],
      };
    })();

    case 'spawn_session': {
      const cwd = args.cwd || process.cwd();
      const promptLimitError = validateByteLength('prompt', args.prompt, INPUT_BYTE_LIMITS.prompt);
      if (promptLimitError) return promptLimitError;
      // F-SEC-2b: --dangerously-skip-permissions is only honored when the operator
      // has explicitly opted in via env. Any caller request for it is ignored otherwise.
      const skipPerms =
        (args.dangerously_skip_permissions || false) &&
        process.env.WEZBRIDGE_ALLOW_SKIP_PERMISSIONS === 'true';
      const permissionMode = args.permission_mode === undefined || args.permission_mode === null
        ? null
        : String(args.permission_mode);

      if (permissionMode && !VALID_PERMISSION_MODES.has(permissionMode)) {
        return {
          content: [{ type: 'text', text: `Error: invalid permission_mode "${permissionMode}"` }],
          isError: true,
        };
      }

      if (permissionMode) {
        try {
          safetyPolicy.assertBypassPermissionsAllowed({ body: { permission_mode: permissionMode } });
        } catch (err) {
          return {
            content: [{ type: 'text', text: err.message }],
            isError: true,
          };
        }
      }

      if (args.model !== undefined && args.model !== null && !isValidModelName(args.model)) {
        return {
          content: [{ type: 'text', text: `Error: invalid model "${args.model}"` }],
          isError: true,
        };
      }

      if (args.resume && !isValidResumeSession(args.resume)) {
        return {
          content: [{ type: 'text', text: 'Error: invalid resume session identifier' }],
          isError: true,
        };
      }

      // Resolve persona if provided
      let personaPath = null;
      if (args.persona) {
        if (!isValidPersonaName(args.persona)) {
          return {
            content: [{ type: 'text', text: 'Error: invalid persona name' }],
            isError: true,
          };
        }
        personaPath = resolvePersona(args.persona);
        if (!personaPath) {
          return {
            content: [{ type: 'text', text: `persona "${args.persona}" not found in ~/.claude/agents/` }],
            isError: true,
          };
        }
      }

      // Which CLI boots in the pane. 'shell' leaves the pane as a plain shell
      // (no command typed) — useful for scratch panes and e2e tests.
      // Affinity (B2, frente 3): _intel/affinity.json maps project → {agent,
      // model} and supplies the DEFAULT when the caller names no agent. An
      // explicit caller choice always wins but is logged (affinity_override),
      // so misroutes-by-habit become measurable instead of invisible.
      const lifecycle = require('./lifecycle.cjs');
      const spawnProject = require('./pane-identity.cjs').projectFromCwd(cwd);
      const affinity = lifecycle.resolveAffinity({ project: spawnProject });
      const claudeOnlyFlags = Boolean(args.persona || args.resume || args.continue === true || permissionMode || skipPerms);
      let agent;
      if (args.agent === undefined || args.agent === null) {
        if (affinity.agent && claudeOnlyFlags && affinity.agent !== 'claude') {
          // Caller asked for claude-only behavior without naming the agent —
          // honoring the codex affinity would break persona/resume/permission
          // flags, so claude wins, but the implicit override is logged.
          agent = 'claude';
          try {
            require('./action-log.cjs').logAction('affinity_override', {
              target: spawnProject || cwd,
              why: `claude-only flags present — affinity agent "${affinity.agent}" not applied`,
              project: spawnProject,
            });
          } catch { /* fail-soft */ }
        } else {
          agent = affinity.agent || 'claude';
        }
      } else {
        agent = String(args.agent);
        if (affinity.agent && affinity.agent !== agent) {
          try {
            require('./action-log.cjs').logAction('affinity_override', {
              target: spawnProject || cwd,
              why: `caller agent="${agent}" overrides affinity "${affinity.agent}"`,
              project: spawnProject,
            });
          } catch { /* fail-soft */ }
        }
      }
      if (!['claude', 'codex', 'shell'].includes(agent)) {
        return {
          content: [{ type: 'text', text: `Error: invalid agent "${agent}" (claude | codex | shell)` }],
          isError: true,
        };
      }
      if (agent !== 'claude' && (args.persona || args.resume || args.continue || permissionMode || skipPerms)) {
        return {
          content: [{ type: 'text', text: `Error: persona/resume/continue/permission flags only apply to agent "claude" (got agent="${agent}")` }],
          isError: true,
        };
      }

      return (async () => {
      try {
        // Spawn a plain shell pane, then send the CLI command as text.
        // This works on all platforms (Windows cmd, bash, pwsh) without
        // needing to know the user's shell in advance.
        // Affinity model applies only as default and only when valid; a caller
        // model that differs from a declared affinity model is a logged override.
        const affinityModel = affinity.model && isValidModelName(affinity.model) ? String(affinity.model) : null;
        const effectiveModel = args.model ? String(args.model) : affinityModel;
        if (args.model && affinity.model && String(args.model) !== String(affinity.model)) {
          try {
            require('./action-log.cjs').logAction('affinity_override', {
              target: spawnProject || cwd,
              why: `caller model="${args.model}" overrides affinity model "${affinity.model}"`,
              project: spawnProject,
            });
          } catch { /* fail-soft */ }
        }
        const spawnWhy = typeof args.spawned_by_pane_id === 'number'
          ? `spawned_by=pane-${args.spawned_by_pane_id} agent=${agent}`
          : `agent=${agent}`;
        let newPaneId;
        if (args.split_from !== undefined) {
          newPaneId = wez.splitHorizontal(args.split_from, { cwd });
        } else {
          newPaneId = wez.spawnPane({ cwd, why: spawnWhy });
        }

        // Give the shell a moment to initialize (async — doesn't block other tool calls)
        await sleep(2000);

        // Build the CLI command. DEFAULT IS A FRESH SESSION (since v3.5.0):
        // --continue resumed whatever session last ran in that cwd, so a "new
        // peer" could wake up inside an old conversation. Personas always
        // deliberately avoided this; now every spawn does. Opt back in with
        // continue: true, or resume a named session with resume.
        let cliCmd = null;
        if (agent === 'claude') {
          const claudeArgv = ['claude'];
          if (personaPath) {
            claudeArgv.push('--append-system-prompt-file', personaPath.replace(/\\/g, '/'));
          } else if (args.resume) {
            claudeArgv.push('-r', String(args.resume));
          } else if (args.continue === true) {
            claudeArgv.push('--continue');
          }
          if (skipPerms) claudeArgv.push('--dangerously-skip-permissions');
          if (permissionMode) claudeArgv.push('--permission-mode', permissionMode);
          if (effectiveModel) claudeArgv.push('--model', effectiveModel);
          cliCmd = claudeArgv.map(shellQuoteArg).join(' ');
        } else if (agent === 'codex') {
          const codexArgv = ['codex'];
          if (effectiveModel) codexArgv.push('--model', effectiveModel);
          cliCmd = codexArgv.map(shellQuoteArg).join(' ');
        }
        // M3: a mux relaunched from inside a Claude session poisons every
        // spawned pane with CLAUDE_CODE_CHILD_SESSION (transcript saving OFF —
        // it cost a whole session on 2026-08-23). Sanitize at the one choke
        // point we control: the typed command. See src/spawn-env.cjs.
        if (cliCmd) cliCmd = require('./spawn-env.cjs').sanitizeAgentCmd(cliCmd, agent);
        if (cliCmd) wez.sendText(newPaneId, cliCmd);

        // Set tab title to persona name for discoverPanes() detection
        if (args.persona) {
          try { wez.setTabTitle(newPaneId, '[' + args.persona + ']'); } catch { /* ignore */ }
        }

        log(`Spawned ${agent} pane ${newPaneId} at ${cwd}${args.persona ? ' [persona=' + args.persona + ']' : ''}`);

        let promptSubmitted = null;
        // If an initial prompt was given, wait for the session to boot then send it
        if (args.prompt) {
          // Give the TUI a few seconds to start up and show its input prompt
          const bootWait = agent === 'shell' ? 1 : 8;
          for (let i = 0; i < bootWait; i++) {
            await sleep(1000);
            try {
              wez.invalidateGetTextCache(newPaneId);
              const text = wez.getFullText(newPaneId, 20);
              if (/[❯>›]\s*$/m.test(text)) break;
            } catch { /* pane not ready */ }
          }

          // If the caller declared itself as coordinator, wrap the prompt with a
          // peer-pane bootstrap so the executor knows (a) its own pane_id,
          // (b) its coordinator's pane_id, (c) how to emit A2A envelopes back.
          // Persona files were written for in-process Agent subagents and have
          // no A2A awareness; this prefix bridges that gap without touching
          // 95+ persona files.
          let finalPrompt = args.prompt;
          if (typeof args.spawned_by_pane_id === 'number') {
            const coord = args.spawned_by_pane_id;
            const me = newPaneId;
            const header = [
              '[PEER-PANE CONTEXT]',
              `You are pane-${me}. You were spawned by pane-${coord} (your coordinator).`,
              'You are a PEER PANE (not an in-process Agent/Task subagent). Report progress back via:',
              `  mcp__wezbridge__send_prompt({ pane_id: ${coord}, text: "[A2A from pane-${me} to pane-${coord} | corr=<coord-chosen or invented> | type=progress|result|error]\\n<body>" })`,
              `  mcp__wezbridge__send_key({ pane_id: ${coord}, key: "enter" })`,
              'Cadence: emit type=progress every ~3 min during long work; type=result (with commit SHA / artefact path) on completion; type=error (with reason) on abort.',
              'See ~/.claude/CLAUDE.md "Peer-Pane A2A Protocol" for envelope rules and "Coordinator role declaration" if you plan to spawn your own peers.',
              '',
              '[TASK]',
              '',
            ].join('\n');
            finalPrompt = header + args.prompt;
          }

          const sent = await sendPromptDeferredEnter(newPaneId, finalPrompt);
          if (sent && sent.refused) {
            // T-0323: un pane recien nacido no deberia retener texto; si lo hace,
            // no se verifica (el retry de Enter lo mandaria) y se reporta.
            promptSubmitted = `refused:${sent.refused}`;
          } else {
            // Verified submission (claim-8945 fix) — read the input box back
            // and retry enter until the prompt actually leaves it.
            promptSubmitted = await verifyPromptSubmission(newPaneId, finalPrompt);
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              pane_id: newPaneId,
              cwd,
              agent,
              persona: args.persona || null,
              permission_mode: args.permission_mode || null,
              model: effectiveModel || null,
              ...(affinity.agent || affinityModel ? {
                affinity: {
                  project: spawnProject,
                  agent: affinity.agent,
                  model: affinityModel,
                  applied_agent: (args.agent === undefined || args.agent === null) && agent === affinity.agent,
                  applied_model: !args.model && Boolean(affinityModel),
                },
              } : {}),
              fresh_session: agent === 'claude' && !args.resume && args.continue !== true,
              spawned_by_pane_id: typeof args.spawned_by_pane_id === 'number' ? args.spawned_by_pane_id : null,
              initial_prompt: args.prompt || null,
              initial_prompt_submitted: promptSubmitted,
              message: `${agent} pane spawned: ${newPaneId}.${args.persona ? ' Persona: ' + args.persona + '.' : ''} ${args.prompt ? `Initial prompt ${promptSubmitted === 'submitted' ? 'sent and verified' : promptSubmitted === 'stuck' ? 'typed but STUCK in input box — send send_key("enter")' : 'sent (unverified)'}.` : 'Ready for prompts.'}${typeof args.spawned_by_pane_id === 'number' ? ' Peer-pane bootstrap injected (coordinator=pane-' + args.spawned_by_pane_id + ').' : ''}`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error spawning session: ${err.message}` }],
          isError: true,
        };
      }
      })();
    }

    case 'kill_session': {
      const paneId = args.pane_id;
      const _guard = guardPaneTarget(paneId, 'kill_session');
      if (_guard) return _guard;

      const _safety = safetyPolicy.evaluate({ action: 'kill_session', paneId });
      if (!_safety.allowed) {
        return {
          content: [{ type: 'text', text: `safety-policy: BLOCKED kill_session — ${_safety.reason}. Set WEZBRIDGE_SAFETY_OVERRIDE=1 to bypass.` }],
          isError: true,
        };
      }

      try {
        log(JSON.stringify({
          op: 'kill_session',
          pane_id: paneId,
          caller_meta: args.caller_meta || null,
          timestamp: new Date().toISOString(),
        }));
        // Send Ctrl+C first to gracefully stop, then kill
        try { wez.sendTextNoEnter(paneId, '\x03'); } catch { /* ignore */ }
        wez.killPane(paneId, {
          why: args.caller_meta ? `kill_session caller_meta=${JSON.stringify(args.caller_meta).slice(0, 200)}` : 'kill_session',
        });

        return {
          content: [{ type: 'text', text: `Pane ${paneId} killed.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error killing pane ${paneId}: ${err.message}` }],
          isError: true,
        };
      }
    }

    case 'split_pane': {
      try {
        const direction = args.direction === 'vertical' ? 'vertical' : 'horizontal';
        const opts = {};
        const programLimitError = validateByteLength('program', args.program, INPUT_BYTE_LIMITS.name);
        if (programLimitError) return programLimitError;
        const argsLimitError = validateJsonArgsByteLength(args.args);
        if (argsLimitError) return argsLimitError;
        if (args.cwd) opts.cwd = args.cwd;
        if (args.program) opts.program = args.program;
        if (args.args) opts.args = args.args;
        log(JSON.stringify({
          op: 'split_pane',
          caller: args.caller_meta || null,
          args_summary: {
            pane_id: args.pane_id,
            direction,
            has_cwd: !!args.cwd,
            program: args.program || null,
            args_count: Array.isArray(args.args) ? args.args.length : 0,
          },
          timestamp: new Date().toISOString(),
        }));
        const newId = direction === 'vertical'
          ? wez.splitVertical(args.pane_id, opts)
          : wez.splitHorizontal(args.pane_id, opts);
        return {
          content: [{ type: 'text', text: JSON.stringify({ pane_id: newId, direction, source_pane: args.pane_id }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error splitting pane ${args.pane_id}: ${err.message}` }], isError: true };
      }
    }

    case 'set_tab_title': {
      const _guard = guardPaneTarget(args.pane_id, 'set_tab_title');
      if (_guard) return _guard;
      try {
        wez.setTabTitle(args.pane_id, String(args.title));
        return { content: [{ type: 'text', text: `Pane ${args.pane_id} tab title set to "${args.title}".` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error renaming tab: ${err.message}` }], isError: true };
      }
    }

    case 'spawn_ssh_domain': {
      try {
        const opts = {};
        const programLimitError = validateByteLength('program', args.program, INPUT_BYTE_LIMITS.name);
        if (programLimitError) return programLimitError;
        const argsLimitError = validateJsonArgsByteLength(args.args);
        if (argsLimitError) return argsLimitError;
        if (args.cwd) opts.cwd = args.cwd;
        if (args.program) opts.program = args.program;
        if (args.args) opts.args = args.args;
        log(JSON.stringify({
          op: 'spawn_ssh_domain',
          caller: args.caller_meta || null,
          args_summary: {
            domain: args.domain,
            has_cwd: !!args.cwd,
            program: args.program || null,
            args_count: Array.isArray(args.args) ? args.args.length : 0,
          },
          timestamp: new Date().toISOString(),
        }));
        const newId = wez.spawnSshDomain(args.domain, opts);
        return {
          content: [{ type: 'text', text: JSON.stringify({ pane_id: newId, domain: args.domain, cwd: args.cwd || '(remote home)' }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error spawning on SSH domain "${args.domain}": ${err.message}` }], isError: true };
      }
    }

    case 'list_workspaces': {
      try {
        const workspaces = wez.listWorkspaces();
        // Group panes by workspace for convenience
        const panes = wez.listPanes();
        const byWorkspace = {};
        for (const ws of workspaces) byWorkspace[ws] = [];
        for (const p of panes) {
          const ws = p.workspace || 'default';
          if (!byWorkspace[ws]) byWorkspace[ws] = [];
          byWorkspace[ws].push(p.pane_id);
        }
        const result = Object.entries(byWorkspace).map(([ws, pids]) => ({ name: ws, panes: pids }));
        return { content: [{ type: 'text', text: JSON.stringify({ workspaces: result }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error listing workspaces: ${err.message}` }], isError: true };
      }
    }

    case 'switch_workspace': {
      try {
        if (!SWITCH_WORKSPACE_SUPPORT.supported) {
          return mcpError(`Error: switch_workspace unsupported: ${SWITCH_WORKSPACE_SUPPORT.reason}`);
        }
        const nameLimitError = validateByteLength('name', args.name, INPUT_BYTE_LIMITS.name);
        if (nameLimitError) return nameLimitError;
        wez.switchWorkspace(String(args.name));
        return { content: [{ type: 'text', text: `Switched to workspace "${args.name}".` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error switching workspace: ${err.message}` }], isError: true };
      }
    }

    case 'spawn_in_workspace': {
      try {
        const opts = {};
        const programLimitError = validateByteLength('program', args.program, INPUT_BYTE_LIMITS.name);
        if (programLimitError) return programLimitError;
        const argsLimitError = validateJsonArgsByteLength(args.args);
        if (argsLimitError) return argsLimitError;
        if (args.cwd) opts.cwd = args.cwd;
        if (args.program) opts.program = args.program;
        if (args.args) opts.args = args.args;
        log(JSON.stringify({
          op: 'spawn_in_workspace',
          caller: args.caller_meta || null,
          args_summary: {
            workspace: args.workspace,
            has_cwd: !!args.cwd,
            program: args.program || null,
            args_count: Array.isArray(args.args) ? args.args.length : 0,
          },
          timestamp: new Date().toISOString(),
        }));
        const newId = wez.spawnInWorkspace(String(args.workspace), opts);
        return {
          content: [{ type: 'text', text: JSON.stringify({ pane_id: newId, workspace: args.workspace }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error spawning in workspace "${args.workspace}": ${err.message}` }], isError: true };
      }
    }

    case 'auto_handoff': {
      const focusLimitError = validateByteLength('focus', args.focus, INPUT_BYTE_LIMITS.focus);
      if (focusLimitError) return focusLimitError;

      const _safety = safetyPolicy.evaluate({ action: 'auto_handoff', paneId: args.pane_id });
      if (!_safety.allowed) {
        return {
          content: [{ type: 'text', text: `safety-policy: BLOCKED auto_handoff — ${_safety.reason}. Set WEZBRIDGE_SAFETY_OVERRIDE=1 to bypass.` }],
          isError: true,
        };
      }

      const dashPort = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
      const reqBody = JSON.stringify({ focus: args.focus || '', force: !!args.force });
      return new Promise((resolve) => {
        const http = require('http');
        const req = http.request({
          host: 'localhost',
          port: dashPort,
          method: 'POST',
          path: `/api/panes/${args.pane_id}/auto-handoff`,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
        }, (res) => {
          let chunks = '';
          res.on('data', c => { chunks += c; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(chunks); } catch { parsed = { raw: chunks }; }
            resolve({
              content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
              isError: res.statusCode >= 400,
            });
          });
        });
        req.on('error', (err) => {
          resolve({
            content: [{ type: 'text', text: `Error contacting dashboard at localhost:${dashPort}: ${err.message}. The :4200 daemon may be down — run \`npm run dashboard\` in the wezbridge repo, or call bridge_health to confirm.` }],
            isError: true,
          });
        });
        req.setTimeout(120000, () => {
          req.destroy();
          resolve({
            content: [{ type: 'text', text: 'auto_handoff timed out after 120s' }],
            isError: true,
          });
        });
        req.write(reqBody);
        req.end();
      });
    }

    case 'bridge_health':
      return handleBridgeHealth();

    case 'clawtrol_task_reply': {
      const taskId = String(args.task_id || '');
      const content = String(args.content || '').trim();
      if (!/^T-\d+$/.test(taskId)) {
        return { content: [{ type: 'text', text: 'Error: task_id must be a ledger id (T-NNNN)' }], isError: true };
      }
      if (!content) {
        return { content: [{ type: 'text', text: 'Error: empty content' }], isError: true };
      }
      try {
        const bridge = require('./clawtrol-bridge.cjs');
        bridge.appendTaskMessage({
          task_id: taskId,
          message_type: String(args.message_type || 'reply'),
          content: content.slice(0, 4000),
          provenance: 'orchestrator',
          sender_name: `pane-${process.env.WEZTERM_PANE || '?'}`,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task_id: taskId, note: 'appended to task-messages.jsonl; bridge syncs it on the next poll' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error appending task message: ${err.message}` }], isError: true };
      }
    }

    case 'a2a_send': return (async () => {
      const toProject = args.to_project === undefined || args.to_project === null
        ? null : String(args.to_project).trim();
      let toPane = args.to_pane;
      let body = args.body;
      if (toProject && toPane !== undefined && toPane !== null) {
        return { content: [{ type: 'text', text: 'Error: pass EITHER to_project OR to_pane, not both — to_project resolves the pane itself at send time' }], isError: true };
      }
      if (!toProject && (typeof toPane !== 'number' || !Number.isInteger(toPane))) {
        return { content: [{ type: 'text', text: 'Error: to_pane must be an integer pane id (or pass to_project to resolve by project name)' }], isError: true };
      }
      if (!body || !String(body).trim()) {
        return { content: [{ type: 'text', text: 'Error: empty body' }], isError: true };
      }
      const bodyLimitError = validateByteLength('prompt', body, INPUT_BYTE_LIMITS.prompt);
      if (bodyLimitError) return bodyLimitError;
      // REFUSE BEFORE SENDING, not after. This tool already detected truncation
      // post-hoc and reported DELIVERY INTEGRITY FAILURE — but a warning that
      // arrives after the fact only teaches the caller to retry shorter, which
      // means the rule is re-learned every session and obeyed only once caught.
      // On 2026-08-13 pane-0 truncated FIVE envelopes in one session, including
      // one an hour after publishing a self-audit about this exact failure.
      // A rule you follow only after being caught is not a rule you follow.
      const msgType = args.type === undefined || args.type === null ? 'request' : String(args.type);
      if (!['request', 'ack', 'progress', 'result', 'error'].includes(msgType)) {
        return { content: [{ type: 'text', text: `Error: invalid type "${msgType}" (request|ack|progress|result|error)` }], isError: true };
      }
      // T-0235: WEZTERM_PANE is stamped at MCP-server spawn and never updates —
      // after a WezTerm restart it signs envelopes as a dead or foreign pane
      // (pane-0 signed as 6, 1 and 2 within one hour on 2026-08-23). The env id
      // is transport, not identity: verify it against the live census and
      // correct it when the census disagrees. Explicit from_pane stays trusted
      // verbatim (the documented path for external/headless senders).
      const selfIdentity = require('./pane-identity.cjs');
      let selfCensus = [];
      try {
        selfCensus = discovery.discoverPanes()
          .filter((p) => p.agent)
          .map((p) => ({ pane_id: p.paneId, cwd: p.project, tab_title: p.tabTitle || p.title || null }));
      } catch { /* census down → resolveSelfPane falls back to env with a warning */ }
      const selfRes = selfIdentity.resolveSelfPane({
        explicitPane: typeof args.from_pane === 'number' ? args.from_pane : undefined,
        envPane: parseInt(process.env.WEZTERM_PANE || '', 10),
        cwd: process.cwd(),
        panes: selfCensus,
      });
      const fromPane = selfRes.paneId;
      if (!Number.isInteger(fromPane)) {
        return { content: [{ type: 'text', text: `Error: from_pane not given, WEZTERM_PANE env not set, and the census could not resolve this session (${selfRes.warning || 'no match'}) — pass from_pane explicitly` }], isError: true };
      }
      if (selfRes.source === 'env-corrected') {
        log(`a2a_send self-identity corrected: ${selfRes.warning}`);
      }
      const corr = args.corr === undefined || args.corr === null
        ? `a2a-${Date.now().toString(36)}`
        : String(args.corr);
      // W2: `:` entra al vocabulario porque la convencion de despacho a Eve es
      // `<T-id>:<slug>:<yyyymmdd>` (mutada a `:rN` en revisiones) y es el UNICO
      // string que sobrevive el viaje de ida y vuelta a FinalOrchestra. El resto
      // del charset sigue cerrado: `/`, `\` y espacios quedan afuera porque el
      // corr llega a formar nombres de archivo (a2a-length-guard lo sanea igual,
      // cinturon y tiradores).
      if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(corr)) {
        return { content: [{ type: 'text', text: 'Error: corr must be 1-64 chars of [a-zA-Z0-9._:-]' }], isError: true };
      }
      // DERRAMAR ANTES QUE REFUSAR. La refusion tenia razon en el diagnostico y
      // se quedaba corta en el remedio: le devolvia el trabajo al llamador.
      // Medido el 2026-08-29 en UNA sesion: se disparo SEIS veces, el emisor
      // acorto a mano las seis, y DOS de esos reenvios "cortos" volvieron igual
      // con delivered:truncated. Acortar a ojo no es confiable; derramar si.
      // La refusion queda como respaldo para cuando el disco no coopera.
      let spillNote = '';
      if (args.allow_long !== true) {
        const sp = a2aSpill({
          body,
          corr,
          dir: require('node:path').join(a2aIntel.intelDir(), 'spill'),
          writeFile: (f, c) => {
            const fsx = require('node:fs');
            fsx.mkdirSync(require('node:path').dirname(f), { recursive: true });
            fsx.writeFileSync(f, c, 'utf8');
          },
        });
        if (sp.spilled) {
          body = sp.body;
          spillNote = ` Cuerpo derramado a ${sp.path} y enviado como puntero (no se trunco nada).`;
        } else if (sp.error) {
          const lengthRefusal = a2aLengthRefusal(body, args.allow_long);
          if (lengthRefusal) return { content: [{ type: 'text', text: `${lengthRefusal}

(el derrame automatico fallo: ${sp.error})` }], isError: true };
        }
      }

      // R2: a type=result without a criteria: block (per-criterion pass|fail)
      // is refused BEFORE transport — validate the draft, not the delivery
      // (swarm-forge handoffd pattern). The error tells the sender exactly
      // what to add; WEZBRIDGE_RESULT_SHAPE_ENFORCE=0 reverts to warn-only.
      //
      // W2 (2026-09-01): este bloque y el registro del cuerpo se MOVIERON aca,
      // ANTES del early-return de la cola. La rama `to_project` sin pane vivo
      // retornaba primero, asi que un result que viajaba encolado no pasaba por
      // el shape-check y NUNCA llegaba a a2a-results.jsonl: el camino que menos
      // se mira era, otra vez, el unico sin control.
      const resultShape = a2aIntel.checkResultShape({ type: msgType, body });
      if (!resultShape.allowed) {
        a2aIntel.recordEvent({ event: 'a2a.result_shape_refused', from_pane: fromPane, to_pane: toPane === undefined ? null : toPane, corr, type: msgType, shape: resultShape.shape });
        return { content: [{ type: 'text', text: `result-shape: BLOCKED a2a_send — ${resultShape.reason}` }], isError: true };
      }
      const v2 = msgType === 'result' ? a2aIntel.detectV2(body) : undefined;

      // Registrar el cuerpo y LIGARLO a su tarjeta, UNA sola vez, tome el envio
      // la rama entregada o la de cola. `recordedResult.time` es lo que hace que
      // la evidencia apunte a la linea exacta y no a "llego un result".
      // Fail-soft entero: el linker corre en el camino de respuesta del send y
      // no puede demorarlo ni tumbarlo (por eso el try, y por eso el ledger va
      // por CLI con timeout).
      let recordedResult = null;
      let ledgerNote = '';
      const recordAndLinkResult = (resolvedPane) => {
        if (msgType !== 'result' || recordedResult) return;
        const pane = resolvedPane === undefined ? null : resolvedPane;
        try {
          // El guard se repite a proposito: `test/a2a-intel.test.cjs` lo
          // verifica A NIVEL DE FUENTE (este archivo no exporta nada), y esa
          // asercion es lo unico que impide que un cuerpo que no es result
          // termine en a2a-results.jsonl. No lo "simplifiques".
          if (msgType === 'result') recordedResult = a2aIntel.recordResultBody({ corr, fromPane, toPane: pane, v2, body });
          if (!recordedResult) return;
          const resultLinker = require('./result-linker.cjs');
          const linked = resultLinker.link(
            { time: recordedResult.time, corr, from_pane: fromPane, to_pane: pane, v2, body },
            {
              runLedger: resultLinker.defaultRunLedger,
              readTasks: resultLinker.defaultReadTasks,
              recordEvent: a2aIntel.recordEvent,
            },
          );
          if (linked.linked) ledgerNote = ` Ledger: ${linked.id} ${linked.from} → ${linked.to}.`;
          else if (!linked.noop) ledgerNote = ` Ledger: result NOT linked (${linked.reason}) — la tarjeta NO se movio; nombrala en el ledger o corregi el corr.`;
        } catch { /* fail-soft: ligar una tarjeta nunca puede tumbar un envio */ }
      };

      // to_project (B1, 2026-08-22): resolve the PROJECT to a live pane AT SEND
      // TIME via pane-identity — pane ids reset on WezTerm restart and stored
      // ids are the whole "pane-8/pane-24" misroute class. Whatever happens
      // next, the envelope is ALWAYS recorded to the durable per-project queue
      // so a failed delivery is retried by scripts/queue-drain.cjs, never lost.
      const projectQueue = toProject ? require('./project-queue.cjs') : null;
      let resolutionWarning = null;
      if (toProject) {
        const paneIdentity = require('./pane-identity.cjs');
        let mapped = [];
        try {
          mapped = discovery.discoverPanes()
            .filter((p) => p.agent) // agent panes only — the daemon shell shares cwds
            .map((p) => ({ pane_id: p.paneId, cwd: p.project, tab_title: p.tabTitle || p.title || null }));
        } catch { /* discovery down -> unresolved, queue-only below */ }
        const hit = paneIdentity.resolve(toProject, mapped);
        resolutionWarning = hit.warning;
        if (hit.paneId === null || hit.ambiguous.length) {
          // W2: un result encolado ya paso el shape-check; aca queda REGISTRADO
          // y ligado a su tarjeta ANTES de encolar, para que la linea de la cola
          // pueda declarar recorded:true. La entrega puede esperar al drain; el
          // hecho de que el trabajo termino no.
          recordAndLinkResult(null);
          const q = projectQueue.enqueue({
            project: toProject, corr, type: msgType, from_pane: fromPane,
            resolved_pane: null, submitted: null, delivered: null, ok: false, body,
            // W4 handshake: el cuerpo YA quedo en a2a-results.jsonl, asi que
            // deliverPending no vuelve a registrarlo al drenar. Sin la marca el
            // mismo result se cuenta dos veces.
            ...(recordedResult ? { recorded: true } : {}),
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                queued: q.ok,
                to_project: toProject,
                resolved_pane: null,
                corr,
                type: msgType,
                note: `${hit.warning || `no live pane for "${toProject}"`} — NOT delivered now. ${q.ok
                  ? `Durably queued in _intel/queues/: run \`node scripts/queue-drain.cjs\` (cron-able) to retry, or re-send once the pane exists.`
                  : 'Queue append ALSO failed — this message is not persisted anywhere; re-send it.'}${ledgerNote}`,
              }, null, 2),
            }],
            isError: false,
          };
        }
        toPane = hit.paneId;
      }

      // Guard the raw to_pane path (mm-0dc1): an id that no live pane answers to
      // is refused here instead of dead-lettering unread. selfCensus was already
      // gathered above for self-identity, so this costs no extra discovery.
      let targetProject = toProject;
      if (!toProject) {
        const targetRes = selfIdentity.validateTargetPane({ paneId: toPane, panes: selfCensus });
        if (!targetRes.ok) {
          const suggest = targetRes.alternatives
            .map((a) => `${a.project} = pane ${a.paneId}`).join(' · ');
          a2aIntel.recordEvent({ event: 'a2a.unknown_target', from_pane: fromPane, to_pane: toPane, corr, type: msgType });
          return {
            content: [{
              type: 'text',
              text: `unknown-target: BLOCKED a2a_send — ${targetRes.reason}. NEVER address a peer by the pane id it advertises about itself: this machine runs two mux sockets that number the same panes differently. Re-send with to_project (resolved at send time and durably queued). Live: ${suggest}`,
            }],
            isError: true,
          };
        }
        targetProject = targetRes.project;
      }

      // T-0238: a request on a task corr is refused when the CARD is still
      // blocked/gated — the ledger card is the only verifiable authority for a
      // gate; an envelope's claim of authorization is not (mm-6dbc: 3 such
      // envelopes in one night, one of which would have rotated a prod key).
      const gate = a2aIntel.checkDispatchGate({ corr, type: msgType });
      if (!gate.allowed) {
        try {
          require('./action-log.cjs').logAction('dispatch_gate_refused', {
            target: `corr=${corr}`, why: gate.reason.slice(0, 160), extra: { state: gate.state, to_pane: toPane },
          });
        } catch { /* refusal must not depend on the audit write */ }
        // recordEvent spreads evt AFTER its 'a2a.sent' default, so this event
        // key wins — the refusal lands in events.jsonl as its own event type.
        a2aIntel.recordEvent({ event: 'a2a.gate_refused', from_pane: fromPane, to_pane: toPane, corr, type: msgType, reason: gate.reason.slice(0, 200) });
        return { content: [{ type: 'text', text: `dispatch-gate: BLOCKED a2a_send — ${gate.reason}` }], isError: true };
      }

      // M1: a dispatched request TAKES the card's lease for the executor, so
      // running-without-owner (T-0222's 15h orphan) can't happen via a2a_send.
      // Provable conflict refuses; lease plumbing failure fails open with a
      // warning surfaced in the response.
      const leaseRes = a2aIntel.takeDispatchLease({
        corr, type: msgType,
        owner: toProject || (typeof toPane === 'number' ? `pane-${toPane}` : null),
      });
      if (!leaseRes.ok) {
        a2aIntel.recordEvent({ event: 'a2a.lease_refused', from_pane: fromPane, to_pane: toPane, corr, type: msgType, reason: leaseRes.reason.slice(0, 200) });
        return { content: [{ type: 'text', text: `dispatch-lease: BLOCKED a2a_send — ${leaseRes.reason}` }], isError: true };
      }
      if (leaseRes.leased) {
        try {
          require('./action-log.cjs').logAction('dispatch_leased', {
            target: `corr=${corr}`, why: `lease → ${leaseRes.leased.owner} (${leaseRes.leased.minutes}m)`, extra: { to_pane: toPane },
          });
        } catch { /* audit never blocks dispatch */ }
      }

      // Header por NOMBRE DE PROYECTO cuando se lo conoce (fallback a pane-N).
      // El pane-id no es una direccion: vive en dos espacios y el mismo pane es
      // 11 en el del MCP y 15 en el del CLI de wezterm — el 2026-08-29 eso hizo
      // que un receptor reportara dos misruteos que no existian.
      const envelope = a2aIntel.buildEnvelope({
        fromPane, fromProject: selfRes.project, toPane, toProject, corr, type: msgType, body,
      });
      const _safety = safetyPolicy.evaluate({ action: 'send_prompt', paneId: toPane, prompt: envelope });
      if (!_safety.allowed) {
        if (_safety.tripwire) return { content: [{ type: 'text', text: _safety.response }] };
        return { content: [{ type: 'text', text: `safety-policy: BLOCKED a2a_send — ${_safety.reason}. Set WEZBRIDGE_SAFETY_OVERRIDE=1 to bypass.` }], isError: true };
      }

      try {
        const delivered = await sendPromptDeferredEnter(toPane, envelope);
        if (delivered && delivered.refused) {
          // T-0323: composer con texto ajeno => la primitiva no escribio nada.
          // No verificar (reintentaria Enter sobre el texto del operador).
          log(`a2a_send pane-${fromPane} -> pane-${toPane} corr=${corr} REFUSED ${delivered.refused}: held=${JSON.stringify(String(delivered.held).slice(0, 80))}`);
          return { content: [{ type: 'text', text: `REFUSED (${delivered.refused}): pane ${toPane} (${toProject || 'unknown project'}) composer holds UNSENT text ${JSON.stringify(String(delivered.held).slice(0, 120))} — the envelope was NOT typed (corr=${corr}). Retry after the operator submits or clears it; enqueue via the project queue if it must not be lost.` }], isError: true, submitted: 'refused', delivered: 'refused' };
        }
        const submitted = await verifyPromptSubmission(toPane, envelope);
        log(`a2a_send pane-${fromPane} -> pane-${toPane} corr=${corr} type=${msgType} [submit:${submitted} deliver:${delivered}]`);
        const truncated = delivered === 'truncated';
        // Control-plane enforcement (fail-soft, never blocks delivery):
        // v2 shape check on results, audit every envelope, track open threads.
        // Decision ledger (A1, 2026-08-22): surface the optional decisions:
        // block + criteria evidence so the requester sees judgment calls
        // without re-reading the body. Counts only in the response; full items
        // persist in _intel/a2a-results.jsonl via recordResultBody.
        const decisions = msgType === 'result' ? a2aIntel.detectDecisions(body) : undefined;
        const evidence = msgType === 'result' ? a2aIntel.detectEvidence(body) : undefined;
        // T-0235: from_project is the STABLE identity in the event record —
        // pane ids die with every WezTerm restart, project names do not.
        a2aIntel.recordEvent({ from_pane: fromPane, ...(selfRes.project ? { from_project: selfRes.project } : {}), ...(selfRes.source !== 'explicit' ? { from_source: selfRes.source } : {}), to_pane: toPane, ...(toProject ? { to_project: toProject } : {}), corr, type: msgType, submitted, delivered, ...(v2 ? { v2 } : {}) });
        // Result bodies (the criteria: blocks) persist to the sibling
        // a2a-results.jsonl — events.jsonl stays metadata-only. Fail-soft.
        recordAndLinkResult(toPane);
        const unackedInbound = a2aIntel.updateThreads({ fromPane, toPane, corr, type: msgType, body });
        const verified = submitted !== 'stuck' && !truncated;
        // Durable queue record for to_project sends — ALWAYS, whatever the
        // delivery outcome: ok:false lines are the drain script's retry list.
        const queued = toProject
          ? projectQueue.enqueue({
            project: toProject, corr, type: msgType, from_pane: fromPane,
            resolved_pane: toPane, submitted, delivered, ok: verified, body,
            ...(recordedResult ? { recorded: true } : {}),
          })
          : null;
        // Auto-ack (B1): a VERIFIED result delivery proves receipt, so the
        // bookkeeping acuse is automated — no LLM turn to say "got it". Only
        // submitted === 'submitted' qualifies: closing an ack obligation on an
        // 'unknown' delivery would silently drop it. The requester's JUDGEMENT
        // on the result (validate evidence, review→done) stays human.
        // Auto-close SHADOW (B2, frente 3): after a type=result the SENDER pane
        // is the lifecycle candidate ("bots are temporary per project"). This
        // branch NEVER kills — it only logs what WEZBRIDGE_AUTOCLOSE=live WOULD
        // do (that flag is documented in src/lifecycle.cjs and read by nothing;
        // going live is an operator decision). Exclusions: orchestrator pane,
        // active ledger lease, unknown project, unverified delivery.
        if (msgType === 'result') {
          try {
            const lifecycle = require('./lifecycle.cjs');
            const identity = require('./pane-identity.cjs');
            let senderProject = null;
            try {
              const senderPane = discovery.discoverPanes().find((p) => p.paneId === fromPane);
              senderProject = senderPane ? identity.projectFromCwd(senderPane.project) : null;
            } catch { /* discovery down → project unknown → fail-safe no-close */ }
            const lease = lifecycle.findActiveLease({ owner: `pane-${fromPane}` });
            const shadow = lifecycle.decideAutoClose({
              paneId: fromPane,
              project: senderProject,
              orchRepo: process.env.WEZBRIDGE_ORCH_REPO || 'wezbridge',
              lease,
              verified,
            });
            require('./action-log.cjs').logAction('auto_close_shadow', {
              target: `pane-${fromPane}`,
              why: shadow.close ? shadow.reason : `EXCLUDED: ${shadow.reason}`,
              corr,
              ...(senderProject ? { project: senderProject } : {}),
              extra: { would_close: shadow.close, verified },
            });
          } catch { /* shadow observability must never affect delivery */ }
        }
        let autoAcked = false;
        if (msgType === 'result' && submitted === 'submitted' && !truncated) {
          autoAcked = a2aIntel.autoAckResult({ corr, byPane: fromPane });
          if (autoAcked) {
            require('./action-log.cjs').logAction('auto_ack', {
              target: `corr=${corr}`,
              why: 'verified type=result delivery — bookkeeping acuse automated (B1); judgement ack stays with the requester',
            });
            // unackedInbound was computed BEFORE the auto-ack; on a self-send
            // the just-closed corr would otherwise be nagged about right after
            // being declared auto-acked in the same note.
            const idx = unackedInbound.indexOf(corr);
            if (idx !== -1) unackedInbound.splice(idx, 1);
          }
        }
        let note = truncated
          ? 'DELIVERY INTEGRITY FAILURE: the recipient composer did not hold the tail of your envelope before submit — it was likely truncated. Do NOT assume it arrived. Re-send shorter, or write the value to a repo file and send only a pointer.'
          : submitted === 'stuck'
            ? 'Envelope typed but STUCK in the input box after retries — send send_key("enter") to the pane.'
            : `Envelope delivered. Reuse corr=${corr} for the rest of this thread; the responder should reply with type=ack/progress/result.`;
        if (v2 === 'missing') {
          note += ' PROTOCOL WARNING: this type=result body has no v2 criteria block (criteria: <criterion>: pass|fail — evidence). Machine-checkable results are the fleet contract; include one next time.';
        } else if (v2 === 'partial') {
          note += ' PROTOCOL WARNING: this type=result body has a criteria block but no per-criterion pass|fail verdicts (criteria: <criterion>: pass|fail — evidence). A criteria list without verdicts cannot be validated; add them next time.';
        }
        if (decisions && decisions.count > 0) {
          note += ` Decision ledger: ${decisions.count} decision(s) recorded to a2a-results.jsonl.`;
        }
        // The most repeated failure of 2026-08-24/25, five instances across
        // three panes: "it finished without error" accepted as "it did the
        // thing". Name the passes that cite nothing checkable — never block,
        // because punishing honest phrasing on a heuristic is worse than the
        // gap it guards.
        if (msgType === 'result') {
          const weak = a2aIntel.weakPasses(body);
          if (weak.length > 0) {
            note += ` UNVERIFIABLE PASSES (${weak.length}): ${weak.join(', ')} — these say pass but cite no artifact. A green check counts only if you can NAME what it produced: the file, the row, the SHA, the count, the test that ran. If "finished without error" is the only evidence, nothing was verified.`;
          }
        }
        if (ledgerNote) note += ledgerNote;
        if (autoAcked) {
          note += ' Auto-ack: delivery verified, so the receipt bookkeeping is done (thread closed in a2a-threads.json) — the requester needs NO ack turn, only its own validation of the result.';
        }
        if (queued && !verified) {
          note += queued.ok
            ? ' Delivery NOT verified — the envelope is durably queued in _intel/queues/ and will be retried by scripts/queue-drain.cjs.'
            : ' Delivery NOT verified AND the durable queue append failed — re-send this message.';
        }
        if (toProject && resolutionWarning) {
          note += ` Resolution note: ${resolutionWarning}.`;
        }
        if (unackedInbound.length > 0) {
          note += ` OUTSTANDING: results sent TO YOU still await your ack — corr(s): ${unackedInbound.join(', ')}. Ack them now (type=ack) or the sender may re-send in a loop.`;
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: verified,
              submitted,
              delivered, // 'ok' | 'truncated' | 'unknown' — real integrity, not just box-cleared
              corr,
              from_pane: fromPane,
              // T-0235: stable identity travels in the ACCOUNTING, not the
              // header — pane ids are transport addresses that die with every
              // WezTerm restart; the project name is who you are.
              ...(selfRes.project ? { from_project: selfRes.project } : {}),
              ...(selfRes.source !== 'explicit' ? { from_source: selfRes.source } : {}),
              ...(selfRes.source === 'env-corrected' ? { from_identity_note: selfRes.warning } : {}),
              to_pane: toPane,
              ...(toProject ? { to_project: toProject, queued: queued ? queued.ok : false } : {}),
              // Raw to_pane: name WHO that id actually is, so a send that lands
              // on the wrong live session is visible instead of plausible.
              ...(!toProject && targetProject ? { to_project_resolved: targetProject } : {}),
              ...(autoAcked ? { auto_acked: true } : {}),
              type: msgType,
              ...(v2 ? { v2 } : {}),
              ...(decisions ? { decisions: decisions.count } : {}),
              ...(evidence ? { evidence: evidence.count } : {}),
              ...(unackedInbound.length > 0 ? { unacked_inbound: unackedInbound } : {}),
              note,
            }, null, 2),
          }],
          isError: false,
        };
      } catch (err) {
        // T-0233: a transport exception must not vanish the envelope. Before
        // this, only the to_project happy path enqueued — a to_pane ETIMEDOUT
        // left ZERO durable record (mm-455f: results survived that night only
        // because senders retried by hand). Rescue to the destination's queue
        // (resolved from census) or the visible _dead-letter queue.
        let rescueNote = '';
        try {
          const rescue = require('./project-queue.cjs').rescueFailedSend({
            toProject, toPane, census: selfCensus, corr, type: msgType, fromPane, body,
          });
          rescueNote = rescue.queued
            ? ` Envelope RESCUED to _intel/queues/${rescue.project}.jsonl (id ${rescue.id}) — scripts/queue-drain.cjs will retry; do not hand-retry unless urgent (the queue dedupes by corr+type+body).`
            : ` RESCUE ALSO FAILED (${rescue.error}) — this envelope is not persisted anywhere; re-send it.`;
        } catch (rescueErr) {
          rescueNote = ` RESCUE ALSO FAILED (${String(rescueErr && rescueErr.message).slice(0, 120)}) — this envelope is not persisted anywhere; re-send it.`;
        }
        return { content: [{ type: 'text', text: `Error sending A2A envelope to pane ${toPane}: ${err.message}.${rescueNote}` }], isError: true };
      }
    })();

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ─── bridge_health ────────────────────────────────────────────────────────

/**
 * Probe wezterm reachability, the :4200 daemon, the snapshot watcher, and pane
 * count. Returns a single JSON blob so a session can self-diagnose without
 * chaining several tool calls. Never throws — every probe degrades to a
 * reported error string.
 */
function probeWezterm() {
  try {
    const panes = wez.listPanes();
    let version = null;
    try {
      version = require('child_process')
        .execFileSync(wez.WEZTERM, ['--version'], { encoding: 'utf-8', timeout: 4000, windowsHide: true })
        .trim();
    } catch { /* version optional */ }
    return { reachable: true, pane_count: Array.isArray(panes) ? panes.length : 0, version };
  } catch (err) {
    // The fast path timing out is NOT evidence of a wedged mux, and the
    // difference matters more than almost anything else this tool reports:
    // the known fix for a wedge is restarting WezTerm, which kills every live
    // pane. Reporting an unqualified `reachable: false` on a busy box invites
    // an orchestrator to destroy a working swarm to cure a traffic jam
    // (observed 2026-08-18: health said unreachable, a direct call 30s later
    // answered in 191ms while three panes were mid-task).
    //
    // A contended mux answers late; a wedged one never answers. So spend one
    // long deliberate probe and report which it actually was.
    const timedOut = /ETIMEDOUT/i.test(err.message || '');
    // 45s, not 25s: a 25s budget expired on a memory-starved box whose mux was
    // merely slow (2026-08-18 — a leaked tsserver.js held 25GB), which would
    // have produced the exact false alarm this path exists to prevent. This
    // probe runs only after the normal one already failed, so it is rare and
    // can afford to be patient.
    const confirm = timedOut ? wez.probeMux({ timeoutMs: 45000 }) : null;
    return wez.classifyMuxProbe({ fastError: err.message, confirm });
  }
}

/**
 * Ask the daemon which background services it actually armed. Returns null when
 * the daemon is down or too old to expose /api/health — the caller must render
 * "unknown", never a default that looks like an answer.
 */
// Extracted to src/daemon-probe.cjs (T-0190) so tests can exercise the probes
// without starting this stdio server. Liveness is decided by /api/health there.
const { probeDaemon, probeDaemonServices } = require('./daemon-probe.cjs');

async function handleBridgeHealth() {
  let pkgVersion = 'unknown';
  try { pkgVersion = require('../package.json').version; } catch { /* ignore */ }
  // Arming is MEASURED at the daemon, never inferred here: this process has a
  // different environment from the daemon's, so reading process.env would
  // report a wish. `null` services => genuinely unknown, and it says so.
  const [daemon, services] = await Promise.all([probeDaemon(), probeDaemonServices()]);
  const wezterm = probeWezterm();
  const snap = services && services.session_snapshot;
  const health = {
    wezbridge_version: pkgVersion,
    wezterm,
    daemon,
    services: services || 'unknown (daemon down, or predates /api/health)',
    session_snapshot_armed: snap ? snap.armed : 'unknown',
    ok: wezterm.reachable, // wezterm is the only hard dependency for core MCP tools
  };
  // Two mux sockets serving the same panes under different ids is invisible
  // until envelopes start dying (mm-0dc1: 10 dead letters addressed to a pane
  // that was nobody in the sending server's space). It is a top-level verdict
  // because every A2A id in the fleet is wrong while it holds.
  try {
    const divergence = wez.detectSocketDivergence();
    if (divergence && divergence.diverged) {
      health.pane_id_spaces = {
        diverged: true,
        shared: divergence.shared,
        collisions: divergence.collisions,
        note: 'Two WezTerm mux sockets number the SAME panes differently. Any pane id a session reports about itself is wrong in the space that must deliver to it — address peers with to_project only. `collisions` are ids that are a DIFFERENT live pane in each space: those misdeliver instead of failing.',
      };
      health.ok = false;
    }
  } catch { /* detection is diagnostic; never let it fail the health probe */ }

  // The orchestrator loop is the thing whose silent death is expensive, so it
  // gets a top-level verdict rather than being buried in the services blob.
  const waker = services && services.orchestrator_waker;
  if (waker) {
    if (waker.armed) {
      health.orchestrator_waker = {
        armed: true, repos: waker.repos, pending: waker.pending,
        last_poke_at: waker.lastPokeAt, cursor_lag_bytes: waker.cursorLagBytes,
      };
    } else if (waker.deliberate) {
      // Reported in full, not summarised: the decision record carries the
      // re-arm condition, and truncating it is how someone ends up "fixing"
      // this by turning the waker back on.
      health.orchestrator_waker = {
        armed: false,
        disarmed_by_decision: true,
        decided_at: waker.decidedAt || null,
        reason: waker.reason,
        decision: waker.decision || null,
        note: 'NOT a fault and NOT an alert. Pane completions do not reach the orchestrator by design; an interactive orchestrator must arm its own continuation. Do not re-arm without meeting the condition in the record above.',
      };
    } else {
      health.orchestrator_waker = { armed: false, reason: waker.reason };
    }
  }

  // Liveness verdict in SENTENCES. Two reasons this is not just numbers:
  // (1) the heartbeat file outlives the daemon, so this still says something
  //     useful when the daemon is dead — which is exactly when it matters;
  // (2) a number nobody interprets is not observability. Anything wrong here
  //     is stated in plain words, so no reader has to know what a good value
  //     of cursor_lag_bytes looks like.
  try {
    const ds = require('./daemon-status.cjs');
    const intelDir = process.env.WEZBRIDGE_INTEL_DIR
      || require('node:path').join(__dirname, '..', '..', '_intel');
    const fileBeat = ds.readHeartbeat(require('node:path').join(intelDir, '.daemon-heartbeat.json'));
    const reachable = !!(daemon && daemon.up);
    // Prefer what the daemon just told us over the file it last flushed; fall
    // back to the file, which is the only witness once the daemon is gone.
    const beat = (reachable && services)
      ? { ts: new Date().toISOString(), services }
      : fileBeat;
    const verdict = ds.assessLiveness({ heartbeat: beat, daemonReachable: reachable });
    health.alerts = verdict.alerts;
    health.ok = wezterm.reachable && verdict.alerts.length === 0;
  } catch (err) {
    health.alerts = [`liveness assessment failed: ${err.message}`];
  }
  return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
}

// ─── MCP Protocol Handler ─────────────────────────────────────────────────

const SERVER_INFO = {
  name: 'wezbridge',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {},  // We support tools
};

function handleMessage(msg) {
  const { method, id, params } = msg;

  switch (method) {
    // Handshake
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    // Post-handshake notification (no response needed)
    case 'notifications/initialized':
      log('Client initialized');
      return null;

    // Tool discovery
    case 'tools/list':
      return jsonRpcResponse(id, { tools: TOOLS });

    // Tool execution
    case 'tools/call': {
      const { name, arguments: toolArgs } = params || {};
      log(`Tool call: ${name}`);
      try {
        const result = handleToolCall(name, toolArgs || {});
        // Support async tool handlers (e.g. auto_handoff) — write response when resolved
        if (result && typeof result.then === 'function') {
          const tracked = result.then(
            (resolved) => process.stdout.write(jsonRpcResponse(id, resolved) + '\n'),
            (err) => {
              log(`Tool async error: ${err.message}`);
              process.stdout.write(jsonRpcResponse(id, {
                content: [{ type: 'text', text: `Internal error: ${err.message}` }],
                isError: true,
              }) + '\n');
            }
          ).finally(() => pendingAsyncCalls.delete(tracked));
          // Track so a stdin close drains in-flight responses before exit —
          // otherwise an async tool's reply is silently dropped.
          pendingAsyncCalls.add(tracked);
          return null; // signal: response will be written async
        }
        return jsonRpcResponse(id, result);
      } catch (err) {
        log(`Tool error: ${err.message}`);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Internal error: ${err.message}` }],
          isError: true,
        });
      }
    }

    // Ping
    case 'ping':
      return jsonRpcResponse(id, {});

    // Unknown method
    default:
      if (id !== undefined) {
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
      }
      // Notifications without id don't get responses
      return null;
  }
}

// ─── stdio Transport ──────────────────────────────────────────────────────

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // MCP uses newline-delimited JSON (one JSON-RPC message per line)
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    try {
      const msg = JSON.parse(line);
      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(response + '\n');
      }
    } catch (err) {
      log(`Parse error: ${err.message} — line: ${line.slice(0, 200)}`);
      // Send parse error back
      process.stdout.write(jsonRpcError(null, -32700, 'Parse error') + '\n');
    }
  }
});

process.stdin.on('end', () => {
  // Drain in-flight async tool calls before exiting — clients often write one
  // request and immediately close stdin; exiting here would drop the reply.
  if (pendingAsyncCalls.size > 0) {
    log(`stdin closed, draining ${pendingAsyncCalls.size} in-flight call(s) before shutdown`);
    const drain = Promise.allSettled([...pendingAsyncCalls]);
    const cap = new Promise((resolve) => setTimeout(resolve, 30000));
    Promise.race([drain, cap]).then(() => {
      log('drained, shutting down');
      process.exit(0);
    });
    return;
  }
  log('stdin closed, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log('WezBridge MCP server started (stdio)');
