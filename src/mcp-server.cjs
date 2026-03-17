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

const discovery = require('./pane-discovery.cjs');
const wez = require('./wezterm.cjs');

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

      if (!text || !text.trim()) {
        return {
          content: [{ type: 'text', text: 'Error: empty prompt text' }],
          isError: true,
        };
      }

      try {
        wez.sendText(paneId, text);
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

          // Check if idle: last non-empty line ends with ❯ or >
          const lastLine = lines[lines.length - 1] || '';
          if (/[❯>]\s*$/.test(lastLine)) {
            timedOut = false;
            break;
          }

          // Also check permission prompts — those also need attention
          if (/\(y\/n\)|\(Y\/n\)|Allow .+\? \[y\/N\]/i.test(lastLine)) {
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
      const skipPerms = args.dangerously_skip_permissions || false;

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
        let claudeCmd = 'claude';
        if (args.resume) {
          claudeCmd += ' --resume "' + (args.resume || '').replace(/"/g, '\\"') + '"';
        } else {
          claudeCmd += ' --continue';
        }
        if (skipPerms) claudeCmd += ' --dangerously-skip-permissions';
        wez.sendText(newPaneId, claudeCmd);

        log(`Spawned Claude session in pane ${newPaneId} at ${cwd}`);

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

          wez.sendText(newPaneId, args.prompt);
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              pane_id: newPaneId,
              cwd,
              initial_prompt: args.prompt || null,
              message: `Claude session spawned in pane ${newPaneId}. ${args.prompt ? 'Initial prompt sent.' : 'Ready for prompts.'}`,
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
