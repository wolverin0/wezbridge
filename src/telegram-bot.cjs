#!/usr/bin/env node
/**
 * Telegram Mission Control for WezBridge V2.
 * Creates a Telegram bot that maps Forum Topics to Claude Code sessions.
 *
 * V2 features:
 * - Code diffs + rich output formatting (Phase 1)
 * - Project discovery from ~/.claude/projects/ (Phase 2)
 * - Dynamic buttons based on session state (Phase 3)
 * - Session history + replay + export (Phase 4)
 * - Live dashboard (Phase 5)
 * - Notification intelligence (Phase 6)
 * - ClawTrol task integration (Phase 7)
 * - Plugin system (Phase 8)
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — required (from @BotFather)
 *   TELEGRAM_GROUP_ID    — required (forum group chat ID, negative number)
 *   TELEGRAM_POLL_MS     — optional (completion poll interval, default 3000)
 *   WEZ_BRIDGE_PORT      — optional (starts HTTP server too if set)
 *   WEZBRIDGE_NOTIFY_LEVEL — optional ('all'|'errors'|'none', default 'all')
 *   CLAWTROL_API_URL     — optional (ClawTrol REST API base URL)
 *   CLAWTROL_API_TOKEN   — optional (ClawTrol API token)
 */

const TelegramBot = require('node-telegram-bot-api');
const sm = require('./session-manager.cjs');
const wez = require('./wezterm.cjs');
const outputParser = require('./output-parser.cjs');
const TelegramRateLimiter = require('./telegram-rate-limiter.cjs');
const diffExtractor = require('./diff-extractor.cjs');
const projectScanner = require('./project-scanner.cjs');
const NotificationManager = require('./notification-manager.cjs');
const PluginLoader = require('./plugin-loader.cjs');
const clawtrol = require('./clawtrol-sync.cjs');
const fs = require('fs');
const path = require('path');

// --- State persistence ---
const STATE_FILE = path.join(__dirname, '..', '..', '.wezbridge-state.json');

function saveState() {
  try {
    const state = {
      savedAt: new Date().toISOString(),
      sessions: {},
      topicMappings: {},
    };

    // Save topic mappings
    for (const [sessionId, info] of sessionToTopic) {
      state.topicMappings[sessionId] = info;
    }

    // Save full session data (paneId, project, name, status, history)
    for (const [sessionId] of sessionToTopic) {
      const session = sm.getSession(sessionId);
      const history = sm.getCompletionHistory(sessionId);
      state.sessions[sessionId] = {
        paneId: session?.paneId,
        project: session?.project,
        name: session?.name,
        status: session?.status,
        createdAt: session?.createdAt,
        taskId: session?.taskId,
        completionHistory: history || [],
      };
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[state] Save failed:', err.message);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[state] Load failed:', err.message);
    return null;
  }
}

function restoreState(state) {
  if (!state) return 0;
  let restored = 0;

  // Restore sessions and topic mappings
  for (const [sessionId, data] of Object.entries(state.sessions || {})) {
    if (!data.paneId) continue;

    // Check if the pane still exists in WezTerm
    try {
      wez.getText(data.paneId);
    } catch {
      console.log(`[state] Pane ${data.paneId} no longer exists, skipping ${sessionId}`);
      continue;
    }

    // Re-create session in session manager if it doesn't exist
    let session = sm.getSession(sessionId);
    if (!session) {
      const newSession = {
        id: sessionId,
        paneId: data.paneId,
        project: data.project,
        name: data.name || sessionId,
        status: data.status || 'waiting',
        createdAt: data.createdAt || new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        lastOutput: '',
        promptHistory: [],
        completionHistory: [],
        promptType: null,
        taskId: data.taskId,
      };
      sm._registerSession(newSession);
      session = sm.getSession(sessionId);
    }

    // Restore history
    if (data.completionHistory?.length && session) {
      session.completionHistory = data.completionHistory;
      restored += data.completionHistory.length;
    }
  }

  // Restore topic mappings
  for (const [sessionId, info] of Object.entries(state.topicMappings || {})) {
    const session = sm.getSession(sessionId);
    if (session && info.topicId) {
      sessionToTopic.set(sessionId, info);
      topicToSession.set(info.topicId, sessionId);
      console.log(`[state] Restored mapping: topic ${info.topicId} <-> ${sessionId} (${info.projectName})`);
    }
  }

  return restored;
}

// --- Config ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'REDACTED';
const GROUP_ID = process.env.TELEGRAM_GROUP_ID ? Number(process.env.TELEGRAM_GROUP_ID) : REDACTED_GROUP_ID;
const POLL_MS = parseInt(process.env.TELEGRAM_POLL_MS || '3000', 10);
const THINKING_TIMEOUT_MS = 30000;
const THINKING_UPDATE_MS = 30000;
const NOTIFY_LEVEL = process.env.WEZBRIDGE_NOTIFY_LEVEL || 'all';

if (!TOKEN) { console.error('[telegram] TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!GROUP_ID) { console.error('[telegram] TELEGRAM_GROUP_ID is required'); process.exit(1); }

// --- Project Map (V2: auto-discovered, with optional overrides) ---
const PROJECT_MAP_OVERRIDES = {
  'elbraserito': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/elbraserito',
  'solmiasoc': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/solmiasoc',
  'openclaw2claude': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/openclaw2claude',
  'argentina-sales-hub': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/argentina-sales-hub',
  'douglas-haig': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/douglas-haig',
  'fitflow-pro-connect2': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/fitflow-pro-connect2',
  'gimnasio': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/gimnasio',
  'goodmorning': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/goodmorning/nereidas',
  'lcdc': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/lcdc',
  'mutual': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/mutual',
  'pedrito': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/pedrito',
  'whatsappbot-prod': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/whatsappbot-prod',
  'memorymaster': 'G:/_OneDrive/OneDrive/Desktop/Py Apps/memorymaster',
};

/**
 * Resolve project path: check overrides first, then scan ~/.claude/projects/.
 */
function resolveProjectPath(name) {
  if (PROJECT_MAP_OVERRIDES[name]) return PROJECT_MAP_OVERRIDES[name];
  const projects = projectScanner.scanProjects();
  const match = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  return match ? match.path : null;
}

// --- State ---
const sessionToTopic = new Map();
const topicToSession = new Map();
const thinkingMessages = new Map();

// --- Dashboard state ---
let dashboardMsg = null; // { chatId, messageId, topicId }
let dashboardTimer = null;

// --- Live stream state ---
// Map<sessionId, { lastHash, lastSentAt, messageId }>
const liveStreams = new Map();

// --- Rate limiter ---
const rateLimiter = new TelegramRateLimiter();

// --- Bot init ---
const bot = new TelegramBot(TOKEN, { polling: true });

function sendMsg(chatId, text, opts = {}) {
  return rateLimiter.enqueue(chatId, () =>
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts })
  );
}

function editMsg(chatId, messageId, text, opts = {}) {
  return rateLimiter.enqueue(chatId, () =>
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...opts })
  );
}

function sendDocument(chatId, doc, opts = {}, fileOpts = {}) {
  return rateLimiter.enqueue(chatId, () =>
    bot.sendDocument(chatId, doc, { parse_mode: 'HTML', ...opts }, fileOpts)
  );
}

