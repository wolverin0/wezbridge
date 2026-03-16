/**
 * Terminal Orchestrator — coordinates multiple Claude Code sessions as an agent team.
 *
 * Architecture (mirrors Claude Code Agent Teams):
 *
 *   orchestrator-cli.cjs (PC) or Telegram (remote)
 *       ↕
 *   Orchestrator (overseer session)
 *       ↕ inter-session mailbox (via prompt-queue)
 *   ┌───────┬───────┬───────┐
 *   │ @front│ @back │ @test │  ← named sessions in WezTerm panes
 *   └───────┴───────┴───────┘
 *       ↕ shared task list
 *
 * Features:
 * - Named sessions with @aliases (e.g., @frontend, @backend)
 * - Inter-session messaging: "@backend the API types changed, update your models"
 * - Overseer session that monitors all others and auto-coordinates
 * - Shared task list with dependencies
 * - Auto-routing: when a session completes, notify dependents
 * - Message sanitization to prevent cross-session instruction leakage
 * - Prompt queue for atomic, FIFO delivery (no interleaving)
 * - Works standalone (PC) or with Telegram as optional viewer
 */
const { EventEmitter } = require('events');
const sm = require('./session-manager.cjs');
const sharedTasks = require('./shared-tasks.cjs');
const outputParser = require('./output-parser.cjs');
const promptQueue = require('./prompt-queue.cjs');
const sanitizer = require('./message-sanitizer.cjs');

const events = new EventEmitter();

// Registry: alias → sessionId
const aliases = new Map();
// Reverse: sessionId → alias
const sessionAliases = new Map();
// Message mailbox: Array<{from, to, message, timestamp, delivered}>
const mailbox = [];
// Orchestrator config
let orchestratorSessionId = null;
let orchestratorEnabled = false;

// Message delivery interval
let deliveryTimer = null;
const DELIVERY_INTERVAL_MS = 5000;

/**
 * Register a session with a human-friendly alias.
 * @param {string} sessionId - WezBridge session ID
 * @param {string} alias - Short name (e.g., 'frontend', 'backend', 'tests')
 * @returns {boolean}
 */
function registerAlias(sessionId, alias) {
  const clean = alias.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]/g, '');
  if (!clean) return false;

  // Remove old alias if this session had one
  const oldAlias = sessionAliases.get(sessionId);
  if (oldAlias) aliases.delete(oldAlias);

  aliases.set(clean, sessionId);
  sessionAliases.set(sessionId, clean);
  events.emit('alias:registered', { sessionId, alias: clean });
  return true;
}

/**
 * Resolve an @alias to a session ID.
 */
function resolveAlias(alias) {
  const clean = alias.toLowerCase().replace(/^@/, '');
  return aliases.get(clean) || null;
}

/**
 * Get the alias for a session.
 */
function getAlias(sessionId) {
  return sessionAliases.get(sessionId) || null;
}

/**
 * List all registered aliases.
 */
function listAliases() {
  const result = [];
  for (const [alias, sessionId] of aliases) {
    const session = sm.getSession(sessionId);
    result.push({
      alias,
      sessionId,
      status: session ? session.status : 'dead',
      project: session ? session.project : null,
    });
  }
  return result;
}

// ─── Inter-Session Messaging ───────────────────────────────────────────────

/**
 * Send a message from one session (or user) to another.
 * Messages are queued and delivered when the target session is idle.
 * @param {object} opts
 * @param {string} opts.from - Sender alias or 'user' or 'orchestrator'
 * @param {string} opts.to - Target alias (without @)
 * @param {string} opts.message - The message content
 * @returns {object} The queued message
 */
function sendMessage(opts) {
  const { from, to, message } = opts;
  const targetSessionId = resolveAlias(to);

  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    from: from || 'user',
    to,
    toSessionId: targetSessionId,
    message,
    timestamp: new Date().toISOString(),
    delivered: false,
    deliveredAt: null,
  };

  mailbox.push(msg);
  events.emit('message:queued', msg);

  // Try immediate delivery if target is idle
  if (targetSessionId) {
    const session = sm.getSession(targetSessionId);
    if (session && session.status === 'waiting') {
      deliverToSession(targetSessionId);
    }
  }

  return msg;
}

