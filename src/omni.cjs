#!/usr/bin/env node
/**
 * Omni CLI — launch or configure the "god mode" Claude that manages all your sessions.
 *
 * Usage:
 *   node src/omni.cjs                  # Launch omni Claude with MCP tools
 *   node src/omni.cjs --setup          # Install MCP config into ~/.claude.json
 *   node src/omni.cjs --scan           # Quick scan: show all Claude sessions
 *   node src/omni.cjs --info           # Show setup instructions
 *
 * What it does:
 *   1. Registers the WezBridge MCP server so Claude Code gets tools to manage terminals
 *   2. Launches Claude Code with a system prompt that explains its "omni" role
 *   3. The omni Claude can then discover, read, and command all other Claude sessions
 */
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const MCP_SERVER_PATH = path.resolve(__dirname, 'mcp-server.cjs');
const CLAUDE_CONFIG = path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.claude.json'
);

// ─── ANSI colors ───────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

// ─── Arg parsing ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  setup: args.includes('--setup'),
  scan: args.includes('--scan'),
  info: args.includes('--info'),
  help: args.includes('--help') || args.includes('-h'),
  yolo: args.includes('--yolo') || !!process.env.WEZBRIDGE_YOLO,
  project: null,
};

// Extract --project value
const projIdx = args.indexOf('--project');
if (projIdx !== -1 && args[projIdx + 1]) {
  flags.project = path.resolve(args[projIdx + 1].replace(/^~/, process.env.HOME || ''));
}

if (flags.help) {
  console.log(`
${c.bold}${c.cyan}WezBridge Omni${c.reset} — One Claude to manage all your Claude sessions

${c.bold}Usage:${c.reset}
  node src/omni.cjs                 Launch omni Claude with MCP tools
  node src/omni.cjs --setup         Install MCP server into Claude config
  node src/omni.cjs --scan          Quick scan: show all active sessions
  node src/omni.cjs --info          Show how it works

${c.bold}Options:${c.reset}
  --project <path>    Working directory for the omni Claude (default: cwd)
  --yolo              Skip permission prompts
  --setup             Register MCP server in ~/.claude.json
  --scan              Just scan and display panes, don't launch

${c.bold}How it works:${c.reset}
  1. Your projects each have a Claude Code session running in WezTerm
  2. Omni Claude gets MCP tools: discover_sessions, read_output, send_prompt, etc.
  3. You talk to omni Claude, it delegates to your project sessions
  4. It can read their output, send instructions, and coordinate across projects
`);
  process.exit(0);
}

// ─── Scan mode ─────────────────────────────────────────────────────────────
if (flags.scan) {
  const discovery = require('./pane-discovery.cjs');
  const summary = discovery.getSummary();

  if (summary.total === 0) {
    console.log(`${c.yellow}No Claude Code sessions detected in WezTerm.${c.reset}`);
    console.log(`Start some Claude sessions in WezTerm panes first.`);
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.cyan}Active Claude Sessions${c.reset}\n`);
  console.log(`Total: ${c.bold}${summary.total}${c.reset} sessions\n`);

  for (const [project, panes] of Object.entries(summary.projects)) {
    console.log(`  ${c.bold}${project}${c.reset}`);
    for (const pane of panes) {
      const statusColor = pane.status === 'idle' ? c.green
        : pane.status === 'working' ? c.yellow
        : pane.status === 'permission' ? c.red
        : c.dim;
      const lastLine = pane.lastLines.split('\n').filter(l => l.trim()).slice(-1)[0] || '';
      console.log(`    ${statusColor}[${pane.status}]${c.reset} pane ${pane.paneId} — ${c.dim}${lastLine.slice(0, 80)}${c.reset}`);
    }
    console.log();
  }

  console.log(`${c.dim}Status: ${c.green}idle=${summary.byStatus.idle || 0}${c.reset}${c.dim} working=${summary.byStatus.working || 0} permission=${summary.byStatus.permission || 0}${c.reset}\n`);
  process.exit(0);
}

// ─── Info mode ─────────────────────────────────────────────────────────────
if (flags.info) {
  console.log(`
${c.bold}${c.cyan}How WezBridge Omni Works${c.reset}

${c.bold}Architecture:${c.reset}
  ┌─────────────────────────────────────────────────────┐
  │  You  ──→  Omni Claude (with MCP tools)             │
  │                │                                     │
  │                ├── discover_sessions → scan WezTerm  │
  │                ├── read_output(pane) → see results   │
  │                ├── send_prompt(pane) → give tasks    │
  │                ├── get_status(pane) → check progress │
  │                └── send_key(pane) → approve/cancel   │
  │                                                      │
  │  WezTerm Panes:                                     │
  │    [Pane 1: Claude @ app1]  ←── read/write          │
  │    [Pane 2: Claude @ app2]  ←── read/write          │
  │    [Pane 3: Claude @ app3]  ←── read/write          │
  └─────────────────────────────────────────────────────┘

${c.bold}Setup:${c.reset}
  1. Have Claude Code sessions running in WezTerm panes
  2. Run: ${c.bold}node src/omni.cjs --setup${c.reset}    (one-time MCP registration)
  3. Run: ${c.bold}node src/omni.cjs${c.reset}             (launch omni Claude)

${c.bold}Or manually:${c.reset}
  Add to your project's ${c.bold}.mcp.json${c.reset}:
  {
    "mcpServers": {
      "wezbridge": {
        "type": "stdio",
        "command": "node",
        "args": ["${MCP_SERVER_PATH}"]
      }
    }
  }

  Then run ${c.bold}claude${c.reset} in any terminal — it'll have the WezBridge tools.

${c.bold}MCP Tools Available:${c.reset}
  discover_sessions  — Find all Claude sessions in WezTerm
  read_output        — Read terminal output from a session
  send_prompt        — Send instructions to a session
  get_status         — Check if a session is idle/working
  list_projects      — Overview of all projects with sessions
  send_key           — Answer y/n prompts, press Enter, Ctrl+C
`);
  process.exit(0);
}

// ─── Setup mode: register MCP server ──────────────────────────────────────
if (flags.setup) {
  console.log(`${c.bold}${c.cyan}Setting up WezBridge MCP server...${c.reset}\n`);

  // Method 1: Use claude CLI to add MCP server
  try {
    execSync(`claude mcp add --scope user wezbridge -- node "${MCP_SERVER_PATH}"`, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 10000,
    });
    console.log(`\n${c.green}MCP server registered globally.${c.reset}`);
    console.log(`Every Claude Code session now has WezBridge tools.`);
    console.log(`\nRun ${c.bold}node src/omni.cjs${c.reset} to launch omni Claude.`);
    process.exit(0);
  } catch {
    console.log(`${c.yellow}claude CLI not available, creating .mcp.json manually...${c.reset}`);
  }

  // Method 2: Create .mcp.json in cwd
  const mcpConfig = {
    mcpServers: {
      wezbridge: {
        type: 'stdio',
        command: 'node',
        args: [MCP_SERVER_PATH],
      },
    },
  };

  const mcpPath = path.join(process.cwd(), '.mcp.json');

  // Merge with existing .mcp.json if present
  if (fs.existsSync(mcpPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      existing.mcpServers = existing.mcpServers || {};
      existing.mcpServers.wezbridge = mcpConfig.mcpServers.wezbridge;
      fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    } catch {
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
    }
  } else {
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
  }

  console.log(`${c.green}Created ${mcpPath}${c.reset}`);
  console.log(`\nRun ${c.bold}claude${c.reset} in this directory — it'll have WezBridge tools.`);
  process.exit(0);
}