// --- Notification Manager (Phase 6) ---
const notifier = new NotificationManager({
  sendMsg,
  sendDocument,
  level: NOTIFY_LEVEL,
});

// --- Plugin Loader (Phase 8) ---
const pluginLoader = new PluginLoader();

// --- Dynamic Action Buttons (Phase 3) ---

function actionKeyboard(promptType) {
  if (promptType === 'permission') {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '\u2705 Yes', callback_data: 'action:approve' },
            { text: '\u2705 Always', callback_data: 'action:approve-always' },
            { text: '\u274c No', callback_data: 'action:reject' },
          ],
          [
            { text: 'View Details', callback_data: 'action:status' },
          ],
        ],
      },
    };
  }

  if (promptType === 'continuation') {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Continue', callback_data: 'action:continue' },
            { text: 'Status', callback_data: 'action:status' },
          ],
        ],
      },
    };
  }

  // Default (idle) buttons
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Continue', callback_data: 'action:continue' },
          { text: 'Run Tests', callback_data: 'action:tests' },
        ],
        [
          { text: 'Commit', callback_data: 'action:commit' },
          { text: 'View Diff', callback_data: 'action:diff' },
        ],
        [
          { text: 'Compact', callback_data: 'action:compact' },
          { text: 'Review', callback_data: 'action:review' },
        ],
      ],
    },
  };
}

// --- Thinking timer ---
function startThinkingTimer(sessionId) {
  clearThinkingTimer(sessionId);
  const info = sessionToTopic.get(sessionId);
  if (!info) return;

  const startTime = Date.now();
  const timer = setTimeout(async () => {
    try {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const msg = await sendMsg(info.chatId, `<i>Claude is still working... (${elapsed}s)</i>`, {
        message_thread_id: info.topicId,
      });
      thinkingMessages.set(sessionId, {
        messageId: msg.message_id,
        startTime,
        timer: setInterval(async () => {
          try {
            const el = Math.round((Date.now() - startTime) / 1000);
            await editMsg(info.chatId, msg.message_id, `<i>Claude is still working... (${el}s)</i>`);
          } catch { /* ignore edit errors */ }
        }, THINKING_UPDATE_MS),
      });
    } catch { /* ignore */ }
  }, THINKING_TIMEOUT_MS);

  thinkingMessages.set(sessionId, { messageId: null, timer, startTime });
}

function clearThinkingTimer(sessionId) {
  const thinking = thinkingMessages.get(sessionId);
  if (!thinking) return;
  clearTimeout(thinking.timer);
  clearInterval(thinking.timer);
  thinkingMessages.delete(sessionId);
  return thinking;
}

async function deleteThinkingMessage(sessionId) {
  const thinking = clearThinkingTimer(sessionId);
  if (thinking?.messageId) {
    const info = sessionToTopic.get(sessionId);
    if (info) {
      try { await bot.deleteMessage(info.chatId, thinking.messageId); } catch { /* ignore */ }
    }
  }
}

// ============================================================
// Commands
// ============================================================