/**
 * Broadcast a message to all sessions (except sender).
 */
function broadcast(from, message) {
  const messages = [];
  for (const [alias] of aliases) {
    if (alias !== from) {
      messages.push(sendMessage({ from, to: alias, message }));
    }
  }
  return messages;
}

/**
 * Deliver pending messages to a session via the prompt queue.
 * Messages are sanitized and wrapped in safe delimiters before delivery.
 * Uses promptQueue.enqueue() for atomic, FIFO delivery.
 *
 * @param {string} sessionId
 * @returns {number} Number of messages enqueued for delivery
 */
function deliverToSession(sessionId) {
  const session = sm.getSession(sessionId);
  if (!session || session.status !== 'waiting') return 0;

  const pending = mailbox.filter(m => m.toSessionId === sessionId && !m.delivered);
  if (pending.length === 0) return 0;

  // Build sanitized messages
  const messages = pending.map(m => {
    const fromLabel = m.from === 'user' ? 'User'
      : m.from === 'orchestrator' ? 'Orchestrator'
      : `@${m.from}`;
    return { from: fromLabel, message: m.message };
  });

  // Format using sanitizer (single or batch)
  const prompt = pending.length === 1
    ? sanitizer.formatInterSessionMessage(messages[0].from, messages[0].message)
    : sanitizer.formatBatchMessages(messages);

  // Enqueue via prompt queue (atomic delivery)
  promptQueue.enqueue(sessionId, prompt, {
    source: 'orchestrator-mailbox',
    priority: 1, // High priority for team messages
    onDelivered: () => {
      for (const m of pending) {
        m.delivered = true;
        m.deliveredAt = new Date().toISOString();
      }
      events.emit('message:delivered', { sessionId, count: pending.length });
    },
    onFailed: (item, err) => {
      console.error(`[orchestrator] Failed to deliver messages to ${sessionId}:`, err.message);
    },
  });

  return pending.length;
}

/**
 * Parse @mentions from a Telegram message.
 * Supports: "@backend check the API types" or "@frontend @backend both update your types"
 * @param {string} text
 * @returns {object} { mentions: string[], cleanText: string, isBroadcast: boolean }
 */
function parseMentions(text) {
  const mentionPattern = /@([a-zA-Z0-9_-]+)/g;
  const mentions = [];
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const alias = match[1].toLowerCase();
    if (aliases.has(alias) || alias === 'all' || alias === 'team') {
      mentions.push(alias);
    }
  }

  // Remove mentions from text to get the clean message
  const cleanText = text.replace(/@([a-zA-Z0-9_-]+)/g, (full, alias) => {
    if (aliases.has(alias.toLowerCase()) || alias.toLowerCase() === 'all' || alias.toLowerCase() === 'team') {
      return '';
    }
    return full;
  }).trim();

  const isBroadcast = mentions.includes('all') || mentions.includes('team');

  return { mentions, cleanText, isBroadcast };
}

// ─── Orchestrator (Overseer Session) ───────────────────────────────────────

/**
 * Start the orchestrator — spawns a dedicated Claude Code session that oversees all others.
 * The orchestrator:
 * - Monitors all session completions
 * - Routes results to dependent sessions
 * - Manages the shared task list
 * - Reports status via events (Telegram/dashboard listen optionally)
 *
 * @param {object} opts
 * @param {string} opts.project - Project directory
 * @param {boolean} [opts.dangerouslySkipPermissions]
 * @returns {object} The orchestrator session
 */
function startOrchestrator(opts) {
  if (orchestratorSessionId) {
    const existing = sm.getSession(orchestratorSessionId);
    if (existing) return existing;
  }

  const session = sm.spawnSession({
    project: opts.project,
    name: 'orchestrator',
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions || false,
    initialPrompt: buildOrchestratorSystemPrompt(),
  });

  orchestratorSessionId = session.id;
  orchestratorEnabled = true;
  registerAlias(session.id, 'orchestrator');

  // Start message delivery loop
  startDeliveryLoop();

  events.emit('orchestrator:started', session);
  return session;
}