// ─── Launch mode: start omni Claude ───────────────────────────────────────

const OMNI_SYSTEM_PROMPT = `You are the Omni orchestrator — a manager Claude that oversees all other Claude Code sessions running in WezTerm terminals.

You have MCP tools from WezBridge that let you:
- discover_sessions: Scan WezTerm to find all active Claude sessions and their projects
- read_output(pane_id): Read what a Claude session has been doing
- send_prompt(pane_id, text): Send instructions to any Claude session
- get_status(pane_id): Check if a session is idle, working, or waiting for permission
- list_projects: See all projects with active sessions
- send_key(pane_id, key): Answer permission prompts (y/n), press Enter, or Ctrl+C

Your workflow:
1. Start by running discover_sessions to see what's running
2. The user will ask you to coordinate work across projects
3. Check status before sending prompts — only send to idle sessions
4. After sending a prompt, wait and check back with read_output to see results
5. Report back to the user with a summary of what happened

Rules:
- Never send prompts to sessions that are "working" — they'll queue up and cause confusion
- Always check status first with get_status or discover_sessions
- When delegating tasks, be specific in your instructions to each session
- If a session has a permission prompt, use send_key to approve or deny it
- Summarize results from multiple sessions concisely for the user`;

console.log(`\n${c.bold}${c.cyan}━━━ WezBridge Omni ━━━${c.reset}\n`);
console.log(`Launching Claude Code with WezBridge MCP tools...`);
console.log(`The omni Claude can see and command all your terminal sessions.\n`);

// Build claude command
const claudeArgs = ['claude'];
if (flags.yolo) claudeArgs.push('--dangerously-skip-permissions');

// Add system prompt
claudeArgs.push('--system-prompt', OMNI_SYSTEM_PROMPT);

// Add MCP server inline if .mcp.json doesn't exist in target dir
const targetDir = flags.project || process.cwd();
const mcpJsonPath = path.join(targetDir, '.mcp.json');
if (!fs.existsSync(mcpJsonPath)) {
  claudeArgs.push('--mcp-config', JSON.stringify({
    mcpServers: {
      wezbridge: {
        type: 'stdio',
        command: 'node',
        args: [MCP_SERVER_PATH],
      },
    },
  }));
}

// Launch Claude as interactive process
// shell: true is required on Windows so spawn can resolve .cmd/.ps1 shims
const child = spawn(claudeArgs[0], claudeArgs.slice(1), {
  cwd: targetDir,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env },
});

child.on('error', (err) => {
  console.error(`${c.red}Failed to launch claude: ${err.message}${c.reset}`);
  console.log(`Make sure 'claude' CLI is in your PATH.`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