async function handleSpawn(msg, match) {
  const chatId = msg.chat.id;
  const args = (match || '').trim().split(/\s+/);
  const projectName = args[0];

  if (!projectName) {
    return sendMsg(chatId, 'Usage: /spawn &lt;project-name&gt; [--continue] [--yolo] [--task TASK-ID]', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const projectPath = resolveProjectPath(projectName);
  if (!projectPath) {
    // Show discovered projects as suggestion
    const discovered = projectScanner.scanProjects().slice(0, 10);
    const list = discovered.map(p => `  <code>${outputParser.escapeHtml(p.name)}</code>`).join('\n');
    return sendMsg(chatId,
      `Unknown project: <b>${outputParser.escapeHtml(projectName)}</b>\n\nDiscovered projects:\n${list}`, {
        message_thread_id: msg.message_thread_id,
      });
  }

  const continueSession = args.includes('--continue');
  const skipPermissions = args.includes('--yolo') || args.includes('--dangerously-skip-permissions');
  const taskIdx = args.indexOf('--task');
  const taskId = taskIdx >= 0 && args[taskIdx + 1] ? args[taskIdx + 1] : null;

  try {
    const topic = await bot.createForumTopic(GROUP_ID, projectName, {
      icon_color: 7322096,
    });
    const topicId = topic.message_thread_id;

    const session = sm.spawnSession({
      project: projectPath,
      name: projectName,
      continueSession,
      dangerouslySkipPermissions: skipPermissions,
      taskId,
    });

    sessionToTopic.set(session.id, { topicId, chatId: GROUP_ID, projectName });
    topicToSession.set(topicId, session.id);

    await sendMsg(GROUP_ID, [
      `<b>Session started</b>`,
      `Project: <code>${outputParser.escapeHtml(projectName)}</code>`,
      `Session: <code>${session.id}</code>`,
      `Pane: ${session.paneId}`,
      continueSession ? 'Mode: --continue' : '',
      skipPermissions ? 'Mode: --yolo (skip permissions)' : '',
      taskId ? `Task: <code>${outputParser.escapeHtml(taskId)}</code>` : '',
    ].filter(Boolean).join('\n'), {
      message_thread_id: topicId,
    });

    // ClawTrol integration (Phase 7)
    if (taskId) {
      clawtrol.claimTask(taskId).catch(() => {});
      clawtrol.postTaskLog(taskId, `WezBridge session ${session.id} started`).catch(() => {});
    }

    if (msg.message_thread_id !== topicId) {
      await sendMsg(chatId, `Session <b>${outputParser.escapeHtml(projectName)}</b> created in its own topic.`, {
        message_thread_id: msg.message_thread_id,
      });
    }
  } catch (err) {
    console.error('[telegram] Spawn error:', err);
    await sendMsg(chatId, `Spawn failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: msg.message_thread_id,
    });
  }
}

async function handleKill(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) return sendMsg(chatId, 'Use /kill inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  try {
    const session = sm.getSession(sessionId);
    sm.killSession(sessionId);
    await deleteThinkingMessage(sessionId);
    sessionToTopic.delete(sessionId);
    topicToSession.delete(topicId);

    // ClawTrol notification
    if (session?.taskId) {
      clawtrol.notifyCompletion(session, 'Session killed by user').catch(() => {});
    }

    await sendMsg(chatId, '<b>Session killed.</b> Topic can be closed manually.', {
      message_thread_id: topicId,
    });
    try { await bot.closeForumTopic(GROUP_ID, topicId); } catch { /* may not have permission */ }
  } catch (err) {
    await sendMsg(chatId, `Kill failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
}

async function handleStatus(msg) {
  const chatId = msg.chat.id;
  const sessions = sm.listSessions();

  if (sessions.length === 0) {
    return sendMsg(chatId, 'No active sessions.', { message_thread_id: msg.message_thread_id });
  }

  const lines = sessions.map(s => {
    const topicInfo = sessionToTopic.get(s.id);
    const name = topicInfo?.projectName || s.name;
    const elapsed = Math.round((Date.now() - new Date(s.createdAt).getTime()) / 60000);
    const statusIcon = s.status === 'running' ? '\u23f3' : s.status === 'waiting' ? '\u2705' : s.status === 'error' ? '\u274c' : '\u23f8';
    return `${statusIcon} <b>${outputParser.escapeHtml(name)}</b> [${s.status}] \u2014 ${elapsed}m \u2014 pane ${s.paneId}`;
  });

  return sendMsg(chatId, lines.join('\n'), { message_thread_id: msg.message_thread_id });
}

// --- Phase 2: Project Discovery ---

async function handleProjects(msg) {
  const chatId = msg.chat.id;

  const projects = projectScanner.scanProjects();
  if (projects.length === 0) {
    return sendMsg(chatId, 'No projects found in ~/.claude/projects/', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const lines = projects.slice(0, 15).map(p => {
    const sessions = p.sessionCount;
    const age = projectScanner.relativeTime(p.lastActive);
    const healthIcon = p.health === 'clean' ? '\u2705' : p.health === 'interrupted' ? '\u26a0' : '\u2796';
    return `${healthIcon} <b>${outputParser.escapeHtml(p.name)}</b> | ${sessions} sessions | ${age}`;
  });

  // Inline buttons for top projects
  const buttons = projects.slice(0, 8).map(p => [{
    text: p.name,
    callback_data: `spawn:${p.name.slice(0, 40)}`,
  }]);

  return sendMsg(chatId, lines.join('\n'), {
    message_thread_id: msg.message_thread_id,
    reply_markup: { inline_keyboard: buttons },
  });
}

// --- Phase 2: Sessions list ---

async function handleSessions(msg, match) {
  const chatId = msg.chat.id;
  const projectName = (match || '').trim();

  if (!projectName) {
    return sendMsg(chatId, 'Usage: /sessions &lt;project-name&gt;', {
      message_thread_id: msg.message_thread_id,
    });
  }

  // Find project directory
  const projects = projectScanner.scanProjects();
  const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
  if (!project) {
    return sendMsg(chatId, `Project not found: ${outputParser.escapeHtml(projectName)}`, {
      message_thread_id: msg.message_thread_id,
    });
  }

  const sessions = projectScanner.scanSessions(project.dir);
  if (sessions.length === 0) {
    return sendMsg(chatId, 'No sessions found.', { message_thread_id: msg.message_thread_id });
  }

  const lines = sessions.slice(0, 8).map(s => {
    const cost = projectScanner.getSessionCost(s.file);
    const dur = projectScanner.formatDuration(s.duration);
    const age = projectScanner.relativeTime(s.modified);
    const healthIcon = s.health === 'clean' ? '\u2705' : s.health === 'interrupted' ? '\u26a0' : '\u2796';
    return `${healthIcon} <code>${s.id.slice(0, 8)}</code> (${dur}, $${cost.costUsd.toFixed(2)}) \u2014 ${age}`;
  });

  return sendMsg(chatId, `<b>${outputParser.escapeHtml(project.name)}</b> sessions:\n\n${lines.join('\n')}`, {
    message_thread_id: msg.message_thread_id,
  });
}

// --- Phase 2: Costs ---

async function handleCosts(msg) {
  const chatId = msg.chat.id;

  const today = projectScanner.getCostSummary('today');
  const week = projectScanner.getCostSummary('week');

  const lines = [
    '<b>Cost Summary</b>',
    '',
    `<b>Today:</b> $${today.totalUsd.toFixed(2)} | ${today.sessionCount} sessions`,
    `  Input: ${formatTokens(today.totalInput)} | Output: ${formatTokens(today.totalOutput)}`,
    '',
    `<b>This week:</b> $${week.totalUsd.toFixed(2)} | ${week.sessionCount} sessions`,
    `  Input: ${formatTokens(week.totalInput)} | Output: ${formatTokens(week.totalOutput)}`,
  ];

  return sendMsg(chatId, lines.join('\n'), { message_thread_id: msg.message_thread_id });
}

function formatTokens(n) {
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

// --- Phase 4: History ---

async function handleHistory(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;
  if (!topicId) return sendMsg(chatId, 'Use /history inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const history = sm.getCompletionHistory(sessionId);
  if (history.length === 0) {
    return sendMsg(chatId, '<i>No history yet.</i>', { message_thread_id: topicId });
  }

  const entries = history.slice(-5).map((h, i) => {
    const promptShort = h.prompt ? h.prompt.slice(0, 80) : '[button action]';
    const responseShort = h.response ? h.response.slice(0, 120) : '[no output]';
    const diff = h.diffStat ? `\n  \ud83d\udcc4 ${h.diffStat}` : '';
    return `<b>${i + 1}.</b> <code>&gt;</code> ${outputParser.escapeHtml(promptShort)}\n   ${outputParser.escapeHtml(responseShort)}${diff}`;
  });

  return sendMsg(chatId, entries.join('\n\n'), { message_thread_id: topicId });
}

// --- Phase 4: Replay ---

async function handleReplay(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;
  if (!topicId) return sendMsg(chatId, 'Use /replay inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const history = sm.getCompletionHistory(sessionId);
  if (history.length === 0) {
    return sendMsg(chatId, '<i>No history to replay.</i>', { message_thread_id: topicId });
  }

  const last = history[history.length - 1];
  const html = outputParser.formatForTelegram(
    outputParser.summarizeIfLong(last.response, 3000)
  );

  return sendMsg(chatId, html || '<i>Empty response</i>', { message_thread_id: topicId });
}

// --- Phase 4: Export ---

async function handleExport(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;
  if (!topicId) return sendMsg(chatId, 'Use /export inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const history = sm.getCompletionHistory(sessionId);
  const info = sessionToTopic.get(sessionId);
  const projectName = info?.projectName || 'session';

  if (history.length === 0) {
    return sendMsg(chatId, '<i>No history to export.</i>', { message_thread_id: topicId });
  }

  const lines = [`# ${projectName} - Session Export\n`, `Generated: ${new Date().toISOString()}\n`];
  for (const h of history) {
    lines.push(`## Prompt\n\n${h.prompt || '[button action]'}\n`);
    lines.push(`## Response\n\n${h.response || '[no output]'}\n`);
    if (h.diffStat) lines.push(`**Changes:** ${h.diffStat}\n`);
    lines.push('---\n');
  }

  const content = lines.join('\n');
  const buf = Buffer.from(content, 'utf-8');

  try {
    await sendDocument(chatId, buf, {
      message_thread_id: topicId,
      caption: `Session export: ${history.length} exchanges`,
    }, {
      filename: `${projectName}-${sessionId}.md`,
      contentType: 'text/markdown',
    });
  } catch (err) {
    await sendMsg(chatId, `Export failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
}

// --- Phase 5: Dashboard ---

async function handleDashboard(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  const text = buildDashboardText();
  const sent = await sendMsg(chatId, text, { message_thread_id: topicId });

  // Pin the message
  try {
    await bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
  } catch { /* may not have permission */ }

  // Store for auto-update
  dashboardMsg = { chatId, messageId: sent.message_id, topicId };

  // Start auto-update if not already running
  if (!dashboardTimer) {
    dashboardTimer = setInterval(() => updateDashboard(), 30000);
  }
}

function buildDashboardText() {
  const sessions = sm.listSessions();
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  if (sessions.length === 0) {
    return `<b>Dashboard</b>\n\nNo active sessions.\n\n<i>Updated ${timeStr}</i>`;
  }

  const lines = sessions.map(s => {
    const info = sessionToTopic.get(s.id);
    const name = info?.projectName || s.name;
    const elapsed = Math.round((Date.now() - new Date(s.lastActivity || s.createdAt).getTime()) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;
    const icon = s.status === 'running' ? '\u23f3' : s.status === 'waiting' ? '\u2705' : s.status === 'error' ? '\u274c' : '\u23f8';
    return `${icon} <b>${outputParser.escapeHtml(name)}</b> \u2014 ${s.status} ${elapsedStr} \u2014 pane ${s.paneId}`;
  });

  const running = sessions.filter(s => s.status === 'running').length;
  const waiting = sessions.filter(s => s.status === 'waiting').length;

  lines.push('');
  lines.push(`<i>${sessions.length} sessions | ${running} working | ${waiting} idle | Updated ${timeStr}</i>`);

  return `<b>Dashboard</b>\n\n${lines.join('\n')}`;
}

async function updateDashboard() {
  if (!dashboardMsg) return;
  try {
    const text = buildDashboardText();
    await editMsg(dashboardMsg.chatId, dashboardMsg.messageId, text);
  } catch (err) {
    // If edit fails (message deleted, etc.), stop updating
    if (err.message?.includes('message is not modified') || err.message?.includes('message to edit not found')) {
      // Ignore "not modified" errors
      if (err.message?.includes('message to edit not found')) {
        dashboardMsg = null;
        if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
      }
    }
  }
}

// --- Phase 7: Task command ---

async function handleTask(msg, match) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;
  const args = (match || '').trim();

  if (!topicId) return sendMsg(chatId, 'Use /task inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  const session = sessionId ? sm.getSession(sessionId) : null;

  if (args.startsWith('link ') && session) {
    // Link task to session
    const taskId = args.slice(5).trim();
    session.taskId = taskId;
    await clawtrol.claimTask(taskId).catch(() => {});
    return sendMsg(chatId, `Linked task <code>${outputParser.escapeHtml(taskId)}</code> to this session.`, {
      message_thread_id: topicId,
    });
  }

  if (session?.taskId) {
    // Show task info
    try {
      const res = await clawtrol.clawtrolRequest('GET', `/tasks/${session.taskId}`);
      if (res.status === 200 && res.data) {
        const t = res.data;
        return sendMsg(chatId, [
          `<b>Task: ${outputParser.escapeHtml(t.title || t.id || session.taskId)}</b>`,
          `Status: ${t.status || 'unknown'}`,
          t.description ? `Description: ${outputParser.escapeHtml(t.description.slice(0, 200))}` : '',
        ].filter(Boolean).join('\n'), { message_thread_id: topicId });
      }
    } catch { /* fallthrough */ }
    return sendMsg(chatId, `Task <code>${outputParser.escapeHtml(session.taskId)}</code> (ClawTrol unreachable)`, {
      message_thread_id: topicId,
    });
  }

  return sendMsg(chatId, 'No task linked. Use /task link &lt;TASK-ID&gt;', { message_thread_id: topicId });
}

// --- /peek — show current terminal state ---

async function handlePeek(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) return sendMsg(chatId, 'Use /peek inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const session = sm.getSession(sessionId);
  if (!session) return sendMsg(chatId, 'Session not found.', { message_thread_id: topicId });

  try {
    // Read the last ~60 lines from terminal scrollback
    const raw = wez.getFullText(session.paneId, 60);
    const clean = outputParser.stripAnsi(raw);
    const stripped = outputParser.stripClaudeChrome(clean);
    const lines = stripped.split('\n').filter(l => l.trim());

    // Take last 40 meaningful lines
    const visible = lines.slice(-40).join('\n');

    if (!visible.trim()) {
      return sendMsg(chatId, '<i>Terminal is empty or not readable.</i>', { message_thread_id: topicId });
    }

    // Determine status
    const isWorking = session.status === 'running';
    const elapsed = Math.round((Date.now() - new Date(session.lastActivity || session.createdAt).getTime()) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;
    const statusIcon = isWorking ? '\u23f3 Working' : session.status === 'waiting' ? '\u2705 Idle' : session.status === 'error' ? '\u274c Error' : '\u23f8 ' + session.status;

    // Format the peek
    const header = `<b>Peek: ${outputParser.escapeHtml(session.name)}</b> \u2014 ${statusIcon} (${elapsedStr})`;
    const body = outputParser.escapeHtml(visible.slice(-2500));

    const html = `${header}\n\n<pre>${body}</pre>`;

    if (html.length > 4000) {
      // Too long — send as document + short summary
      const lastFewLines = lines.slice(-8).join('\n');
      await sendMsg(chatId, `${header}\n\n<pre>${outputParser.escapeHtml(lastFewLines.slice(-800))}</pre>`, {
        message_thread_id: topicId,
      });
      const buf = Buffer.from(visible, 'utf-8');
      await sendDocument(chatId, buf, {
        message_thread_id: topicId,
        caption: 'Full terminal output',
      }, {
        filename: `peek-${session.name}.txt`,
        contentType: 'text/plain',
      });
    } else {
      await sendMsg(chatId, html, { message_thread_id: topicId });
    }
  } catch (err) {
    await sendMsg(chatId, `Peek failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
}

// --- /dump — full terminal scrollback as .md document ---

async function handleDump(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) return sendMsg(chatId, 'Use /dump inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const session = sm.getSession(sessionId);
  if (!session) return sendMsg(chatId, 'Session not found.', { message_thread_id: topicId });

  try {
    const raw = wez.getFullText(session.paneId, 500);
    const clean = outputParser.stripAnsi(raw);
    const stripped = outputParser.stripClaudeChrome(clean);

    if (!stripped.trim()) {
      // Terminal blank (likely after compaction) — try pre-compaction snapshot
      if (session._preCompactionSnapshot) {
        const snapClean = outputParser.stripAnsi(session._preCompactionSnapshot);
        const snapStripped = outputParser.stripClaudeChrome(snapClean);
        if (snapStripped.trim()) {
          const snapBuf = Buffer.from(snapStripped, 'utf-8');
          return sendDocument(chatId, snapBuf, {
            message_thread_id: topicId,
            caption: `Pre-compaction snapshot (${snapStripped.length} chars, ~${snapStripped.split('\n').length} lines)`,
          }, {
            filename: `${session.name}-precompact-${Date.now()}.md`,
            contentType: 'text/markdown',
          });
        }
      }
      return sendMsg(chatId, '<i>Terminal is empty.</i>', { message_thread_id: topicId });
    }

    const buf = Buffer.from(stripped, 'utf-8');
    await sendDocument(chatId, buf, {
      message_thread_id: topicId,
      caption: `Full terminal dump (${stripped.length} chars, ~${stripped.split('\n').length} lines)`,
    }, {
      filename: `${session.name}-dump-${Date.now()}.md`,
      contentType: 'text/markdown',
    });
  } catch (err) {
    await sendMsg(chatId, `Dump failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
}

// --- /live — toggle real-time terminal streaming ---

const LIVE_MIN_INTERVAL_MS = 5000; // Min 5s between updates
const LIVE_LINES = 35; // Lines to show per update

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

async function handleLive(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) return sendMsg(chatId, 'Use /live inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const session = sm.getSession(sessionId);
  if (!session) return sendMsg(chatId, 'Session not found.', { message_thread_id: topicId });

  // Toggle
  if (liveStreams.has(sessionId)) {
    liveStreams.delete(sessionId);
    return sendMsg(chatId, '<b>Live stream OFF</b> for ' + outputParser.escapeHtml(session.name), {
      message_thread_id: topicId,
    });
  }

  liveStreams.set(sessionId, { lastHash: 0, lastSentAt: 0, messageId: null });
  return sendMsg(chatId, '<b>Live stream ON</b> \u2014 terminal updates will appear here in near real-time.\nUse /live again to stop.', {
    message_thread_id: topicId,
  });
}

/**
 * Format terminal lines with rich HTML styling for live view.
 * Highlights tool calls, results, bullets, and code blocks.
 */
function formatLiveLines(lines) {
  const esc = outputParser.escapeHtml;
  const formatted = lines.map(line => {
    const trimmed = line.trim();
    // Tool calls (● Tool Name(...))
    if (/^[●•]\s/.test(trimmed) && /\(.*\)/.test(trimmed)) {
      return `\u{1F527} <b>${esc(trimmed.slice(2))}</b>`;
    }
    // Bullet points (regular ● text)
    if (/^[●•]\s/.test(trimmed)) {
      return `\u25CF ${esc(trimmed.slice(2))}`;
    }
    // Result/output lines (⎿ or └)
    if (/^[⎿└├│┃|]\s*/.test(trimmed)) {
      return `  <code>${esc(trimmed)}</code>`;
    }
    // Claude thinking/status
    if (/^(Thinking|Choreographing|Brewed|Running)/i.test(trimmed)) {
      return `\u23f3 <i>${esc(trimmed)}</i>`;
    }
    // Prompt line (❯ or >)
    if (/^[❯>]\s*$/.test(trimmed)) {
      return `<b>\u276F</b> <i>waiting for input</i>`;
    }
    // Permission prompts
    if (/Do you want|❯\s*1\.\s*Yes|\(y\/n\)/i.test(trimmed)) {
      return `\u{1F6A8} <b>${esc(trimmed)}</b>`;
    }
    // Indented code/output
    if (line.startsWith('    ') || line.startsWith('\t')) {
      return `<code>${esc(line)}</code>`;
    }
    // Default
    return esc(line);
  });
  return formatted.join('\n');
}

/**
 * Called from the poll loop for each running session with live mode on.
 * Sends a peek-style snapshot if the terminal output changed.
 */
async function processLiveStream(sessionId) {
  const stream = liveStreams.get(sessionId);
  if (!stream) return;

  const now = Date.now();
  if (now - stream.lastSentAt < LIVE_MIN_INTERVAL_MS) return;

  const session = sm.getSession(sessionId);
  if (!session) { liveStreams.delete(sessionId); return; }

  const info = sessionToTopic.get(sessionId);
  if (!info) return;

  try {
    const raw = wez.getFullText(session.paneId, LIVE_LINES + 10);
    const clean = outputParser.stripAnsi(raw);
    // Extra sanitization: remove any surviving control chars (except \n\t)
    const sanitized = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    const stripped = outputParser.stripClaudeChrome(sanitized);
    // Preserve spacing: keep empty lines, add breathing room before tool calls (●)
    const rawLines = stripped.split('\n');
    const lines = [];
    let emptyRun = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i];
      if (!l.trim()) {
        emptyRun++;
        if (emptyRun <= 1) lines.push('');
      } else {
        // Add empty line before tool calls / bullet points if previous line wasn't empty
        if (/^[●•]/.test(l.trim()) && lines.length > 0 && lines[lines.length - 1]?.trim()) {
          lines.push('');
        }
        emptyRun = 0;
        lines.push(l);
      }
    }
    const visible = lines.slice(-LIVE_LINES).join('\n');

    // If terminal is blank (post-compaction), show a brief notice instead of empty screen
    if (!visible.trim()) {
      const blankHash = 'blank';
      if (stream.lastHash === blankHash) return;
      stream.lastHash = blankHash;
      stream.lastSentAt = now;
      const blankMsg = `<b>\u{1F534} LIVE: ${outputParser.escapeHtml(session.name)}</b>\n\n<i>Terminal cleared (compaction). Waiting for new output...</i>`;
      if (stream.messageId) {
        try { await sendOrEdit(info.chatId, blankMsg, info.topicId, stream.messageId); } catch {}
      }
      return;
    }

    const hash = simpleHash(visible);
    if (hash === stream.lastHash) return; // No change

    stream.lastHash = hash;
    stream.lastSentAt = now;

    const elapsed = Math.round((now - new Date(session.lastActivity || session.createdAt).getTime()) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;
    const header = `<b>\u{1F534} LIVE: ${outputParser.escapeHtml(session.name)}</b> (${elapsedStr})\n\n`;

    // Build <pre> HTML, trim lines until fits 4096
    let showLines = lines.slice(-LIVE_LINES);
    let html = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = outputParser.escapeHtml(showLines.join('\n'));
      html = `${header}<pre>${body}</pre>`;
      if (html.length <= 4050) break;
      showLines = showLines.slice(Math.ceil(showLines.length * 0.2));
    }
    if (html.length > 4050) {
      const body = outputParser.escapeHtml(showLines.slice(-15).join('\n'));
      html = `${header}<pre>${body}</pre>`;
    }

    // Try edit, then send, with plain-text fallback on HTML parse failure
    const sendOrEdit = async (text, opts) => {
      try {
        if (stream.messageId) {
          await editMsg(info.chatId, stream.messageId, text, opts);
          return stream.messageId;
        }
      } catch { stream.messageId = null; }
      try {
        const sent = await sendMsg(info.chatId, text, opts);
        return sent?.message_id;
      } catch (e) {
        // HTML parse failed — strip tags and send plain
        if (e.message && e.message.includes('parse entities')) {
          const plain = text.replace(/<[^>]+>/g, '');
          const sent = await rateLimiter.enqueue(info.chatId, () =>
            bot.sendMessage(info.chatId, plain.slice(0, 4096), { message_thread_id: opts.message_thread_id })
          );
          return sent?.message_id;
        }
        throw e;
      }
    };

    const msgId = await sendOrEdit(html, { message_thread_id: info.topicId });
    if (msgId) stream.messageId = msgId;
  } catch (err) {
    console.log(`[live] Error streaming ${sessionId}: ${err.message}`);
  }
}

// --- /reconnect — re-sync with a running terminal session ---

async function handleReconnect(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) return sendMsg(chatId, 'Use /reconnect inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });

  const session = sm.getSession(sessionId);
  if (!session) return sendMsg(chatId, 'Session not found.', { message_thread_id: topicId });

  try {
    // Force re-read the terminal
    const raw = wez.getFullText(session.paneId, 500);
    const response = outputParser.extractLastResponse(raw);
    const lines = outputParser.stripAnsi(raw).split('\n').filter(l => l.trim());
    const lastLines = lines.slice(-15).join('\n');

    // Reset stability state so polling starts fresh from this point
    session._stabilityCount = 0;
    session._lastScrollbackHash = null;
    session._compactionAt = null;
    session.promptSentAt = null; // Don't block the 8s cooldown
    session.status = 'running'; // Force back to running so pollAll picks it up

    // Quick check: is it currently idle or working?
    const quickCheck = sm.checkCompletion(sessionId);
    const isIdle = quickCheck.waiting;

    const statusIcon = isIdle ? '\u2705 Idle' : '\u23f3 Working';
    const elapsed = Math.round((Date.now() - new Date(session.lastActivity || session.createdAt).getTime()) / 1000);
    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;

    // Send status + latest output
    const header = `<b>Reconnected: ${outputParser.escapeHtml(session.name)}</b> \u2014 ${statusIcon} (${elapsedStr})\nPane: ${session.paneId}`;

    if (response) {
      // Format and send last response (don't split — blockquote tags break)
      const html = outputParser.formatForTelegram(response, 3500);
      await sendMsg(chatId, header, { message_thread_id: topicId });
      await sendMsg(chatId, html, {
        message_thread_id: topicId,
        ...(isIdle ? actionKeyboard(session.promptType) : {}),
      });

      // Send as document if long
      if (outputParser.wasResponseTruncated(response)) {
        const buf = Buffer.from(response, 'utf-8');
        await sendDocument(chatId, buf, {
          message_thread_id: topicId,
          caption: `Full response (${response.length} chars)`,
        }, {
          filename: `${session.name}-reconnect.md`,
          contentType: 'text/markdown',
        }).catch(() => {});
      }

      // Record in history
      sm.addCompletionHistory(session.id, {
        prompt: '[reconnect]',
        response: response.slice(0, 500),
      });
      saveState();
    } else {
      await sendMsg(chatId, `${header}\n\n<i>No response detected in scrollback.</i>`, {
        message_thread_id: topicId,
        ...(isIdle ? actionKeyboard(session.promptType) : {}),
      });
    }

    if (!isIdle) {
      startThinkingTimer(sessionId);
      await sendMsg(chatId, '<i>Session is still working \u2014 I\'ll notify you when it completes.</i>', {
        message_thread_id: topicId,
      });
    }
  } catch (err) {
    await sendMsg(chatId, `Reconnect failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
}

async function handleHelp(msg) {
  return sendMsg(msg.chat.id, [
    '<b>WezBridge V2 Mission Control</b>',
    '',
    '<b>Session commands:</b>',
    '/spawn &lt;project&gt; [--continue] [--yolo] [--task ID] \u2014 Start session',
    '/kill \u2014 Kill session (in topic)',
    '/status \u2014 List all active sessions',
    '',
    '<b>Project discovery:</b>',
    '/projects \u2014 Browse all Claude projects',
    '/sessions &lt;project&gt; \u2014 List sessions for a project',
    '/costs \u2014 Token/cost summary',
    '',
    '<b>Session tools (in topic):</b>',
    '/peek \u2014 See current terminal state',
    '/reconnect \u2014 Re-sync session after working on PC',
    '/live \u2014 Toggle real-time terminal stream',
    '/dump \u2014 Full terminal output as .md file',
    '/history \u2014 Last 5 prompt/response pairs',
    '/replay \u2014 Re-send last response',
    '/export \u2014 Export history as markdown',
    '/task [link ID] \u2014 View/link ClawTrol task',
    '',
    '<b>Dashboard:</b>',
    '/dashboard \u2014 Pinned live status',
    '',
    'Type in a topic to send prompts. Use buttons for quick actions.',
  ].join('\n'), { message_thread_id: msg.message_thread_id });
}

// --- Register commands ---
bot.onText(/\/spawn\s*(.*)/, (msg, match) => handleSpawn(msg, match[1]));
bot.onText(/\/kill$/, (msg) => handleKill(msg));
bot.onText(/\/status$/, (msg) => handleStatus(msg));
bot.onText(/\/projects$/, (msg) => handleProjects(msg));
bot.onText(/\/sessions\s+(.+)/, (msg, match) => handleSessions(msg, match[1]));
bot.onText(/\/costs$/, (msg) => handleCosts(msg));
bot.onText(/\/history$/, (msg) => handleHistory(msg));
bot.onText(/\/replay$/, (msg) => handleReplay(msg));
bot.onText(/\/export$/, (msg) => handleExport(msg));
bot.onText(/\/dashboard$/, (msg) => handleDashboard(msg));
bot.onText(/\/peek$/, (msg) => handlePeek(msg));
bot.onText(/\/reconnect$/, (msg) => handleReconnect(msg));
bot.onText(/\/live$/, (msg) => handleLive(msg));
bot.onText(/\/dump$/, (msg) => handleDump(msg));
bot.onText(/\/task\s*(.*)/, (msg, match) => handleTask(msg, match[1]));
bot.onText(/\/help$/, (msg) => handleHelp(msg));
bot.onText(/\/start$/, (msg) => handleHelp(msg));

// --- Message handler: text/photo/document in topic → inject as prompt ---
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  // Ignore bot's own messages
  if (msg.from && msg.from.is_bot) return;
  // Must have text, photo, or document
  if (!msg.text && !msg.caption && !msg.photo && !msg.document) return;

  const topicId = msg.message_thread_id;
  if (!topicId) return;

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return;

  const session = sm.getSession(sessionId);
  if (!session) return;

  try {
    let promptText = msg.text || msg.caption || '';

    // Handle photo attachments — download and pass file path to Claude
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]; // highest resolution
      const fileInfo = await bot.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

      // Download to temp
      const os = require('os');
      const https = require('https');
      const tempDir = path.join(os.tmpdir(), 'wezbridge');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const ext = path.extname(fileInfo.file_path) || '.jpg';
      const localPath = path.join(tempDir, `telegram-${Date.now()}${ext}`);

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        https.get(url, (res) => {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });

      // Add image path to prompt
      promptText = `${promptText}\n\n[Image attached: ${localPath}]`.trim();
      console.log(`[telegram] Photo saved: ${localPath}`);
    }

    // Handle document attachments
    if (msg.document) {
      const fileInfo = await bot.getFile(msg.document.file_id);
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

      const os = require('os');
      const https = require('https');
      const tempDir = path.join(os.tmpdir(), 'wezbridge');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const fileName = msg.document.file_name || `file-${Date.now()}`;
      const localPath = path.join(tempDir, fileName);

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        https.get(url, (res) => {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });

      promptText = `${promptText}\n\n[File attached: ${localPath}]`.trim();
      console.log(`[telegram] Document saved: ${localPath}`);
    }

    if (!promptText) return;

    sm.sendPrompt(sessionId, promptText);
    // Only show thinking timer if live mode is off
    if (!liveStreams.has(sessionId)) {
      startThinkingTimer(sessionId);
    }
    // Auto-delete "Sent" ack after 5 seconds
    const ack = msg.photo ? 'Photo sent' : msg.document ? 'File sent' : '\u2705';
    bot.sendMessage(msg.chat.id, `<i>${ack}</i>`, {
      parse_mode: 'HTML',
      message_thread_id: topicId,
      reply_to_message_id: msg.message_id,
    }).then(sent => {
      setTimeout(() => {
        bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {});
      }, 5000);
    }).catch(() => {});
  } catch (err) {
    sendMsg(msg.chat.id, `Failed to send: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
});

// --- Callback (button) handler ---
bot.on('callback_query', async (query) => {
  const topicId = query.message?.message_thread_id;
  const data = query.data || '';

  // Handle spawn from /projects button
  if (data.startsWith('spawn:')) {
    const projectName = data.slice(6);
    await bot.answerCallbackQuery(query.id, { text: `Spawning ${projectName} (yolo)...` });
    return handleSpawn(query.message, `${projectName} --continue --yolo`);
  }

  // Check plugin handlers first
  if (pluginLoader.handleButton(data, query)) {
    return bot.answerCallbackQuery(query.id);
  }

  if (!topicId) {
    return bot.answerCallbackQuery(query.id, { text: 'No topic context' });
  }

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) {
    return bot.answerCallbackQuery(query.id, { text: 'No session for this topic' });
  }

  const session = sm.getSession(sessionId);
  let promptText = '';

  switch (data) {
    case 'action:continue':
      wez.sendText(session.paneId, '');
      break;
    case 'action:approve': {
      // Detect prompt format from last output
      const approveText = session.lastOutput || '';
      const isNumbered = /❯\s*1\.\s*Yes/i.test(approveText);
      if (isNumbered) {
        // Interactive selector — Enter selects highlighted "1. Yes"
        wez.sendText(session.paneId, '');
      } else {
        wez.sendText(session.paneId, 'y');
      }
      promptText = 'approved (Yes)';
      break;
    }
    case 'action:approve-always': {
      const alwaysText = session.lastOutput || '';
      const isNumbered = /❯\s*1\.\s*Yes/i.test(alwaysText);
      const hasAlwaysOption = /allow all|always/i.test(alwaysText);
      if (isNumbered && hasAlwaysOption) {
        // "2. Yes, allow all" — one down-arrow then Enter
        wez.sendTextNoEnter(session.paneId, '\x1b[B');
        setTimeout(() => wez.sendText(session.paneId, ''), 200);
      } else if (hasAlwaysOption) {
        wez.sendText(session.paneId, '!');
      } else {
        // No always option — just approve
        wez.sendText(session.paneId, '');
      }
      promptText = 'allow all edits';
      break;
    }
    case 'action:reject': {
      const rejectText = session.lastOutput || '';
      const isNumbered = /❯\s*1\.\s*Yes/i.test(rejectText);
      const hasThreeOptions = /3\.\s*No/i.test(rejectText);
      if (isNumbered) {
        // Navigate to "No" — 2 down-arrows if 3 options, 1 if 2 options
        const downs = hasThreeOptions ? 2 : 1;
        for (let i = 0; i < downs; i++) {
          wez.sendTextNoEnter(session.paneId, '\x1b[B');
        }
        setTimeout(() => wez.sendText(session.paneId, ''), 300);
      } else {
        wez.sendText(session.paneId, 'n');
      }
      promptText = 'n (rejected)';
      break;
    }
    case 'action:tests':
      promptText = 'run the tests';
      sm.sendPrompt(sessionId, promptText);
      break;
    case 'action:commit':
      promptText = '/commit';
      sm.sendPrompt(sessionId, promptText);
      break;
    case 'action:compact':
      promptText = '/compact';
      sm.sendPrompt(sessionId, promptText);
      break;
    case 'action:review':
      promptText = 'review the changes you just made';
      sm.sendPrompt(sessionId, promptText);
      break;
    case 'action:diff':
      // Show git diff for this session's project
      try {
        const diffStat = diffExtractor.getGitDiffStat(session.project);
        if (diffStat) {
          const formatted = diffExtractor.formatDiffForTelegram(diffStat);
          await sendMsg(query.message.chat.id, formatted, { message_thread_id: topicId });
        } else {
          await sendMsg(query.message.chat.id, '<i>No uncommitted changes.</i>', { message_thread_id: topicId });
        }
      } catch (err) {
        await sendMsg(query.message.chat.id, `Diff error: ${outputParser.escapeHtml(err.message)}`, { message_thread_id: topicId });
      }
      return bot.answerCallbackQuery(query.id, { text: 'Diff shown' });
    case 'action:status':
      try {
        const raw = sm.readOutput(sessionId);
        const response = outputParser.extractLastResponse(raw);
        const formatted = outputParser.formatForTelegram(
          outputParser.summarizeIfLong(response, 2000)
        );
        await sendMsg(query.message.chat.id, formatted || '<i>No output yet</i>', {
          message_thread_id: topicId,
        });
      } catch (err) {
        await sendMsg(query.message.chat.id, `Error: ${outputParser.escapeHtml(err.message)}`, {
          message_thread_id: topicId,
        });
      }
      return bot.answerCallbackQuery(query.id, { text: 'Status shown' });
    default:
      return bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
  }

  if (data !== 'action:status' && data !== 'action:diff') {
    // Remove buttons from the clicked message (prevent stacking)
    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
    } catch { /* ignore if message too old */ }

    // Reset session to running so pollAll picks it up again
    session.status = 'running';
    session.promptSentAt = Date.now();
    session._stabilityCount = 0;
    session._lastScrollbackHash = null;
    session._compactionAt = null;

    // Only show thinking timer if live mode is off
    if (!liveStreams.has(sessionId)) {
      startThinkingTimer(sessionId);
    }
    await bot.answerCallbackQuery(query.id, {
      text: promptText ? `Sent: "${promptText}"` : 'Sent Enter',
    });
  }
});

// ============================================================
// Completion poll loop (Phase 1: diffs, Phase 3: dynamic buttons)
// ============================================================

let completionTimer = null;

function startCompletionLoop() {
  if (completionTimer) return;
  completionTimer = setInterval(async () => {
    const allSessions = sm.listSessions();
    if (allSessions.length === 0) return;

    // Process live streams for running sessions (before pollAll changes status)
    for (const [sid] of liveStreams) {
      const s = sm.getSession(sid);
      if (s) {
        processLiveStream(sid).catch(() => {});
      }
    }

    const newlyWaiting = sm.pollAll();
    if (newlyWaiting.length > 0) {
      console.log(`[telegram] Poll: ${newlyWaiting.length} session(s) completed`);
    }

    for (const session of newlyWaiting) {
      const info = sessionToTopic.get(session.id);
      if (!info) {
        console.log(`[telegram] No topic mapping for session ${session.id}`);
        continue;
      }

      try {
        await deleteThinkingMessage(session.id);

        // Get Claude's response
        const raw = wez.getFullText(session.paneId, 500);
        const response = outputParser.extractLastResponse(raw);

        if (!response) {
          await sendMsg(info.chatId, '<i>Claude finished (no output detected)</i>', {
            message_thread_id: info.topicId,
            ...actionKeyboard(session.promptType),
          });
          continue;
        }

        // Detect output type for smart formatting
        const outputType = outputParser.detectOutputType(response);

        // Format with expandable blockquotes for long content
        let html;
        if (outputType === 'test-results') {
          const testSummary = outputParser.formatTestResults(response);
          html = testSummary + '\n\n' + outputParser.formatForTelegram(response);
        } else if (outputType === 'error') {
          html = outputParser.formatStackTrace(response);
        } else {
          html = outputParser.formatForTelegram(response);
        }

        // Send response (Message 1) — single message, blockquote handles truncation
        await sendMsg(info.chatId, html, {
          message_thread_id: info.topicId,
          ...actionKeyboard(session.promptType),
        });

        // If response was truncated, send full text as document
        if (outputParser.wasResponseTruncated(response)) {
          const fullBuf = Buffer.from(response, 'utf-8');
          try {
            await sendDocument(info.chatId, fullBuf, {
              message_thread_id: info.topicId,
              caption: `Full response (${response.length} chars)`,
            }, {
              filename: `${info.projectName}-response.md`,
              contentType: 'text/markdown',
            });
          } catch { /* ignore */ }
        }

        // Phase 1: Check git diff and send as Message 2
        const liveSession = sm.getSession(session.id);
        if (liveSession?.project) {
          const diffStat = diffExtractor.getGitDiffStat(liveSession.project);
          if (diffStat && diffStat.files.length > 0) {
            const diffFormatted = diffExtractor.formatDiffForTelegram(diffStat);

            // Check if diff is too large — send as document
            const fullDiff = diffExtractor.getGitDiff(liveSession.project, 8000);
            if (fullDiff && fullDiff.length > 4096) {
              // Send stat summary as message
              await sendMsg(info.chatId, diffFormatted, { message_thread_id: info.topicId });
              // Send full diff as document
              const diffBuf = Buffer.from(fullDiff, 'utf-8');
              try {
                await sendDocument(info.chatId, diffBuf, {
                  message_thread_id: info.topicId,
                  caption: diffStat.summary,
                }, {
                  filename: `${info.projectName}-diff.diff`,
                  contentType: 'text/plain',
                });
              } catch { /* ignore document send failures */ }
            } else {
              await sendMsg(info.chatId, diffFormatted, { message_thread_id: info.topicId });
            }

            // Store diff stat in history
            sm.addCompletionHistory(session.id, {
              prompt: session.promptHistory?.[session.promptHistory.length - 1]?.prompt || '',
              response: response.slice(0, 500),
              diffStat: diffStat.summary,
            });
          } else {
            // No diff — still store history
            sm.addCompletionHistory(session.id, {
              prompt: session.promptHistory?.[session.promptHistory.length - 1]?.prompt || '',
              response: response.slice(0, 500),
            });
          }
        } else {
          sm.addCompletionHistory(session.id, {
            prompt: session.promptHistory?.[session.promptHistory.length - 1]?.prompt || '',
            response: response.slice(0, 500),
          });
        }

        // Persist state after recording history
        saveState();

        // Phase 7: ClawTrol notification
        if (liveSession?.taskId) {
          clawtrol.notifyWaiting(liveSession, response.slice(-300)).catch(() => {});
          clawtrol.postTaskLog(liveSession.taskId, `Response received (${response.length} chars)`).catch(() => {});
        }

        // Recent commits (optional, for context)
        if (liveSession?.project) {
          const commits = diffExtractor.getRecentCommits(liveSession.project, 1);
          if (commits.length > 0 && commits[0].date?.includes('second') || commits[0]?.date?.includes('minute')) {
            // A very recent commit was made — notify
            const c = commits[0];
            await sendMsg(info.chatId, `\ud83d\udcdd Recent commit: <code>${outputParser.escapeHtml(c.hash)}</code> ${outputParser.escapeHtml(c.message)}`, {
              message_thread_id: info.topicId,
            });
          }
        }
      } catch (err) {
        console.error(`[telegram] Error sending response for ${session.id}:`, err.message || err);
      }
      console.log(`[telegram] Response sent for ${session.id} to topic ${info.topicId}`);
    }
  }, POLL_MS);
}

/**
 * Split a message into chunks, trying to break at newlines.
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf('\n', maxLen);
    if (breakAt < maxLen * 0.5) {
      breakAt = maxLen;
    }

    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }

  return chunks;
}

// --- Seed existing sessions from CLI args ---
function seedFromArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seed' && args[i + 1]) {
      const parts = args[i + 1].split(':');
      if (parts.length >= 2) {
        const topicId = parseInt(parts[0], 10);
        const paneId = parseInt(parts[1], 10);
        const projectName = parts[2] || `pane-${paneId}`;

        const sessionId = `wez-seed-${paneId}`;
        const session = {
          id: sessionId,
          name: projectName,
          paneId,
          project: resolveProjectPath(projectName) || projectName,
          taskId: null,
          status: 'waiting',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          lastOutput: '',
          promptHistory: [],
          completionHistory: [],
          promptType: null,
        };
        sm._registerSession(session);

        sessionToTopic.set(sessionId, { topicId, chatId: GROUP_ID, projectName });
        topicToSession.set(topicId, sessionId);
        console.log(`[telegram] Seeded: topic ${topicId} <-> pane ${paneId} (${projectName})`);
      }
      i++;
    }
  }
}

// --- Startup ---
function startBot() {
  console.log('[telegram] WezBridge V2 starting...');
  console.log(`[telegram] Group ID: ${GROUP_ID}`);
  console.log(`[telegram] Poll interval: ${POLL_MS}ms`);
  console.log(`[telegram] Notification level: ${NOTIFY_LEVEL}`);

  // Load plugins
  const loadedPlugins = pluginLoader.loadAll({
    sendMsg,
    sessionManager: sm,
    wezterm: wez,
    bot,
  });
  if (loadedPlugins.length > 0) {
    console.log(`[telegram] Plugins: ${loadedPlugins.join(', ')}`);
  }

  // Discover projects
  const projects = projectScanner.scanProjects();
  console.log(`[telegram] Discovered ${projects.length} projects from ~/.claude/projects/`);

  seedFromArgs();

  // Restore sessions, topic mappings, and history from previous run
  const savedState = loadState();
  if (savedState) {
    const restored = restoreState(savedState);
    if (restored > 0) {
      console.log(`[telegram] Restored ${restored} history entries from previous session`);
    }
  }

  startCompletionLoop();

  // Auto-save state every 30 seconds
  setInterval(() => saveState(), 30000);

  // Listen for compaction events — notify user but keep waiting
  sm.events.on('session:compacted', (session) => {
    const info = sessionToTopic.get(session.id);
    if (info) {
      sendMsg(info.chatId, '<i>\ud83d\udce6 Context compacted \u2014 Claude is continuing...</i>', {
        message_thread_id: info.topicId,
      }).catch(() => {});
    }
  });

  bot.on('message', (msg) => {
    if (msg.chat.id !== GROUP_ID) {
      console.log(`[telegram] Message from chat ${msg.chat.id} (${msg.chat.title || msg.chat.username || 'unknown'})`);
    }
  });

  if (process.env.WEZ_BRIDGE_PORT) {
    const { start } = require('./server.cjs');
    start();
  }

  console.log('[telegram] Bot is running. Send /help in the group.');
}

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('[telegram] Shutting down — saving state...');
  saveState();
  if (completionTimer) clearInterval(completionTimer);
  if (dashboardTimer) clearInterval(dashboardTimer);
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[telegram] Shutting down — saving state...');
  saveState();
  if (completionTimer) clearInterval(completionTimer);
  if (dashboardTimer) clearInterval(dashboardTimer);
  bot.stopPolling();
  process.exit(0);
});

// Run
if (require.main === module) {
  startBot();
}

module.exports = { startBot, bot, sessionToTopic, topicToSession, PROJECT_MAP: PROJECT_MAP_OVERRIDES };