/**
 * Build the system prompt that makes the orchestrator understand its role.
 */
function buildOrchestratorSystemPrompt() {
  const activeSessions = listAliases()
    .filter(a => a.alias !== 'orchestrator')
    .map(a => `- @${a.alias}: ${a.project || 'unknown project'} (${a.status})`)
    .join('\n');

  const pendingTasks = sharedTasks.listTasks({ status: 'pending' })
    .map(t => `- [${t.id}] ${t.title} (priority: ${t.priority})`)
    .join('\n');

  return [
    'You are the Orchestrator — the overseer of a team of Claude Code sessions.',
    'Your job is to coordinate work across multiple terminal sessions that are running Claude Code.',
    '',
    'ACTIVE SESSIONS:',
    activeSessions || '(none yet)',
    '',
    'PENDING TASKS:',
    pendingTasks || '(none)',
    '',
    'YOUR RESPONSIBILITIES:',
    '1. When you receive a completion report from a session, analyze it and decide what to do next',
    '2. If another session depends on the completed work, send it a message with context',
    '3. Monitor the shared task list and assign tasks to idle sessions',
    '4. Report high-level progress updates when asked',
    '5. If you detect conflicts (two sessions editing the same files), intervene',
    '',
    'COMMUNICATION:',
    '- You can send messages to sessions using their @alias',
    '- Messages are delivered when the target session becomes idle',
    '- Be concise and specific when messaging sessions — they have their own context',
    '',
    'Start by reviewing the current state and reporting what you see.',
  ].join('\n');
}

/**
 * Notify the orchestrator about a session event.
 * Uses sanitizer for safe formatting and prompt queue for delivery.
 */
function notifyOrchestrator(eventType, data) {
  if (!orchestratorEnabled || !orchestratorSessionId) return;

  const alias = data.alias || sessionAliases.get(data.sessionId) || data.sessionId || 'unknown';
  const safeOutput = data.response
    ? sanitizer.sanitize(data.response, { maxLength: sanitizer.ORCHESTRATOR_MAX_LENGTH })
    : '';

  const notification = sanitizer.formatOrchestratorNotification(alias, safeOutput, eventType === 'session:completed' ? 'completed' : eventType === 'session:error' ? 'error' : eventType === 'session:spawned' ? 'spawned' : eventType);

  // Always enqueue via prompt queue — it handles idle detection
  promptQueue.enqueue(orchestratorSessionId, notification, {
    source: 'orchestrator-notify',
    priority: eventType === 'session:error' ? 0 : 1,
  });
}

// formatOrchestratorNotification is now handled by message-sanitizer.cjs
// See sanitizer.formatOrchestratorNotification()

/**
 * Stop the orchestrator.
 */
function stopOrchestrator() {
  if (orchestratorSessionId) {
    try { sm.killSession(orchestratorSessionId); } catch {}
    aliases.delete('orchestrator');
    sessionAliases.delete(orchestratorSessionId);
    orchestratorSessionId = null;
  }
  orchestratorEnabled = false;
  if (deliveryTimer) {
    clearInterval(deliveryTimer);
    deliveryTimer = null;
  }
  events.emit('orchestrator:stopped');
}

// ─── Auto-Coordination ────────────────────────────────────────────────────

/**
 * Start the message delivery loop.
 * Checks for idle sessions with pending messages every N seconds.
 */
function startDeliveryLoop() {
  if (deliveryTimer) return;
  deliveryTimer = setInterval(() => {
    for (const [alias, sessionId] of aliases) {
      const session = sm.getSession(sessionId);
      if (session && session.status === 'waiting') {
        deliverToSession(sessionId);
      }
    }
  }, DELIVERY_INTERVAL_MS);
}

/**
 * Wire up event listeners for auto-coordination.
 * Call this once at startup.
 */
