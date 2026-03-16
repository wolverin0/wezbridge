#!/usr/bin/env node
/**
 * Orchestrator CLI — standalone PC entry point for multi-session Claude Code orchestration.
 *
 * Runs as a Node.js process on the local machine. Spawns Claude Code sessions in
 * WezTerminal panes, coordinates them via prompt queue and mailbox, and optionally
 * starts a REST API for Telegram/dashboard access.
 *
 * Usage:
 *   node src/orchestrator-cli.cjs --project ~/myapp \
 *     --team "@frontend:Build React UI, @backend:Build API routes" \
 *     --orchestrator --port 4200 --yolo
 *
 * Flags:
 *   --project <path>       Project directory (required)
 *   --team "<spec>"        Team members as @alias:role pairs (required)
 *   --orchestrator         Spawn an overseer session that monitors all others
 *   --port <number>        Start REST API server on this port
 *   --yolo                 Skip Claude Code permission prompts
 *   --stability <count>    Stability poll count before declaring completion (default: 3)
 *   --poll <ms>            Poll interval in milliseconds (default: 3000)
 *
 * Without Telegram:
 *   The orchestrator runs purely from the PC. Status is shown in console output.
 *   Use --port to enable REST API for external integrations (Telegram, dashboard, etc.)
 */

// Load .env if present
try { require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); } catch {}

const sm = require('./session-manager.cjs');
const wez = require('./wezterm.cjs');
const orchestrator = require('./terminal-orchestrator.cjs');
const sharedTasks = require('./shared-tasks.cjs');
const promptQueue = require('./prompt-queue.cjs');
const sanitizer = require('./message-sanitizer.cjs');
const outputParser = require('./output-parser.cjs');

// ─── ANSI colors ───────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

function log(tag, color, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`${c.dim}${ts}${c.reset} ${color}[${tag}]${c.reset} ${msg}`);
}

