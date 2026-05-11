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
      },
    },
  },
  {
    name: 'read_output',
    description: 'Read the terminal output from a specific WezTerm pane. Returns the last N lines of scrollback. Use this to see what a Claude session has been doing or what it responded with.',
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
      },
      required: ['pane_id'],
    },
  },
  {
    name: 'send_prompt',
    description: 'Send a text prompt to a Claude Code session running in a WezTerm pane. The text is typed into the terminal and Enter is pressed. Use this to give instructions to other Claude sessions. IMPORTANT: Only send to sessions that are in "idle" status, not "working".',
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
          description: 'Maximum seconds to wait before giving up. Default: 120. Max: 600.',
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
    description: 'Launch a new Claude Code session in a new WezTerm pane. Optionally provide a project directory and an initial prompt. Returns the new pane ID.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Working directory for the new session (project path). Default: current directory.',
        },
        prompt: {
          type: 'string',
          description: 'Optional initial prompt to send after Claude starts up. The session will start, wait for the ❯ prompt, then send this text.',
        },
        resume: {
          type: 'string',
          description: 'Resume a specific named session instead of --continue. Pass the session name (e.g. "fork-webdesign").',
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
];

// ─── Tool Implementations ─────────────────────────────────────────────────

function handleToolCall(name, args) {
  switch (name) {
    case 'discover_sessions': {
      const onlyClaude = args.only_claude !== false; // default true
      const panes = discovery.discoverPanes();
      const filtered = onlyClaude ? panes.filter(p => p.isClaude) : panes;

      // Don't send huge lastLines in the listing
      const summary = filtered.map(p => ({
        pane_id: p.paneId,
        is_claude: p.isClaude,
        status: p.status,
        project: p.project,
        project_name: p.projectName,
        title: p.title,
        workspace: p.workspace,
        confidence: p.confidence,
        last_line: p.lastLines.split('\n').filter(l => l.trim()).slice(-3).join('\n'),
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

      try {
        wez.sendText(paneId, text);
        // Triple-redundant enter submission — see spawn_session for the
        // full rationale. Sync retry covers short-prompt \r-swallowing;
        // async 250ms retry covers back-to-back \r being coalesced.
        // Both are harmless no-ops on successful submit (Claude TUI
        // ignores bare enter on empty input).
        try { wez.sendTextNoEnter(paneId, '\r'); } catch { /* ignore */ }
        setTimeout(() => {
          try { wez.sendText(paneId, ''); } catch { /* ignore */ }
        }, 250);
        log(`Sent prompt to pane ${paneId}: ${text.slice(0, 80)}...`);
        return {
          content: [{ type: 'text', text: `Prompt sent to pane ${paneId}. The session will now process it. Use read_output or get_status later to check the result.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error sending to pane ${paneId}: ${err.message}` }],
          isError: true,
        };
      }
    }

    case 'get_status': {
      const paneId = args.pane_id;

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
              project: pane.project,
              project_name: pane.projectName,
              title: pane.title,
              workspace: pane.workspace,
              confidence: pane.confidence,
              last_lines: pane.lastLines.split('\n').filter(l => l.trim()).slice(-10).join('\n'),
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

    case 'wait_for_idle': {
      const paneId = args.pane_id;
      const maxWait = Math.min(args.max_wait || 120, 600);
      const pollInterval = Math.max(args.poll_interval || 3, 1);

      const startTime = Date.now();
      const deadline = startTime + maxWait * 1000;

      // Helper: blocking sleep via wezterm (no async in this codebase)
      function sleepSync(ms) {
        try {
          require('child_process').execFileSync(
            process.platform === 'win32' ? 'timeout' : 'sleep',
            process.platform === 'win32' ? ['/t', String(Math.ceil(ms / 1000)), '/nobreak'] : [String(ms / 1000)],
            { windowsHide: true, stdio: 'ignore', timeout: ms + 2000 }
          );
        } catch { /* ignore */ }
      }

      let lastText = '';
      let timedOut = true;

      while (Date.now() < deadline) {
        try {
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

        sleepSync(pollInterval * 1000);
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
    }

    case 'spawn_session': {
      const cwd = args.cwd || process.cwd();
      // F-SEC-2b: --dangerously-skip-permissions is only honored when the operator
      // has explicitly opted in via env. Any caller request for it is ignored otherwise.
      const skipPerms =
        (args.dangerously_skip_permissions || false) &&
        process.env.WEZBRIDGE_ALLOW_SKIP_PERMISSIONS === 'true';

      // Resolve persona if provided
      let personaPath = null;
      if (args.persona) {
        personaPath = resolvePersona(args.persona);
        if (!personaPath) {
          return {
            content: [{ type: 'text', text: `persona "${args.persona}" not found in ~/.claude/agents/` }],
            isError: true,
          };
        }
      }

      try {
        // Spawn a plain shell pane, then send the claude command as text.
        // This works on all platforms (Windows cmd, bash, pwsh) without
        // needing to know the user's shell in advance.
        let newPaneId;
        if (args.split_from !== undefined) {
          newPaneId = wez.splitHorizontal(args.split_from, { cwd });
        } else {
          newPaneId = wez.spawnPane({ cwd });
        }

        // Give the shell a moment to initialize
        try {
          require('child_process').execFileSync(
            process.platform === 'win32' ? 'timeout' : 'sleep',
            process.platform === 'win32' ? ['/t', '2', '/nobreak'] : ['2'],
            { windowsHide: true, stdio: 'ignore', timeout: 4000 }
          );
        } catch { /* ignore */ }

        // Type the claude command into the shell
        // When a persona is set → fresh session (no --continue / --resume).
        // A persona agent is a NEW entity, not a continuation of whatever
        // session previously ran in that directory. Without this, --continue
        // resumes the most recent session for that cwd and the persona prompt
        // gets injected into an existing conversation (wrong behavior).
        let claudeCmd = 'claude';
        if (personaPath) {
          // Fresh start with persona — no --continue, no --resume
          claudeCmd += ' --append-system-prompt-file "' + personaPath.replace(/\\/g, '/') + '"';
        } else if (args.resume) {
          claudeCmd += ' -r ' + (args.resume || '').replace(/"/g, '');
        } else {
          claudeCmd += ' --continue';
        }
        if (skipPerms) claudeCmd += ' --dangerously-skip-permissions';
        if (args.permission_mode) claudeCmd += ' --permission-mode ' + args.permission_mode;
        wez.sendText(newPaneId, claudeCmd);

        // Set tab title to persona name for discoverPanes() detection
        if (args.persona) {
          try { wez.setTabTitle(newPaneId, '[' + args.persona + ']'); } catch { /* ignore */ }
        }

        log(`Spawned Claude session in pane ${newPaneId} at ${cwd}${args.persona ? ' [persona=' + args.persona + ']' : ''}`);

        // If an initial prompt was given, wait for the session to boot then send it
        if (args.prompt) {
          // Give Claude a few seconds to start up and show ❯
          const bootWait = 8;
          for (let i = 0; i < bootWait; i++) {
            try {
              require('child_process').execFileSync(
                process.platform === 'win32' ? 'timeout' : 'sleep',
                process.platform === 'win32' ? ['/t', '1', '/nobreak'] : ['1'],
                { windowsHide: true, stdio: 'ignore', timeout: 3000 }
              );
            } catch { /* ignore */ }

            try {
              const text = wez.getFullText(newPaneId, 20);
              if (/[❯>]\s*$/m.test(text)) break;
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
          // Triple-redundant enter submission because wezterm's
          // `cli send-text --no-paste` is unreliable about the trailing
          // \r in various ways:
          //   (a) Long prompts: \r gets swallowed (pane-33, elduderino).
          //   (b) Short prompts: \r gets swallowed (pane-35 E2E, 114 chars).
          //   (c) Immediate back-to-back \r retries ALSO get swallowed
          //       (pane-36 E2E — the length-gated retry fired but prompt
          //       still sat unsent; only a fresh RPC `send_key('enter')`
          //       minutes later unstuck it).
          // Solution: fire one sync retry for cases (a)/(b), plus a
          // SECOND async retry after 250ms for case (c), giving wezterm
          // time to flush. The async retry uses wez.sendText(paneId, '')
          // which is the same internal path as send_key('enter') (empty
          // text + appended \r) — proven to work when separated in time.
          // Extra enters on empty input are harmless no-ops in Claude's TUI.
          try { wez.sendTextNoEnter(newPaneId, '\r'); } catch { /* ignore */ }
          setTimeout(() => {
            try { wez.sendText(newPaneId, ''); } catch { /* ignore */ }
          }, 250);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              pane_id: newPaneId,
              cwd,
              persona: args.persona || null,
              permission_mode: args.permission_mode || null,
              spawned_by_pane_id: typeof args.spawned_by_pane_id === 'number' ? args.spawned_by_pane_id : null,
              initial_prompt: args.prompt || null,
              message: `Claude session spawned in pane ${newPaneId}.${args.persona ? ' Persona: ' + args.persona + '.' : ''} ${args.prompt ? 'Initial prompt sent.' : 'Ready for prompts.'}${typeof args.spawned_by_pane_id === 'number' ? ' Peer-pane bootstrap injected (coordinator=pane-' + args.spawned_by_pane_id + ').' : ''}`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error spawning session: ${err.message}` }],
          isError: true,
        };
      }
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
        if (args.cwd) opts.cwd = args.cwd;
        if (args.program) opts.program = args.program;
        if (args.args) opts.args = args.args;
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
        if (args.cwd) opts.cwd = args.cwd;
        if (args.program) opts.program = args.program;
        if (args.args) opts.args = args.args;
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
        wez.switchWorkspace(String(args.name));
        return { content: [{ type: 'text', text: `Switched to workspace "${args.name}".` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error switching workspace: ${err.message}` }], isError: true };
      }
    }

    case 'spawn_in_workspace': {
      try {
        const opts = {};
        if (args.cwd) opts.cwd = args.cwd;
        if (args.program) opts.program = args.program;
        if (args.args) opts.args = args.args;
        const newId = wez.spawnInWorkspace(String(args.workspace), opts);
        return {
          content: [{ type: 'text', text: JSON.stringify({ pane_id: newId, workspace: args.workspace }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error spawning in workspace "${args.workspace}": ${err.message}` }], isError: true };
      }
    }

    case 'auto_handoff': {
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
            content: [{ type: 'text', text: `Error contacting dashboard at localhost:${dashPort}: ${err.message}` }],
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

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
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
          result.then(
            (resolved) => process.stdout.write(jsonRpcResponse(id, resolved) + '\n'),
            (err) => {
              log(`Tool async error: ${err.message}`);
              process.stdout.write(jsonRpcResponse(id, {
                content: [{ type: 'text', text: `Internal error: ${err.message}` }],
                isError: true,
              }) + '\n');
            }
          );
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
  log('stdin closed, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log('WezBridge MCP server started (stdio)');