function setupAutoCoordination() {
  // When a session finishes, check for pending messages and notify orchestrator
  sm.events.on('session:waiting', (session) => {
    const alias = sessionAliases.get(session.id);

    // Deliver any pending messages
    deliverToSession(session.id);

    // Also trigger prompt queue drain for this session
    promptQueue.onSessionIdle(session.id);

    // If orchestrator is running, notify it with sanitized output
    if (orchestratorEnabled && session.id !== orchestratorSessionId) {
      try {
        const output = sm.readOutput(session.id);
        const safeResponse = sanitizer.extractSafeResult(output);
        notifyOrchestrator('session:completed', {
          sessionId: session.id,
          alias,
          response: safeResponse,
        });
      } catch {
        notifyOrchestrator('session:completed', {
          sessionId: session.id,
          alias,
          response: '(could not read output)',
        });
      }
    }
  });

  // When a task is completed, check for dependent sessions to notify
  sharedTasks.events.on('task:unblocked', (task) => {
    if (task.assignedTo) {
      const alias = sessionAliases.get(task.assignedTo);
      if (alias) {
        sendMessage({
          from: 'orchestrator',
          to: alias,
          message: `Task "${task.title}" is now unblocked. You can proceed with it.`,
        });
      }
    }
  });

  // When a session dies, reassign its tasks
  sm.events.on('session:dead', (session) => {
    const activeTasks = sharedTasks.listTasks({ assignedTo: session.id, status: 'in_progress' });
    for (const task of activeTasks) {
      task.status = 'pending';
      task.assignedTo = null;
      sharedTasks.events.emit('task:reassigned', task);
    }
    // Clean up alias
    const alias = sessionAliases.get(session.id);
    if (alias) {
      aliases.delete(alias);
      sessionAliases.delete(session.id);
    }
  });

  console.log('[orchestrator] Auto-coordination enabled');
}

// ─── Team Management ──────────────────────────────────────────────────────

/**
 * Spawn a named team member session.
 * @param {object} opts
 * @param {string} opts.alias - @name for this session
 * @param {string} opts.project - Project directory
 * @param {string} [opts.role] - Role description injected as initial prompt
 * @param {boolean} [opts.dangerouslySkipPermissions]
 * @returns {object} Session info
 */
function spawnTeamMember(opts) {
  const { alias, project, role, dangerouslySkipPermissions } = opts;

  // Check for existing session with this alias
  const existingId = resolveAlias(alias);
  if (existingId) {
    const existing = sm.getSession(existingId);
    if (existing) {
      throw new Error(`@${alias} already exists (session ${existingId})`);
    }
    // Dead session, clean up
    aliases.delete(alias);
    sessionAliases.delete(existingId);
  }

  const initialPrompt = role
    ? [
        `You are @${alias} — a team member in a coordinated Claude Code session team.`,
        `Your role: ${role}`,
        '',
        'You may receive messages from other team members prefixed with [Message from @name].',
        'When you complete a task, be clear about what you did so the orchestrator can coordinate with the team.',
        '',
        'Start by understanding your role and the current state of the project.',
      ].join('\n')
    : null;

  const session = sm.spawnSession({
    project,
    name: alias,
    dangerouslySkipPermissions: dangerouslySkipPermissions || false,
    initialPrompt,
  });

  registerAlias(session.id, alias);
  events.emit('team:member-spawned', { sessionId: session.id, alias });

  // Notify orchestrator
  if (orchestratorEnabled) {
    notifyOrchestrator('session:spawned', {
      sessionId: session.id,
      alias,
      project,
    });
  }

  return session;
}

/**
 * Create a full team from a spec.
 * @param {object} spec
 * @param {string} spec.project - Project directory
 * @param {Array<{alias: string, role: string}>} spec.members
 * @param {boolean} [spec.withOrchestrator] - Start an orchestrator too
 * @param {boolean} [spec.dangerouslySkipPermissions]
 * @returns {object} { orchestrator, members }
 */