// ─── Arg parsing ───────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    project: null,
    team: [],
    orchestrator: false,
    port: null,
    yolo: false,
    stability: parseInt(process.env.WEZBRIDGE_STABILITY_COUNT || '3', 10),
    poll: parseInt(process.env.TELEGRAM_POLL_MS || '3000', 10),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project':
        opts.project = args[++i];
        break;
      case '--team':
        opts.teamRaw = args[++i];
        break;
      case '--orchestrator':
        opts.orchestrator = true;
        break;
      case '--port':
        opts.port = parseInt(args[++i], 10);
        break;
      case '--yolo':
        opts.yolo = true;
        break;
      case '--stability':
        opts.stability = parseInt(args[++i], 10);
        break;
      case '--poll':
        opts.poll = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }

  // Parse team spec: "@frontend:Build React UI, @backend:Build API routes"
  if (opts.teamRaw) {
    const memberPattern = /@([a-zA-Z0-9_-]+):([^,@]+)/g;
    let match;
    while ((match = memberPattern.exec(opts.teamRaw)) !== null) {
      opts.team.push({ alias: match[1].toLowerCase(), role: match[2].trim() });
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
${c.bold}${c.cyan}WezBridge Orchestrator${c.reset} — Multi-session Claude Code coordination

${c.bold}Usage:${c.reset}
  node src/orchestrator-cli.cjs --project <path> --team "<spec>" [options]

${c.bold}Required:${c.reset}
  --project <path>       Project directory
  --team "<spec>"        Team members: "@name:role, @name:role"

${c.bold}Options:${c.reset}
  --orchestrator         Spawn an overseer session
  --port <number>        Start REST API on this port
  --yolo                 Skip permission prompts (--dangerously-skip-permissions)
  --stability <count>    Polls before completion (default: 3)
  --poll <ms>            Poll interval (default: 3000)

${c.bold}Examples:${c.reset}
  ${c.dim}# Basic team${c.reset}
  node src/orchestrator-cli.cjs --project ~/myapp \\
    --team "@frontend:Build UI, @backend:Build API"

  ${c.dim}# With orchestrator and REST API${c.reset}
  node src/orchestrator-cli.cjs --project ~/myapp \\
    --team "@frontend:UI, @backend:API, @tests:Tests" \\
    --orchestrator --port 4200

  ${c.dim}# YOLO mode${c.reset}
  node src/orchestrator-cli.cjs --project ~/myapp \\
    --team "@frontend:UI, @backend:API" --yolo
`);
}

// ─── Completion Loop ───────────────────────────────────────────────────────
let completionTimer = null;

function startCompletionLoop(pollMs) {
  log('loop', c.blue, `Completion polling every ${pollMs}ms`);

  completionTimer = setInterval(() => {
    const newlyWaiting = sm.pollAll();

    for (const session of newlyWaiting) {
      const alias = orchestrator.getAlias(session.id) || session.name || session.id;

      try {
        // Extract and sanitize output
        const rawOutput = wez.getFullText(session.paneId, 500);
        const safeOutput = sanitizer.extractSafeResult(rawOutput);

        // Console status
        const preview = safeOutput.slice(0, 200).replace(/\n/g, ' ');
        if (session.promptType === 'permission') {
          log(alias, c.yellow, `Permission prompt detected — needs approval`);
        } else {
          log(alias, c.green, `Completed: ${preview}${safeOutput.length > 200 ? '...' : ''}`);
        }

        // Drain prompt queue (delivers next queued message if any)
        promptQueue.onSessionIdle(session.id);

        // Save completion history
        sm.addCompletionHistory(session.id, {
          response: safeOutput,
          timestamp: new Date().toISOString(),
        });

      } catch (err) {
        log(alias, c.red, `Output read failed: ${err.message}`);
      }
    }
  }, pollMs);
}

// ─── Startup ───────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  if (!opts.project) {
    console.error(`${c.red}Error: --project is required${c.reset}`);
    printHelp();
    process.exit(1);
  }

  if (opts.team.length === 0) {
    console.error(`${c.red}Error: --team is required (e.g., --team "@frontend:UI, @backend:API")${c.reset}`);
    printHelp();
    process.exit(1);
  }

  // Resolve project path
  const path = require('path');
  const fs = require('fs');
  const project = path.resolve(opts.project.replace(/^~/, process.env.HOME || process.env.USERPROFILE || ''));

  if (!fs.existsSync(project)) {
    console.error(`${c.red}Error: Project directory not found: ${project}${c.reset}`);
    process.exit(1);
  }

  // Set env vars for configurable stability
  if (opts.stability) {
    process.env.WEZBRIDGE_STABILITY_COUNT = String(opts.stability);
  }

  // Banner
  console.log(`\n${c.bold}${c.cyan}━━━ WezBridge Orchestrator ━━━${c.reset}\n`);
  log('init', c.cyan, `Project: ${project}`);
  log('init', c.cyan, `Team: ${opts.team.map(m => `@${m.alias}`).join(', ')}`);
  log('init', c.cyan, `Orchestrator: ${opts.orchestrator ? 'yes' : 'no'}`);
  log('init', c.cyan, `YOLO: ${opts.yolo ? 'yes' : 'no'}`);
  log('init', c.cyan, `Stability: ${opts.stability} polls (${opts.stability * opts.poll / 1000}s)`);

  // Setup auto-coordination
  orchestrator.setupAutoCoordination();

  // Create team
  log('team', c.magenta, 'Spawning team members...');
  const result = orchestrator.createTeam({
    project,
    members: opts.team,
    withOrchestrator: opts.orchestrator,
    dangerouslySkipPermissions: opts.yolo,
  });

  // Report results
  for (const member of result.members) {
    if (member.error) {
      log(member.alias, c.red, `Failed: ${member.error}`);
    } else {
      const session = sm.getSession(member.sessionId);
      log(member.alias, c.green, `Spawned → pane ${session?.paneId} (${member.sessionId})`);
    }
  }

  if (result.orchestrator) {
    log('orchestrator', c.magenta, `Overseer → ${result.orchestrator.id}`);
  }

  // Start completion loop
  startCompletionLoop(opts.poll);

  // Start REST API if port specified
  if (opts.port) {
    process.env.WEZ_BRIDGE_PORT = String(opts.port);
    const { start } = require('./server.cjs');
    start();
    log('api', c.blue, `REST API on port ${opts.port}`);
  }

  // Queue stats every 30 seconds
  setInterval(() => {
    const stats = promptQueue.getStats();
    const aliases = orchestrator.listAliases();
    const activeCount = aliases.filter(a => {
      const s = sm.getSession(a.sessionId);
      return s && s.status === 'running';
    }).length;
    const waitingCount = aliases.filter(a => {
      const s = sm.getSession(a.sessionId);
      return s && s.status === 'waiting';
    }).length;

    log('status', c.dim, `Sessions: ${c.green}${waitingCount} idle${c.reset} / ${c.yellow}${activeCount} running${c.reset} | Queue: ${stats.totalPending} pending, ${stats.totalDelivered} delivered`);
  }, 30000);

  // Prompt queue events → console
  promptQueue.events.on('prompt:delivered', ({ sessionId, item }) => {
    const alias = orchestrator.getAlias(sessionId) || sessionId;
    log(alias, c.blue, `← Prompt delivered (${item.source})`);
  });
  promptQueue.events.on('prompt:failed', ({ sessionId, error }) => {
    const alias = orchestrator.getAlias(sessionId) || sessionId;
    log(alias, c.red, `← Delivery failed: ${error}`);
  });

  // Team member events → console
  orchestrator.events.on('message:queued', (msg) => {
    log('mail', c.dim, `@${msg.from} → @${msg.to}: ${msg.message.slice(0, 80)}...`);
  });
  orchestrator.events.on('message:delivered', ({ sessionId, count }) => {
    const alias = orchestrator.getAlias(sessionId) || sessionId;
    log('mail', c.green, `${count} message(s) delivered to @${alias}`);
  });

  console.log(`\n${c.bold}${c.green}✓ Orchestrator running${c.reset} — ${opts.team.length} sessions active\n`);
  log('info', c.dim, 'Press Ctrl+C to shutdown all sessions');
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────
function shutdown() {
  console.log(`\n${c.yellow}[shutdown]${c.reset} Stopping all sessions...`);

  if (completionTimer) clearInterval(completionTimer);

  // Kill all team members
  const killed = orchestrator.disbandTeam();
  if (killed.length > 0) {
    log('shutdown', c.yellow, `Killed: ${killed.map(a => `@${a}`).join(', ')}`);
  }

  // Clear prompt queues
  promptQueue.clearAll();

  console.log(`${c.green}[shutdown]${c.reset} Clean exit.`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => {
  log('error', c.red, `Unhandled rejection: ${err?.message || err}`);
});

// Run
main().catch(err => {
  console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
