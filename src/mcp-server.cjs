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
          case 'y':
          case 'n':
            wez.sendText(paneId, key);
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