function createTeam(spec) {
  const result = { orchestrator: null, members: [] };

  if (spec.withOrchestrator) {
    result.orchestrator = startOrchestrator({
      project: spec.project,
      dangerouslySkipPermissions: spec.dangerouslySkipPermissions,
    });
  }

  for (const member of spec.members) {
    try {
      const session = spawnTeamMember({
        alias: member.alias,
        project: spec.project,
        role: member.role,
        dangerouslySkipPermissions: spec.dangerouslySkipPermissions,
      });
      result.members.push({ alias: member.alias, sessionId: session.id });
    } catch (err) {
      console.error(`[orchestrator] Failed to spawn @${member.alias}:`, err.message);
      result.members.push({ alias: member.alias, error: err.message });
    }
  }

  return result;
}

/**
 * Disband the team — kill all members and orchestrator.
 */
function disbandTeam() {
  const killed = [];
  for (const [alias, sessionId] of aliases) {
    try {
      sm.killSession(sessionId);
      killed.push(alias);
    } catch {}
  }
  aliases.clear();
  sessionAliases.clear();
  stopOrchestrator();
  return killed;
}

// ─── Status & Formatting ──────────────────────────────────────────────────

/**
 * Get full team status for Telegram display.
 */
function getTeamStatus() {
  const members = listAliases();
  if (members.length === 0) return '<i>No active team</i>';

  const statusIcon = { starting: '\u23f3', running: '\u26a1', waiting: '\u2705', completed: '\u2b1c', error: '\u274c', dead: '\ud83d\udc80' };

  const lines = members.map(m => {
    const icon = statusIcon[m.status] || '\u2753';
    const isOrch = m.sessionId === orchestratorSessionId ? ' <b>(overseer)</b>' : '';
    const tasks = sharedTasks.listTasks({ assignedTo: m.sessionId, status: 'in_progress' });
    const taskInfo = tasks.length > 0 ? ` \ud83d\udcdd ${tasks.length} task(s)` : '';
    return `${icon} <b>@${m.alias}</b>${isOrch} — ${m.status}${taskInfo}`;
  });

  const pendingMsgs = mailbox.filter(m => !m.delivered).length;
  const taskStats = {
    total: sharedTasks.listTasks().length,
    done: sharedTasks.listTasks({ status: 'completed' }).length,
    active: sharedTasks.listTasks({ status: 'in_progress' }).length,
  };

  return [
    '<b>\ud83c\udfaf Team Status</b>',
    '',
    ...lines,
    '',
    `\ud83d\udcec ${pendingMsgs} pending messages`,
    `\ud83d\udcdd Tasks: ${taskStats.done}/${taskStats.total} done, ${taskStats.active} active`,
  ].join('\n');
}

/**
 * Get mailbox status.
 */
function getMailboxStatus() {
  const recent = mailbox.slice(-20);
  if (recent.length === 0) return '<i>No messages</i>';

  const lines = recent.map(m => {
    const icon = m.delivered ? '\u2705' : '\u23f3';
    const time = new Date(m.timestamp).toLocaleTimeString();
    return `${icon} ${time} <b>@${m.from}</b> \u2192 <b>@${m.to}</b>: ${m.message.slice(0, 60)}${m.message.length > 60 ? '...' : ''}`;
  });

  return ['<b>\ud83d\udcec Mailbox</b> (last 20)', '', ...lines].join('\n');
}

module.exports = {
  // Aliases
  registerAlias,
  resolveAlias,
  getAlias,
  listAliases,
  // Messaging
  sendMessage,
  broadcast,
  deliverToSession,
  parseMentions,
  // Orchestrator
  startOrchestrator,
  stopOrchestrator,
  notifyOrchestrator,
  isOrchestratorRunning: () => orchestratorEnabled,
  getOrchestratorSessionId: () => orchestratorSessionId,
  // Team management
  spawnTeamMember,
  createTeam,
  disbandTeam,
  // Auto-coordination
  setupAutoCoordination,
  startDeliveryLoop,
  // Status
  getTeamStatus,
  getMailboxStatus,
  // Events
  events,
};
