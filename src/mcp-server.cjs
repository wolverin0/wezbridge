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
// wezterm's `cli send-text --no-paste` intermittently swallows the trailing
// \r, leaving the prompt sitting unsubmitted in the TUI input box. The old
// approach fired blind redundant enters and reported success regardless.
// This reads the pane back: the BOTTOM-MOST prompt-marker line (❯ / > / ›,
// optionally behind a box-drawing border) is the live input box — if our text
// is still sitting there, nudge enter and re-check (bounded retries).
// Returns 'submitted' | 'stuck' | 'unknown' (pane unreadable / non-TUI shell).
function inputBoxContent(tailLines) {
  const markers = tailLines.filter((l) => /^[\s│|]*[❯>›]/.test(l));
  const last = markers[markers.length - 1] || '';
  return last.replace(/^[\s│|]*[❯>›]\s*/, '').replace(/[\s│|]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ─── read_output delta cursors ────────────────────────────────────────────
// A cursor is a base64 fingerprint of the last lines of a read. On the next
// read, everything after the fingerprint match is "new". Cheap polling for
// A2A requesters (esp. Codex, which must poll) without re-reading 100 lines.
function trimTrailingEmpty(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end);
}

function makeReadCursor(lines) {
  const trimmed = trimTrailingEmpty(lines);
  // Drop the very last line: it's the LIVE prompt/input line and mutates in
  // place ("$" becomes "$ echo next-cmd"), which both breaks matching and —
  // worse — bare prompt lines repeat, so a fingerprint ending on one can
  // match the NEWEST occurrence and swallow the whole delta. Three lines of
  // context above the live line (command + output) are effectively unique.
  const body = trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
  const fp = body.slice(-3);
  return Buffer.from(JSON.stringify(fp), 'utf-8').toString('base64');
}

// Returns lines after the cursor match, or null if the cursor no longer
// matches (scrolled out of the window / invalid) — caller falls back to full.
function sliceAfterCursor(lines, cursorB64) {
  let fp;
  try { fp = JSON.parse(Buffer.from(String(cursorB64), 'base64').toString('utf-8')); } catch { return null; }
  if (!Array.isArray(fp) || fp.length === 0 || !fp.every((l) => typeof l === 'string')) return null;
  const trimmed = trimTrailingEmpty(lines);
  for (let i = trimmed.length - fp.length; i >= 0; i--) {
    let match = true;
    for (let j = 0; j < fp.length; j++) {
      if (trimmed[i + j] !== fp[j]) { match = false; break; }
    }
    if (match) return trimmed.slice(i + fp.length);
  }
  return null;
}

async function verifyPromptSubmission(paneId, text, { retries = 2, settleMs = 700 } = {}) {
  const probe = String(text).replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
  if (!probe) return 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    await sleep(attempt === 0 ? settleMs : 900);
    let tailLines;
    try {
      wez.invalidateGetTextCache(paneId);
      tailLines = wez.getFullText(paneId, 25).split('\n');
    } catch {
      return 'unknown';
    }
    const content = inputBoxContent(tailLines);
    const stuck = content.length > 0 &&
      (probe.startsWith(content.slice(0, 40)) || content.startsWith(probe.slice(0, 40)));
    if (!stuck) return 'submitted';
    // Text still in the input box — a fresh, time-separated enter (empty
    // send-text + appended \r, same path as send_key('enter')) unsticks it.
    try { wez.sendText(paneId, ''); } catch { /* ignore */ }
  }
  return 'stuck';
}

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
          description: 'If true, only return panes detected as Claude Code sessions. Default: true.',
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
    name: 'a2a_send',
    description: 'Send an A2A protocol envelope to a peer pane in ONE call: builds "[A2A from pane-N to pane-M | corr=<id> | type=<t>]\\n<body>", sends it with VERIFIED submission (no follow-up send_key needed), and returns {submitted, corr}. from_pane defaults to this session\'s own pane (WEZTERM_PANE env). Use this instead of hand-formatting envelopes with send_prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        to_pane: { type: 'number', description: 'Target pane ID.' },
        body: { type: 'string', description: 'Envelope body (the actual message).' },
        type: { type: 'string', enum: ['request', 'ack', 'progress', 'result', 'error'], description: 'A2A message type. Default: request.' },
        corr: { type: 'string', description: 'Correlation id — keep it stable across a thread. Default: generated (returned in the response; reuse it for follow-ups).' },
        from_pane: { type: 'number', description: 'Sender pane ID. Default: WEZTERM_PANE env (your own pane).' },
      },
      required: ['to_pane', 'body'],
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
        is_claude: p.isClaude,
        status: p.status,
        project: verbose ? p.project : redactHomePath(p.project),
        project_name: p.projectName,
        title: p.title,
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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            total: filtered.length,
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

      return (async () => {
        try {
          wez.sendText(paneId, text);
          try { wez.sendTextNoEnter(paneId, '\r'); } catch { /* ignore */ }
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
              status: pane.status,
              project: verbose ? pane.project : redactHomePath(pane.project),
              project_name: pane.projectName,
              title: pane.title,
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
      const agent = args.agent === undefined || args.agent === null ? 'claude' : String(args.agent);
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
        let newPaneId;
        if (args.split_from !== undefined) {
          newPaneId = wez.splitHorizontal(args.split_from, { cwd });
        } else {
          newPaneId = wez.spawnPane({ cwd });
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
          if (args.model) claudeArgv.push('--model', String(args.model));
          cliCmd = claudeArgv.map(shellQuoteArg).join(' ');
        } else if (agent === 'codex') {
          const codexArgv = ['codex'];
          if (args.model) codexArgv.push('--model', String(args.model));
          cliCmd = codexArgv.map(shellQuoteArg).join(' ');
        }
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

          wez.sendText(newPaneId, finalPrompt);
          try { wez.sendTextNoEnter(newPaneId, '\r'); } catch { /* ignore */ }
          // Verified submission (claim-8945 fix) — read the input box back
          // and retry enter until the prompt actually leaves it.
          promptSubmitted = await verifyPromptSubmission(newPaneId, finalPrompt);
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
              model: args.model || null,
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
        wez.killPane(paneId);

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

    case 'a2a_send': return (async () => {
      const toPane = args.to_pane;
      const body = args.body;
      if (typeof toPane !== 'number' || !Number.isInteger(toPane)) {
        return { content: [{ type: 'text', text: 'Error: to_pane must be an integer pane id' }], isError: true };
      }
      if (!body || !String(body).trim()) {
        return { content: [{ type: 'text', text: 'Error: empty body' }], isError: true };
      }
      const bodyLimitError = validateByteLength('prompt', body, INPUT_BYTE_LIMITS.prompt);
      if (bodyLimitError) return bodyLimitError;
      const msgType = args.type === undefined || args.type === null ? 'request' : String(args.type);
      if (!['request', 'ack', 'progress', 'result', 'error'].includes(msgType)) {
        return { content: [{ type: 'text', text: `Error: invalid type "${msgType}" (request|ack|progress|result|error)` }], isError: true };
      }
      const fromPane = typeof args.from_pane === 'number'
        ? args.from_pane
        : parseInt(process.env.WEZTERM_PANE || '', 10);
      if (!Number.isInteger(fromPane)) {
        return { content: [{ type: 'text', text: 'Error: from_pane not given and WEZTERM_PANE env not set — pass from_pane explicitly' }], isError: true };
      }
      const corr = args.corr === undefined || args.corr === null
        ? `a2a-${Date.now().toString(36)}`
        : String(args.corr);
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(corr)) {
        return { content: [{ type: 'text', text: 'Error: corr must be 1-64 chars of [a-zA-Z0-9._-]' }], isError: true };
      }

      const envelope = `[A2A from pane-${fromPane} to pane-${toPane} | corr=${corr} | type=${msgType}]\n${body}`;
      const _safety = safetyPolicy.evaluate({ action: 'send_prompt', paneId: toPane, prompt: envelope });
      if (!_safety.allowed) {
        if (_safety.tripwire) return { content: [{ type: 'text', text: _safety.response }] };
        return { content: [{ type: 'text', text: `safety-policy: BLOCKED a2a_send — ${_safety.reason}. Set WEZBRIDGE_SAFETY_OVERRIDE=1 to bypass.` }], isError: true };
      }

      try {
        wez.sendText(toPane, envelope);
        try { wez.sendTextNoEnter(toPane, '\r'); } catch { /* ignore */ }
        const submitted = await verifyPromptSubmission(toPane, envelope);
        log(`a2a_send pane-${fromPane} -> pane-${toPane} corr=${corr} type=${msgType} [${submitted}]`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: submitted !== 'stuck',
              submitted,
              corr,
              from_pane: fromPane,
              to_pane: toPane,
              type: msgType,
              note: submitted === 'stuck'
                ? 'Envelope typed but STUCK in the input box after retries — send send_key("enter") to the pane.'
                : `Envelope delivered. Reuse corr=${corr} for the rest of this thread; the responder should reply with type=ack/progress/result.`,
            }, null, 2),
          }],
          isError: false,
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error sending A2A envelope to pane ${toPane}: ${err.message}` }], isError: true };
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
    return { reachable: false, error: err.message };
  }
}

function probeDaemon() {
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request(
      { host: '127.0.0.1', port: dashPort, method: 'GET', path: '/api/panes' },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ up: res.statusCode < 500, port: dashPort, status: res.statusCode }));
      }
    );
    req.on('error', () => resolve({ up: false, port: dashPort, hint: 'daemon down — run `npm run dashboard` in the wezbridge repo' }));
    req.setTimeout(2500, () => { req.destroy(); resolve({ up: false, port: dashPort, hint: 'daemon did not respond within 2.5s' }); });
    req.end();
  });
}

async function handleBridgeHealth() {
  let pkgVersion = 'unknown';
  try { pkgVersion = require('../package.json').version; } catch { /* ignore */ }
  const snapshotArmed = process.env.WEZBRIDGE_SESSION_SNAPSHOT !== '0'; // default ON since v3.4.1
  const [daemon] = await Promise.all([probeDaemon()]);
  const wezterm = probeWezterm();
  const health = {
    wezbridge_version: pkgVersion,
    wezterm,
    daemon,
    session_snapshot_armed: snapshotArmed,
    ok: wezterm.reachable, // wezterm is the only hard dependency for core MCP tools
  };
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
