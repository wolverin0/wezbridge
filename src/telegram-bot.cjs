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

// Load .env from project root
try { require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') }); } catch {}

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
const voiceHandler = require('./voice-handler.cjs');
const orchestrator = require('./terminal-orchestrator.cjs');
const sharedTasks = require('./shared-tasks.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// --- ANSI colors for terminal output ---
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
};

function tag(color, label) { return `${color}[${label}]${c.reset}`; }
const T = {
  bot: tag(c.cyan, 'bot'),
  state: tag(c.dim, 'state'),
  poll: tag(c.blue, 'poll'),
  send: tag(c.green, '>>>'),
  recv: tag(c.magenta, '<<<'),
  live: tag(c.yellow, 'live'),
  err: tag(c.red, 'ERR'),
  plugin: tag(c.dim, 'plugin'),
  seed: tag(c.dim, 'seed'),
  photo: tag(c.blue, 'photo'),
  doc: tag(c.blue, 'doc'),
};

// --- State persistence ---
const STATE_FILE = path.join(__dirname, '..', '..', '.wezbridge-state.json');

let _saving = false;
function saveState() {
  if (_saving) return;
  _saving = true;

  const state = {
    savedAt: new Date().toISOString(),
    sessions: {},
    topicMappings: {},
    liveStreams: {},
  };

  // Save active live streams
  for (const [sessionId, stream] of liveStreams) {
    state.liveStreams[sessionId] = { messageId: stream.messageId };
  }

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

  const data = JSON.stringify(state, null, 2);
  fs.writeFile(STATE_FILE, data, 'utf-8', (err) => {
    _saving = false;
    if (err) console.error(`${T.err} State save failed:`, err.message);
  });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${T.err} State load failed:`, err.message);
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
      console.log(`${T.state} Pane ${data.paneId} no longer exists, skipping ${c.dim}${sessionId}${c.reset}`);
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
      console.log(`${T.state} Restored: topic ${c.cyan}${info.topicId}${c.reset} <-> ${c.green}${sessionId}${c.reset} (${info.projectName})`);
    }
  }

  // Restore live streams
  for (const [sessionId, stream] of Object.entries(state.liveStreams || {})) {
    const session = sm.getSession(sessionId);
    if (session) {
      liveStreams.set(sessionId, { lastHash: 0, lastSentAt: 0, messageId: stream.messageId || null, draftFailed: false });
      console.log(`${T.live} Restored live stream for ${c.green}${session.name || sessionId}${c.reset}`);
    }
  }

  return restored;
}

// --- Config ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID ? Number(process.env.TELEGRAM_GROUP_ID) : null;
const POLL_MS = parseInt(process.env.TELEGRAM_POLL_MS || '3000', 10);
const THINKING_TIMEOUT_MS = 30000;
const THINKING_UPDATE_MS = 30000;
const NOTIFY_LEVEL = process.env.WEZBRIDGE_NOTIFY_LEVEL || 'all';
const ALLOWED_USERS = process.env.ALLOWED_TELEGRAM_USERS
  ? process.env.ALLOWED_TELEGRAM_USERS.split(',').map(id => Number(id.trim())).filter(Boolean)
  : [];

if (!TOKEN) { console.error('[telegram] TELEGRAM_BOT_TOKEN is required'); process.exit(1); }
if (!GROUP_ID) { console.error('[telegram] TELEGRAM_GROUP_ID is required'); process.exit(1); }

/** Check if a user is authorized. Returns true if no allowlist or user is in it. */
function isAuthorized(msg) {
  if (ALLOWED_USERS.length === 0) return true;
  return msg.from && ALLOWED_USERS.includes(msg.from.id);
}

/** Wrap a command handler with auth check. */
function authed(handler) {
  return (msg, match) => {
    if (!isAuthorized(msg)) return;
    return handler(msg, match);
  };
}

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
  // Use projectRoot (actual project directory) not path (which may be a deep subfolder cwd)
  return match ? (match.projectRoot || match.path) : null;
}

// --- State ---
const sessionToTopic = new Map();
const topicToSession = new Map();
const thinkingMessages = new Map();
const completionCards = new Map(); // sessionId → { messageId, chatId, topicId }

// --- Dashboard state ---
let dashboardMsg = null; // { chatId, messageId, topicId }
let dashboardTimer = null;

// --- Live stream state ---
// Map<sessionId, { lastHash, lastSentAt, messageId }>
const liveStreams = new Map();

/**
 * Build a completion card — a compact, single-message summary of Claude's response.
 * Designed to be edited in-place on each new completion.
 */
function buildCompletionCard(session, response, diffStatSummary, promptType) {
  const name = outputParser.escapeHtml(session.name || session.id);
  const elapsed = session.lastActivity
    ? Math.round((Date.now() - new Date(session.lastActivity).getTime()) / 1000)
    : 0;
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : elapsed < 3600 ? `${Math.round(elapsed / 60)}m` : `${Math.round(elapsed / 3600)}h`;

  const statusIcon = promptType === 'permission' ? '\u{1F513}' : promptType === 'continuation' ? '\u23ef' : '\u2705';
  const statusText = promptType === 'permission' ? 'Needs approval' : promptType === 'continuation' ? 'Continue?' : 'Idle';

  // Response preview: first ~600 chars, cleaned up
  const clean = outputParser.stripAnsi(response);
  const stripped = outputParser.stripClaudeChrome(clean).trim();
  let preview = stripped.slice(0, 600);
  if (stripped.length > 600) preview += '...';

  const lines = [
    `<b>\u2501\u2501 ${name} \u2501\u2501</b>`,
    `${statusIcon} ${statusText} | ${elapsedStr} ago`,
    '',
    `<pre><code class="language-text">${outputParser.escapeHtml(preview)}</code></pre>`,
  ];

  if (diffStatSummary) {
    lines.push('');
    lines.push(`\ud83d\udcca <i>${outputParser.escapeHtml(diffStatSummary)}</i>`);
  }

  // Trim to fit 4096
  let html = lines.join('\n');
  if (html.length > 4000) {
    preview = stripped.slice(0, 300) + '...';
    lines[3] = `<pre><code class="language-text">${outputParser.escapeHtml(preview)}</code></pre>`;
    html = lines.join('\n');
  }

  return html;
}

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

// --- Message Reactions (V3 Phase 1A) ---
async function setReaction(chatId, messageId, emoji) {
  try {
    await bot._request('setMessageReaction', {
      form: {
        chat_id: chatId,
        message_id: messageId,
        reaction: JSON.stringify([{ type: 'emoji', emoji }]),
      },
    });
  } catch { /* silent — reactions are enhancement, not critical */ }
}

// --- Native Message Streaming (V3 Phase 2A) ---
// Uses Bot API 9.5 sendMessageDraft for smoother streaming
async function sendDraft(chatId, messageThreadId, text, draftId) {
  try {
    const result = await bot._request('sendMessageDraft', {
      form: {
        chat_id: chatId,
        message_thread_id: messageThreadId,
        text: text,
        draft_id: draftId,
        parse_mode: 'HTML',
      },
    });
    return result;
  } catch (err) {
    // Fallback: sendMessageDraft may not be supported by the library version
    // Return null to signal caller should use editMessageText instead
    return null;
  }
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
            { text: '\u2705 Approve', callback_data: 'action:approve' },
            { text: '\u2705 Always', callback_data: 'action:approve-always' },
            { text: '\ud83d\udeab Reject', callback_data: 'action:reject' },
          ],
          [
            { text: '\ud83d\udd0d View Details', callback_data: 'action:status' },
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
            { text: '\u25b6\ufe0f Continue', callback_data: 'action:continue' },
            { text: '\ud83d\udcca Status', callback_data: 'action:status' },
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
          { text: '\u25b6\ufe0f Continue', callback_data: 'action:continue' },
          { text: '\ud83e\uddea Tests', callback_data: 'action:tests' },
          { text: '\ud83d\udcbe Commit', callback_data: 'action:commit' },
        ],
        [
          { text: '\ud83d\udcca Diff', callback_data: 'action:diff' },
          { text: '\ud83d\udddc Compact', callback_data: 'action:compact' },
          { text: '\ud83d\udd0d Review', callback_data: 'action:review' },
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
      // Check if timer was already cleared (race condition with clearThinkingTimer)
      if (!thinkingMessages.has(sessionId)) return;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const msg = await sendMsg(info.chatId, `<i>Claude is still working... (${elapsed}s)</i>`, {
        message_thread_id: info.topicId,
      });
      // Re-check after async send — timer may have been cleared while awaiting
      if (!thinkingMessages.has(sessionId)) {
        try { await bot.deleteMessage(info.chatId, msg.message_id); } catch {}
        return;
      }
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
    // Check if there's already a session with a live pane for this project
    const existingSession = sm.findSessionByProject(projectPath);
    if (existingSession) {
      // Find the topic this session is mapped to
      const existingTopic = sessionToTopic.get(existingSession.id);
      if (existingTopic) {
        try {
          await sendMsg(GROUP_ID, [
            `<b>Reusing existing session</b>`,
            `Project: <code>${outputParser.escapeHtml(projectName)}</code>`,
            `Session: <code>${existingSession.id}</code>`,
            `Pane: ${existingSession.paneId}`,
          ].filter(Boolean).join('\n'), {
            message_thread_id: existingTopic.topicId,
          });
          return;
        } catch {
          // Topic may have been deleted — fall through to create new one
        }
      }
      // Session exists but no topic — create topic and link it
    }

    // Always create a fresh topic — don't reuse topics from other projects
    let topicId = null;

    if (!topicId) {
      const topic = await bot.createForumTopic(GROUP_ID, projectName, {
        icon_color: 7322096,
      });
      topicId = topic.message_thread_id;
    }

    let session;
    if (existingSession) {
      // Link existing session to the new topic
      session = existingSession;
      sessionToTopic.set(session.id, { topicId, chatId: GROUP_ID, projectName });
      topicToSession.set(topicId, session.id);
    } else {
      session = sm.spawnSession({
        project: projectPath,
        name: projectName,
        continueSession,
        dangerouslySkipPermissions: skipPermissions,
        taskId,
      });

      sessionToTopic.set(session.id, { topicId, chatId: GROUP_ID, projectName });
      topicToSession.set(topicId, session.id);

      // Set tab title in WezTerm for easy identification
      wez.setTabTitle(session.paneId, projectName);
    }

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

    if (msg.message_thread_id && msg.message_thread_id !== topicId) {
      try {
        await sendMsg(chatId, `Session <b>${outputParser.escapeHtml(projectName)}</b> created in its own topic.`, {
          message_thread_id: msg.message_thread_id,
        });
      } catch {
        // Original topic may have been deleted — ignore
      }
    }
  } catch (err) {
    console.error(`${T.err} Spawn failed:`, err.message || err);
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
    completionCards.delete(sessionId);
    liveStreams.delete(sessionId);
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

const PROJECTS_PAGE_SIZE = 10;

async function handleProjects(msg, page = 0) {
  const chatId = msg.chat.id;

  const projects = projectScanner.scanProjects();
  if (projects.length === 0) {
    return sendMsg(chatId, 'No projects found in ~/.claude/projects/', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const start = page * PROJECTS_PAGE_SIZE;
  const pageProjects = projects.slice(start, start + PROJECTS_PAGE_SIZE);
  const totalPages = Math.ceil(projects.length / PROJECTS_PAGE_SIZE);

  const lines = pageProjects.map(p => {
    const sessions = p.sessionCount;
    const age = projectScanner.relativeTime(p.lastActive);
    const healthIcon = p.health === 'clean' ? '\u2705' : p.health === 'interrupted' ? '\u26a0' : '\u2796';
    return `${healthIcon} <b>${outputParser.escapeHtml(p.name)}</b> | ${sessions} sessions | ${age}`;
  });

  if (totalPages > 1) {
    lines.push(`\n<i>Page ${page + 1}/${totalPages} (${projects.length} projects)</i>`);
  }

  // Inline buttons — one per project on this page
  const buttons = pageProjects.map(p => [{
    text: `\ud83d\ude80 ${p.name}`,
    callback_data: `spawn:${p.name.slice(0, 40)}`,
  }]);

  // Navigation buttons
  const navRow = [];
  if (page > 0) navRow.push({ text: '\u25c0 Prev', callback_data: `projects:${page - 1}` });
  if (start + PROJECTS_PAGE_SIZE < projects.length) navRow.push({ text: 'Next \u25b6', callback_data: `projects:${page + 1}` });
  if (navRow.length > 0) buttons.push(navRow);

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
      filename: `${projectName}-${sessionId}.txt`,
      contentType: 'text/plain',
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
  const webAppUrl = process.env.WEBAPP_URL || null;
  const opts = { message_thread_id: topicId };
  if (webAppUrl) {
    opts.reply_markup = {
      inline_keyboard: [[
        { text: '📊 Open Dashboard', url: 'https://t.me/wezbridge_bot/wezbridge_bot' },
      ]],
    };
  }
  const sent = await sendMsg(chatId, text, opts);

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

  // M8: Stop timer if no active sessions
  if (sm.listSessions().length === 0) {
    if (dashboardTimer) { clearInterval(dashboardTimer); dashboardTimer = null; }
    return;
  }

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

    const html = `${header}\n\n<pre><code class="language-text">${body}</code></pre>`;

    if (html.length > 4000) {
      // Too long — send as document + short summary
      const lastFewLines = lines.slice(-8).join('\n');
      await sendMsg(chatId, `${header}\n\n<pre><code class="language-text">${outputParser.escapeHtml(lastFewLines.slice(-800))}</code></pre>`, {
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
            filename: `${session.name}-precompact-${Date.now()}.txt`,
            contentType: 'text/plain',
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
      filename: `${session.name}-dump-${Date.now()}.txt`,
      contentType: 'text/plain',
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
    const stream = liveStreams.get(sessionId);
    // Clear draft on toggle-off (V3 Phase 2A)
    if (stream && !stream.draftFailed) {
      sendDraft(chatId, topicId, '', `wezbridge-${sessionId}`).catch(() => {});
    }
    liveStreams.delete(sessionId);
    return sendMsg(chatId, '<b>Live stream OFF</b> for ' + outputParser.escapeHtml(session.name), {
      message_thread_id: topicId,
    });
  }

  liveStreams.set(sessionId, { lastHash: 0, lastSentAt: 0, messageId: null, draftFailed: false });
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
        try { await editMsg(info.chatId, stream.messageId, blankMsg, { message_thread_id: info.topicId }); } catch {}
      } else {
        try {
          const sent = await sendMsg(info.chatId, blankMsg, { message_thread_id: info.topicId });
          if (sent?.message_id) stream.messageId = sent.message_id;
        } catch {}
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

    // Build HTML: header outside <pre>, body inside <pre> for spacing
    let showLines = lines.slice(-LIVE_LINES);
    let html = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = outputParser.escapeHtml(showLines.join('\n'));
      html = `${header}<pre><code class="language-bash">${body}</code></pre>`;
      if (html.length <= 4050) break;
      showLines = showLines.slice(Math.ceil(showLines.length * 0.2));
    }
    if (html.length > 4050) {
      const body = outputParser.escapeHtml(showLines.slice(-15).join('\n'));
      html = `${header}<pre><code class="language-bash">${body}</code></pre>`;
    }

    // Try native draft streaming first (Bot API 9.5)
    if (!stream.draftFailed) {
      const draftResult = await sendDraft(
        info.chatId,
        info.topicId,
        html,
        `wezbridge-${sessionId}` // stable draft ID per session
      );
      if (draftResult) {
        stream.lastSentAt = now;
        stream.lastHash = hash;
        return; // Draft streaming worked
      }
      // Mark as failed so we don't retry every update
      stream.draftFailed = true;
      console.log(`${T.live} Draft streaming unavailable, falling back to editMessageText`);
    }

    // Fallback: edit message (legacy approach) with plain-text fallback on HTML parse failure
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
    // Track consecutive errors — stop stream after 3 failures (dead pane)
    stream.errorCount = (stream.errorCount || 0) + 1;
    if (stream.errorCount >= 3) {
      console.log(`${T.live} Stopping stream for ${sessionId} — pane dead after ${stream.errorCount} errors: ${err.message}`);
      liveStreams.delete(sessionId);
    } else {
      console.log(`${T.live} Error streaming ${sessionId} (${stream.errorCount}/3): ${err.message}`);
    }
  }
}

// --- /reconnect — re-sync with a running terminal session ---

async function handleReconnect(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) return sendMsg(chatId, 'Use /reconnect inside a session topic.');

  let sessionId = topicToSession.get(topicId);
  let session = sessionId ? sm.getSession(sessionId) : null;

  // No existing mapping — scan WezTerm for Claude panes and offer to link
  if (!session) {
    try {
      const panes = wez.listPanes();
      // Filter for panes that look like Claude sessions (not bare shells)
      const claudePanes = panes.filter(p => {
        const title = (p.title || '').toLowerCase();
        const cwd = (p.cwd || '').toLowerCase();
        // Match panes with "claude" in title, or panes in project directories
        return /claude/i.test(title) || /py apps/i.test(cwd) || /\.claude/i.test(cwd);
      });

      if (claudePanes.length === 0) {
        // No panes at all (e.g. after reboot) — offer to spawn a new session
        // and link it to THIS existing topic instead of creating a new one
        const topicName = msg.reply_to_message?.forum_topic_created?.name || '';
        const projectPath = topicName ? resolveProjectPath(topicName) : null;

        if (projectPath) {
          // Auto-spawn: we know which project this topic belongs to
          const newSession = sm.spawnSession({
            project: projectPath,
            name: topicName,
            continueSession: true,
            dangerouslySkipPermissions: true,
          });
          sessionToTopic.set(newSession.id, { topicId, chatId: GROUP_ID, projectName: topicName });
          topicToSession.set(topicId, newSession.id);
          wez.setTabTitle(newSession.paneId, topicName);
          saveState();

          return sendMsg(chatId, [
            `<b>Reconnected: ${outputParser.escapeHtml(topicName)}</b>`,
            `New session spawned (--continue --yolo)`,
            `Pane: <code>${newSession.paneId}</code>`,
          ].join('\n'), {
            message_thread_id: topicId,
          });
        }

        // Can't auto-detect project — show spawn button
        return sendMsg(chatId, [
          '<i>No running panes found (WezTerm may have restarted).</i>',
          '',
          topicName
            ? `Could not resolve project "<b>${outputParser.escapeHtml(topicName)}</b>".`
            : 'Could not detect project name from topic.',
          'Use <code>/spawn &lt;project&gt; --continue --yolo</code> in this topic to respawn.',
        ].filter(Boolean).join('\n'), { message_thread_id: topicId });
      }

      // Panes exist — try to find one matching this topic's project
      const topicName2 = msg.reply_to_message?.forum_topic_created?.name || '';
      const matchingPanes = topicName2
        ? claudePanes.filter(p => {
            const cwd = (p.cwd || '').replace(/\\/g, '/').toLowerCase();
            const title = (p.title || '').toLowerCase();
            const tn = topicName2.toLowerCase();
            return cwd.includes(tn) || title.includes(tn);
          })
        : [];

      const panesToShow = matchingPanes.length > 0 ? matchingPanes : claudePanes;
      const buttons = panesToShow.map(p => {
        const label = `Pane ${p.pane_id}: ${p.title || 'unknown'}`;
        return [{ text: label, callback_data: `reconnect:${p.pane_id}` }];
      });

      return sendMsg(chatId, '<b>Select a pane to reconnect:</b>', {
        message_thread_id: topicId,
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (err) {
      return sendMsg(chatId, `<i>Error scanning panes: ${outputParser.escapeHtml(err.message)}</i>`, { message_thread_id: topicId });
    }
  }

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
          filename: `${session.name}-reconnect.txt`,
          contentType: 'text/plain',
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
    '',
    '<b>Team orchestrator:</b>',
    '/team &lt;project&gt; &lt;@name:role, ...&gt; — Create agent team',
    '/teamstatus — Show team status + task list',
    '/msg @name &lt;text&gt; — Message a session',
    '/broadcast &lt;text&gt; — Message all sessions',
    '/alias @name — Name current topic\'s session',
    '/tasks — View shared task list',
    '/addtask &lt;title&gt; — Add a shared task',
    '/mailbox — View inter-session messages',
    '/disband — Kill all team sessions',
  ].join('\n'), { message_thread_id: msg.message_thread_id });
}

// ─── Orchestrator command handlers ─────────────────────────────────────────

/**
 * /team <project> <@name:role, @name:role> — Create an agent team
 * Example: /team ~/myapp @frontend:React UI, @backend:API routes, @tests:Write tests
 */
async function handleTeam(msg, args) {
  if (!args || !args.trim()) {
    return sendMsg(msg.chat.id, [
      '<b>Usage:</b> <code>/team &lt;project&gt; @name:role, @name:role</code>',
      '',
      '<b>Example:</b>',
      '<code>/team ~/myapp @frontend:React UI, @backend:API routes, @tests:Write tests</code>',
      '',
      'Add <code>--orchestrator</code> to include an overseer session.',
      'Add <code>--yolo</code> to skip permissions.',
    ].join('\n'), { message_thread_id: msg.message_thread_id });
  }

  const hasOrchestrator = args.includes('--orchestrator');
  const hasYolo = args.includes('--yolo');
  const cleanArgs = args.replace(/--orchestrator/g, '').replace(/--yolo/g, '').trim();

  // Parse: first token is project, rest are @name:role pairs
  const tokens = cleanArgs.split(/\s+/);
  const project = resolveProjectPath(tokens[0]) || tokens[0];
  const memberStr = tokens.slice(1).join(' ');

  // Parse @name:role pairs (comma or space separated)
  const memberPattern = /@([a-zA-Z0-9_-]+):([^,@]+)/g;
  const members = [];
  let match;
  while ((match = memberPattern.exec(memberStr)) !== null) {
    members.push({ alias: match[1].toLowerCase(), role: match[2].trim() });
  }

  if (members.length === 0) {
    return sendMsg(msg.chat.id, 'No team members specified. Use <code>@name:role</code> format.', {
      message_thread_id: msg.message_thread_id,
    });
  }

  await sendMsg(msg.chat.id, [
    `\u26a1 <b>Creating team</b> (${members.length} members${hasOrchestrator ? ' + orchestrator' : ''})`,
    `Project: <code>${outputParser.escapeHtml(project)}</code>`,
    '',
    ...members.map(m => `\u2022 @${m.alias}: ${m.role}`),
  ].join('\n'), { message_thread_id: msg.message_thread_id });

  const result = orchestrator.createTeam({
    project,
    members,
    withOrchestrator: hasOrchestrator,
    dangerouslySkipPermissions: hasYolo,
  });

  // Create Telegram topics for each team member
  for (const member of result.members) {
    if (member.error) continue;
    try {
      const topicName = `@${member.alias}`;
      const topic = await bot.createForumTopic(GROUP_ID, topicName, { icon_color: 7322096 });
      const topicId = topic.message_thread_id;
      sessionToTopic.set(member.sessionId, { topicId, chatId: GROUP_ID, projectName: member.alias });
      topicToSession.set(topicId, member.sessionId);
      wez.setTabTitle(sm.getSession(member.sessionId)?.paneId, `@${member.alias}`);
    } catch (err) {
      console.error(`${T.err} Topic creation for @${member.alias}:`, err.message);
    }
  }

  // Create topic for orchestrator too
  if (result.orchestrator) {
    try {
      const topic = await bot.createForumTopic(GROUP_ID, '\ud83c\udfaf Orchestrator', { icon_color: 16766720 });
      const topicId = topic.message_thread_id;
      sessionToTopic.set(result.orchestrator.id, { topicId, chatId: GROUP_ID, projectName: 'orchestrator' });
      topicToSession.set(topicId, result.orchestrator.id);
    } catch (err) {
      console.error(`${T.err} Orchestrator topic creation:`, err.message);
    }
  }

  saveState();

  const summary = result.members.map(m =>
    m.error ? `\u274c @${m.alias}: ${m.error}` : `\u2705 @${m.alias} → ${m.sessionId}`
  );

  return sendMsg(msg.chat.id, [
    '<b>\u2705 Team created!</b>',
    '',
    ...summary,
    result.orchestrator ? `\ud83c\udfaf Orchestrator: ${result.orchestrator.id}` : '',
    '',
    'Each member has a dedicated topic. Use <code>@name message</code> to communicate.',
  ].join('\n'), { message_thread_id: msg.message_thread_id });
}

/**
 * /teamstatus — Show full team status
 */
async function handleTeamStatus(msg) {
  const status = orchestrator.getTeamStatus();
  const tasks = sharedTasks.formatForTelegram();
  return sendMsg(msg.chat.id, `${status}\n\n${tasks}`, { message_thread_id: msg.message_thread_id });
}

/**
 * /msg @name <text> — Send a message to a specific session
 */
async function handleMsg(msg, args) {
  if (!args || !args.trim()) {
    return sendMsg(msg.chat.id, 'Usage: <code>/msg @name your message</code>', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const match = args.match(/^@([a-zA-Z0-9_-]+)\s+(.+)/s);
  if (!match) {
    return sendMsg(msg.chat.id, 'Usage: <code>/msg @name your message</code>', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const alias = match[1].toLowerCase();
  const message = match[2].trim();
  const targetSessionId = orchestrator.resolveAlias(alias);

  if (!targetSessionId) {
    const available = orchestrator.listAliases().map(a => `@${a.alias}`).join(', ');
    return sendMsg(msg.chat.id, `Unknown session: @${alias}\nAvailable: ${available || 'none'}`, {
      message_thread_id: msg.message_thread_id,
    });
  }

  const queued = orchestrator.sendMessage({ from: 'user', to: alias, message });
  const session = sm.getSession(targetSessionId);
  const delivered = session && session.status === 'waiting' ? ' (delivered immediately)' : ' (queued for delivery)';

  return sendMsg(msg.chat.id, `\ud83d\udce8 Message to <b>@${alias}</b>${delivered}`, {
    message_thread_id: msg.message_thread_id,
  });
}

/**
 * /broadcast <text> — Send message to all sessions
 */
async function handleBroadcast(msg, text) {
  if (!text || !text.trim()) {
    return sendMsg(msg.chat.id, 'Usage: <code>/broadcast your message to all sessions</code>', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const messages = orchestrator.broadcast('user', text.trim());
  return sendMsg(msg.chat.id, `\ud83d\udce2 Broadcast sent to ${messages.length} sessions`, {
    message_thread_id: msg.message_thread_id,
  });
}

/**
 * /alias @name — Name the current topic's session
 */
async function handleAlias(msg, alias) {
  if (!alias || !alias.trim()) {
    return sendMsg(msg.chat.id, 'Usage: <code>/alias @name</code>', {
      message_thread_id: msg.message_thread_id,
    });
  }

  const topicId = msg.message_thread_id;
  const sessionId = topicToSession.get(topicId);
  if (!sessionId) {
    return sendMsg(msg.chat.id, 'No session in this topic. Use /spawn first.', {
      message_thread_id: topicId,
    });
  }

  const clean = alias.replace(/^@/, '').trim();
  orchestrator.registerAlias(sessionId, clean);
  return sendMsg(msg.chat.id, `\u2705 Session named <b>@${clean}</b>`, {
    message_thread_id: topicId,
  });
}

/**
 * /tasks — View shared task list
 * /addtask <title> — Add a task
 */
async function handleTasks(msg) {
  return sendMsg(msg.chat.id, sharedTasks.formatForTelegram(), {
    message_thread_id: msg.message_thread_id,
  });
}

async function handleAddTask(msg, args) {
  if (!args || !args.trim()) {
    return sendMsg(msg.chat.id, [
      '<b>Usage:</b> <code>/addtask Title text</code>',
      '<b>Options:</b>',
      '  <code>--assign @name</code> — Pre-assign to a session',
      '  <code>--priority high</code> — Set priority (low/normal/high/critical)',
      '  <code>--depends taskId</code> — Add dependency',
    ].join('\n'), { message_thread_id: msg.message_thread_id });
  }

  // Parse options
  const assignMatch = args.match(/--assign\s+@?([a-zA-Z0-9_-]+)/);
  const priorityMatch = args.match(/--priority\s+(low|normal|high|critical)/);
  const dependsMatch = args.match(/--depends\s+([a-f0-9]+)/);
  const title = args
    .replace(/--assign\s+@?[a-zA-Z0-9_-]+/g, '')
    .replace(/--priority\s+\S+/g, '')
    .replace(/--depends\s+\S+/g, '')
    .trim();

  const assignedTo = assignMatch ? orchestrator.resolveAlias(assignMatch[1]) : null;

  try {
    const task = sharedTasks.createTask({
      title,
      createdBy: 'user',
      assignedTo,
      priority: priorityMatch ? priorityMatch[1] : 'normal',
      dependsOn: dependsMatch ? [dependsMatch[1]] : [],
    });
    return sendMsg(msg.chat.id, `\u2705 Task created: <code>${task.id}</code> — ${outputParser.escapeHtml(task.title)}`, {
      message_thread_id: msg.message_thread_id,
    });
  } catch (err) {
    return sendMsg(msg.chat.id, `\u274c ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: msg.message_thread_id,
    });
  }
}

/**
 * /mailbox — View inter-session messages
 */
async function handleMailbox(msg) {
  return sendMsg(msg.chat.id, orchestrator.getMailboxStatus(), {
    message_thread_id: msg.message_thread_id,
  });
}

/**
 * /disband — Kill all team sessions
 */
async function handleDisband(msg) {
  const killed = orchestrator.disbandTeam();
  if (killed.length === 0) {
    return sendMsg(msg.chat.id, '<i>No active team to disband</i>', {
      message_thread_id: msg.message_thread_id,
    });
  }

  // Clean up topic mappings for killed sessions
  for (const alias of killed) {
    for (const [sessionId, info] of sessionToTopic) {
      if (info.projectName === alias) {
        topicToSession.delete(info.topicId);
        sessionToTopic.delete(sessionId);
      }
    }
  }
  saveState();

  return sendMsg(msg.chat.id, `\ud83d\udca5 Team disbanded: ${killed.map(a => `@${a}`).join(', ')}`, {
    message_thread_id: msg.message_thread_id,
  });
}

// --- Register commands (all gated by authed()) ---
bot.onText(/\/spawn\s*(.*)/, authed((msg, match) => handleSpawn(msg, match[1])));
bot.onText(/\/kill$/, authed((msg) => handleKill(msg)));
bot.onText(/\/status$/, authed((msg) => handleStatus(msg)));
bot.onText(/\/projects$/, authed((msg) => handleProjects(msg)));
bot.onText(/\/sessions\s+(.+)/, authed((msg, match) => handleSessions(msg, match[1])));
bot.onText(/\/costs$/, authed((msg) => handleCosts(msg)));
bot.onText(/\/history$/, authed((msg) => handleHistory(msg)));
bot.onText(/\/replay$/, authed((msg) => handleReplay(msg)));
bot.onText(/\/export$/, authed((msg) => handleExport(msg)));
bot.onText(/\/dashboard$/, authed((msg) => handleDashboard(msg)));
bot.onText(/\/peek$/, authed((msg) => handlePeek(msg)));
bot.onText(/\/reconnect$/, authed((msg) => handleReconnect(msg)));
bot.onText(/\/live$/, authed((msg) => handleLive(msg)));
bot.onText(/\/dump$/, authed((msg) => handleDump(msg)));
bot.onText(/\/task\s*(.*)/, authed((msg, match) => handleTask(msg, match[1])));
bot.onText(/\/help$/, authed((msg) => handleHelp(msg)));
bot.onText(/\/start$/, authed((msg) => handleHelp(msg)));

// --- Orchestrator commands ---
bot.onText(/\/team\s+(.+)/, authed((msg, match) => handleTeam(msg, match[1])));
bot.onText(/\/team$/, authed((msg) => handleTeam(msg, '')));
bot.onText(/\/teamstatus$/, authed((msg) => handleTeamStatus(msg)));
bot.onText(/\/msg\s+(.+)/s, authed((msg, match) => handleMsg(msg, match[1])));
bot.onText(/\/broadcast\s+(.+)/s, authed((msg, match) => handleBroadcast(msg, match[1])));
bot.onText(/\/alias\s+(.+)/, authed((msg, match) => handleAlias(msg, match[1])));
bot.onText(/\/tasks$/, authed((msg) => handleTasks(msg)));
bot.onText(/\/addtask\s+(.+)/, authed((msg, match) => handleAddTask(msg, match[1])));
bot.onText(/\/mailbox$/, authed((msg) => handleMailbox(msg)));
bot.onText(/\/disband$/, authed((msg) => handleDisband(msg)));

// /split — split current session's pane
bot.onText(/\/split(?:\s+(.+))?/, authed(async (msg, match) => {
  const topicId = msg.message_thread_id;
  if (!topicId) return sendMsg(msg.chat.id, 'Use /split inside a session topic.');

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return sendMsg(msg.chat.id, 'No session in this topic.', { message_thread_id: topicId });

  const session = sm.getSession(sessionId);
  if (!session) return sendMsg(msg.chat.id, 'Session not found.', { message_thread_id: topicId });

  const arg = (match[1] || '').trim().toLowerCase();
  const direction = arg === 'v' || arg === 'vertical' ? 'vertical' : 'horizontal';

  try {
    const newPaneId = direction === 'horizontal'
      ? wez.splitHorizontal(session.paneId, { cwd: session.project })
      : wez.splitVertical(session.paneId, { cwd: session.project });

    await sendMsg(msg.chat.id, [
      `<b>Split ${direction}</b>`,
      `Original pane: <code>${session.paneId}</code>`,
      `New pane: <code>${newPaneId}</code>`,
    ].join('\n'), { message_thread_id: topicId });
  } catch (err) {
    await sendMsg(msg.chat.id, `Split failed: ${outputParser.escapeHtml(err.message)}`, { message_thread_id: topicId });
  }
}));

// /workspace — list or switch WezTerm workspaces
bot.onText(/\/workspace(?:\s+(.+))?/, authed(async (msg, match) => {
  const arg = (match[1] || '').trim();

  if (!arg) {
    // List workspaces
    const workspaces = wez.listWorkspaces();
    if (workspaces.length === 0) {
      return sendMsg(msg.chat.id, '<i>No workspaces found</i>', {
        message_thread_id: msg.message_thread_id,
      });
    }
    const list = workspaces.map(w => `  \u2022 <code>${outputParser.escapeHtml(w)}</code>`).join('\n');
    return sendMsg(msg.chat.id, `<b>WezTerm Workspaces:</b>\n${list}`, {
      message_thread_id: msg.message_thread_id,
    });
  }

  // Switch to workspace
  try {
    wez.switchWorkspace(arg);
    await sendMsg(msg.chat.id, `Switched to workspace: <code>${outputParser.escapeHtml(arg)}</code>`, {
      message_thread_id: msg.message_thread_id,
    });
  } catch (err) {
    await sendMsg(msg.chat.id, `Workspace switch failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: msg.message_thread_id,
    });
  }
}));

// /remote — spawn a session on a remote SSH domain
bot.onText(/\/remote(?:\s+(.+))?/, authed(async (msg, match) => {
  const arg = (match[1] || '').trim();
  const domain = arg || 'openclaw'; // default SSH domain name

  try {
    const paneId = wez.spawnSshDomain(domain);
    wez.setTabTitle(paneId, `remote:${domain}`);

    await sendMsg(msg.chat.id, [
      `<b>\ud83c\udf10 Remote session spawned</b>`,
      `Domain: <code>${outputParser.escapeHtml(domain)}</code>`,
      `Pane: <code>${paneId}</code>`,
      `<i>Note: Configure SSH domain in ~/.wezterm.lua</i>`,
    ].join('\n'), {
      message_thread_id: msg.message_thread_id,
    });
  } catch (err) {
    await sendMsg(msg.chat.id, [
      `<b>Remote spawn failed</b>`,
      `Domain: <code>${outputParser.escapeHtml(domain)}</code>`,
      `Error: ${outputParser.escapeHtml(err.message)}`,
      `<i>Ensure SSH domain "${outputParser.escapeHtml(domain)}" is configured in ~/.wezterm.lua</i>`,
    ].join('\n'), {
      message_thread_id: msg.message_thread_id,
    });
  }
}));

// --- Message handler: text/photo/document in topic → inject as prompt ---
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  // Ignore bot's own messages
  if (msg.from && msg.from.is_bot) return;
  // Authorization check
  if (ALLOWED_USERS.length > 0 && msg.from && !ALLOWED_USERS.includes(msg.from.id)) return;
  // Must have text, photo, or document
  if (!msg.text && !msg.caption && !msg.photo && !msg.document && !msg.voice) return;

  const topicId = msg.message_thread_id;
  if (!topicId) return;

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return;

  const session = sm.getSession(sessionId);
  if (!session) return;

  try {
    let promptText = msg.text || msg.caption || '';
    const _tempFiles = []; // Track temp files for cleanup

    // Handle photo attachments — download and pass file path to Claude
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]; // highest resolution
      const fileInfo = await bot.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

      // Download to temp
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
      _tempFiles.push(localPath);
      console.log(`${T.photo} Saved: ${c.dim}${localPath}${c.reset}`);
    }

    // Handle document attachments
    if (msg.document) {
      const fileInfo = await bot.getFile(msg.document.file_id);
      const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

      const tempDir = path.join(os.tmpdir(), 'wezbridge');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const fileName = path.basename(msg.document.file_name || `file-${Date.now()}`);
      const localPath = path.join(tempDir, fileName);

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        https.get(url, (res) => {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });

      promptText = `${promptText}\n\n[File attached: ${localPath}]`.trim();
      _tempFiles.push(localPath);
      console.log(`${T.doc} Saved: ${c.dim}${localPath}${c.reset}`);
    }

    // Handle voice messages — transcribe via Whisper
    if (msg.voice) {
      if (!voiceHandler.isAvailable()) {
        await sendMsg(msg.chat.id, '<i>Voice transcription unavailable (OPENAI_API_KEY not set)</i>', {
          parse_mode: 'HTML',
          message_thread_id: topicId,
        });
        return;
      }
      try {
        const fileInfo = await bot.getFile(msg.voice.file_id);
        const url = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
        const ext = path.extname(fileInfo.file_path) || '.ogg';
        const localPath = await voiceHandler.downloadFile(url, `voice-${Date.now()}${ext}`);

        // Show transcribing status
        const statusMsg = await sendMsg(msg.chat.id, '<i>Transcribing voice...</i>', {
          message_thread_id: topicId,
        });

        const transcript = await voiceHandler.transcribe(localPath);

        // Clean up status message
        if (statusMsg) {
          bot.deleteMessage(msg.chat.id, statusMsg.message_id).catch(() => {});
        }

        if (!transcript || !transcript.trim()) {
          await sendMsg(msg.chat.id, '<i>Could not transcribe voice message</i>', {
            message_thread_id: topicId,
          });
          return;
        }

        // Show what was transcribed
        await sendMsg(msg.chat.id, `<i>"${outputParser.escapeHtml(transcript)}"</i>`, {
          message_thread_id: topicId,
        });

        promptText = transcript;
        // Clean up temp file
        try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      } catch (err) {
        await sendMsg(msg.chat.id, `<i>Voice transcription failed: ${outputParser.escapeHtml(err.message)}</i>`, {
          message_thread_id: topicId,
        });
        return;
      }
    }

    if (!promptText) return;

    // ─── @ Mention Routing ─────────────────────────────────────────────
    // If the message contains @alias mentions, route to those sessions
    // instead of (or in addition to) the current topic's session.
    const { mentions, cleanText, isBroadcast } = orchestrator.parseMentions(promptText);

    if (mentions.length > 0 && cleanText) {
      if (isBroadcast) {
        // @all or @team — broadcast to everyone
        orchestrator.broadcast('user', cleanText);
        await sendMsg(msg.chat.id, `\ud83d\udce2 Broadcast to ${orchestrator.listAliases().length} sessions`, {
          message_thread_id: topicId,
        });
      } else {
        // Route to specific sessions
        for (const alias of mentions) {
          orchestrator.sendMessage({ from: 'user', to: alias, message: cleanText });
        }
        const targets = mentions.map(a => `@${a}`).join(', ');
        await sendMsg(msg.chat.id, `\ud83d\udce8 Sent to ${targets}`, {
          message_thread_id: topicId,
        });
      }
      setReaction(msg.chat.id, msg.message_id, '\ud83d\udce8');
      return;
    }
    // ─── End @ Mention Routing ─────────────────────────────────────────

    sm.sendPrompt(sessionId, promptText);

    // Clean up temp files after a delay
    if (_tempFiles.length > 0) {
      setTimeout(() => {
        for (const fp of _tempFiles) {
          try { fs.unlinkSync(fp); } catch {}
        }
      }, 60000);
    }

    setReaction(msg.chat.id, msg.message_id, '\u23f3'); // hourglass while working
    // Only show thinking timer if live mode is off
    if (!liveStreams.has(sessionId)) {
      startThinkingTimer(sessionId);
    }
    // Auto-delete user's prompt + ack after 3 seconds (keeps chat clean)
    const ack = msg.photo ? 'Photo sent' : msg.document ? 'File sent' : msg.voice ? 'Voice sent' : '\u2705';
    bot.sendMessage(msg.chat.id, `<i>${ack}</i>`, {
      parse_mode: 'HTML',
      message_thread_id: topicId,
    }).then(sent => {
      setTimeout(() => {
        bot.deleteMessage(msg.chat.id, sent.message_id).catch(() => {});
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
      }, 3000);
    }).catch(() => {});
  } catch (err) {
    sendMsg(msg.chat.id, `Failed to send: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
});

// --- Callback (button) handler ---
bot.on('callback_query', async (query) => {
  // Authorization check
  if (ALLOWED_USERS.length > 0 && query.from && !ALLOWED_USERS.includes(query.from.id)) {
    try { await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' }); } catch {}
    return;
  }
  try { await bot.answerCallbackQuery(query.id).catch(() => {}); } catch {}
  const topicId = query.message?.message_thread_id;
  const data = query.data || '';

  // Handle spawn from /projects button
  if (data.startsWith('spawn:')) {
    const projectName = data.slice(6);
    await bot.answerCallbackQuery(query.id, { text: `Spawning ${projectName} (yolo)...` });
    return handleSpawn(query.message, `${projectName} --continue --yolo`);
  }

  // Handle /projects pagination
  if (data.startsWith('projects:')) {
    const page = parseInt(data.slice(9), 10) || 0;
    await bot.answerCallbackQuery(query.id);
    // Delete old message to avoid clutter
    try { await bot.deleteMessage(query.message.chat.id, query.message.message_id); } catch {}
    return handleProjects(query.message, page);
  }

  // Handle reconnect pane selection
  if (data.startsWith('reconnect:')) {
    const paneId = parseInt(data.slice(10), 10);
    if (!topicId || isNaN(paneId)) return;

    try {
      // Read pane to get project info
      const raw = wez.getFullText(paneId, 100);
      const clean = outputParser.stripAnsi(raw);

      // Extract project name from the topic title or pane title
      const panes = wez.listPanes();
      const pane = panes.find(p => p.pane_id === paneId);
      const paneTitle = pane?.title || `pane-${paneId}`;
      const projectName = paneTitle.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 30) || `pane-${paneId}`;

      // Register a session linked to this pane
      const sessionId = `wez-reconn-${Date.now()}`;
      const newSession = {
        id: sessionId,
        paneId,
        project: null,
        name: projectName,
        status: 'running',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        taskId: null,
        _stabilityCount: 0,
        _lastScrollbackHash: null,
      };
      sm._registerSession(newSession);
      sessionToTopic.set(sessionId, { topicId, chatId: GROUP_ID, projectName });
      topicToSession.set(topicId, sessionId);
      saveState();

      console.log(`${T.bot} Reconnected: topic ${c.cyan}${topicId}${c.reset} <-> pane ${c.green}${paneId}${c.reset} (${projectName})`);

      // Delete the selection message
      try { await bot.deleteMessage(query.message.chat.id, query.message.message_id); } catch {}

      const quickCheck = sm.checkCompletion(sessionId);
      const isIdle = quickCheck.waiting;
      const statusIcon = isIdle ? '\u2705 Idle' : '\u23f3 Working';
      const session = sm.getSession(sessionId);

      await sendMsg(query.message.chat.id, `<b>Reconnected to pane ${paneId}</b> (${outputParser.escapeHtml(projectName)}) — ${statusIcon}`, {
        message_thread_id: topicId,
        ...(isIdle ? actionKeyboard(session.promptType) : {}),
      });
    } catch (err) {
      await sendMsg(query.message.chat.id, `<i>Reconnect failed: ${outputParser.escapeHtml(err.message)}</i>`, { message_thread_id: topicId });
    }
    return;
  }

  // Handle completion card buttons (card:fullresponse, card:viewdiff)
  if (data === 'card:fullresponse' || data === 'card:viewdiff') {
    if (!topicId) return;
    const cardSessionId = topicToSession.get(topicId);
    if (!cardSessionId) return;
    const cardSession = sm.getSession(cardSessionId);
    if (!cardSession) return;

    if (data === 'card:fullresponse') {
      try {
        const raw = wez.getFullText(cardSession.paneId, 500);
        const response = outputParser.extractLastResponse(raw);
        if (response) {
          const clean = outputParser.stripAnsi(response);
          const stripped = outputParser.stripClaudeChrome(clean).trim();
          // Send as .md document if long, inline if short
          if (stripped.length > 3000) {
            const buf = Buffer.from(stripped, 'utf-8');
            await bot.sendDocument(query.message.chat.id, buf, {
              message_thread_id: topicId,
              caption: `Full response (${stripped.length} chars)`,
            }, { filename: 'response.txt', contentType: 'text/plain' });
          } else {
            await sendMsg(query.message.chat.id, `<pre><code class="language-text">${outputParser.escapeHtml(stripped)}</code></pre>`, {
              message_thread_id: topicId,
            });
          }
        } else {
          await sendMsg(query.message.chat.id, '<i>No response captured.</i>', { message_thread_id: topicId });
        }
      } catch (err) {
        await sendMsg(query.message.chat.id, `<i>Error: ${outputParser.escapeHtml(err.message)}</i>`, { message_thread_id: topicId });
      }
      return;
    }

    if (data === 'card:viewdiff') {
      try {
        const proj = cardSession.project;
        if (!proj) {
          await sendMsg(query.message.chat.id, '<i>No project path for diff.</i>', { message_thread_id: topicId });
          return;
        }
        const diff = diffExtractor.getGitDiff(proj, 50000);
        if (!diff || diff.trim().length === 0) {
          await sendMsg(query.message.chat.id, '<i>No uncommitted changes.</i>', { message_thread_id: topicId });
          return;
        }
        if (diff.length > 3000) {
          const buf = Buffer.from(diff, 'utf-8');
          await bot.sendDocument(query.message.chat.id, buf, {
            message_thread_id: topicId,
            caption: `Git diff (${diff.split('\n').length} lines)`,
          }, { filename: 'changes.diff', contentType: 'text/plain' });
        } else {
          const formatted = diffExtractor.formatDiffForTelegram(diff);
          await sendMsg(query.message.chat.id, formatted || `<pre><code class="language-text">${outputParser.escapeHtml(diff)}</code></pre>`, {
            message_thread_id: topicId,
          });
        }
      } catch (err) {
        await sendMsg(query.message.chat.id, `<i>Diff error: ${outputParser.escapeHtml(err.message)}</i>`, { message_thread_id: topicId });
      }
      return;
    }
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

// --- Inline Mode (V3 Phase 3C) ---
// @wezbridge_bot status — quick session status from any chat
bot.on('inline_query', async (query) => {
  try {
    const sessions = sm.listSessions();
    if (sessions.length === 0) {
      return bot.answerInlineQuery(query.id, [{
        type: 'article',
        id: 'no-sessions',
        title: 'No active sessions',
        input_message_content: { message_text: 'No active WezBridge sessions.' },
      }]);
    }

    const results = sessions.slice(0, 10).map((s, i) => {
      const icon = s.status === 'running' ? '\u23f3' : s.status === 'waiting' ? '\u2705' : s.status === 'error' ? '\u274c' : '\u23f8';
      const name = s.name || s.id;
      const project = s.project ? s.project.split(/[/\\]/).pop() : 'unknown';
      const age = s.lastActivity
        ? Math.round((Date.now() - new Date(s.lastActivity).getTime()) / 60000) + 'm ago'
        : 'unknown';

      return {
        type: 'article',
        id: `session-${i}-${s.id}`,
        title: `${icon} ${name}`,
        description: `${project} \u2014 ${s.status} \u2014 ${age}`,
        input_message_content: {
          message_text: [
            `${icon} <b>${outputParser.escapeHtml(name)}</b>`,
            `Project: <code>${outputParser.escapeHtml(project)}</code>`,
            `Status: ${s.status}`,
            `Pane: ${s.paneId || 'N/A'}`,
            `Last activity: ${age}`,
          ].join('\n'),
          parse_mode: 'HTML',
        },
      };
    });

    // Add summary as first result
    const running = sessions.filter(s => s.status === 'running').length;
    const waiting = sessions.filter(s => s.status === 'waiting').length;
    results.unshift({
      type: 'article',
      id: 'summary',
      title: `\ud83d\udcca ${sessions.length} sessions`,
      description: `${running} working, ${waiting} idle`,
      input_message_content: {
        message_text: [
          `<b>\ud83d\udcca WezBridge Status</b>`,
          `Sessions: ${sessions.length}`,
          `Working: ${running}`,
          `Idle: ${waiting}`,
          `Updated: ${new Date().toLocaleTimeString()}`,
        ].join('\n'),
        parse_mode: 'HTML',
      },
    });

    await bot.answerInlineQuery(query.id, results, { cache_time: 10 });
  } catch (err) {
    console.error('[inline] Query error:', err.message);
    try {
      await bot.answerInlineQuery(query.id, [], { cache_time: 5 });
    } catch { /* ignore */ }
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
      console.log(`${T.poll} ${c.green}${newlyWaiting.length} session(s) completed${c.reset}`);
    }

    for (const session of newlyWaiting) {
      const info = sessionToTopic.get(session.id);
      if (!info) {
        console.log(`${T.poll} ${c.yellow}No topic mapping for ${session.id}${c.reset}`);
        continue;
      }

      try {
        await deleteThinkingMessage(session.id);

        // Clear draft on completion (V3 Phase 2A)
        const stream = liveStreams.get(session.id);
        if (stream && !stream.draftFailed) {
          sendDraft(info.chatId, info.topicId, '', `wezbridge-${session.id}`).catch(() => {});
        }

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

        // Get diff stat (one-liner)
        const liveSession = sm.getSession(session.id);
        let diffStatSummary = '';
        if (liveSession?.project) {
          try {
            const diffStat = diffExtractor.getGitDiffStat(liveSession.project);
            if (diffStat && diffStat.files.length > 0) {
              diffStatSummary = diffStat.summary;
            }
          } catch { /* ignore */ }
        }

        // Build completion card
        const cardHtml = buildCompletionCard(session, response, diffStatSummary, session.promptType);

        // Card buttons: action row + utility row
        const kb = actionKeyboard(session.promptType);
        const utilRow = [
          { text: '\ud83d\udcc4 Full Response', callback_data: 'card:fullresponse' },
        ];
        if (diffStatSummary) {
          utilRow.push({ text: '\ud83d\udcca View Diff', callback_data: 'card:viewdiff' });
        }
        // Merge utility row into keyboard
        const cardKeyboard = kb.reply_markup
          ? { reply_markup: { inline_keyboard: [...kb.reply_markup.inline_keyboard, utilRow] } }
          : { reply_markup: { inline_keyboard: [utilRow] } };

        // Edit existing card or send new one
        const existingCard = completionCards.get(session.id);
        if (existingCard) {
          try {
            await bot.editMessageText(cardHtml, {
              chat_id: existingCard.chatId,
              message_id: existingCard.messageId,
              parse_mode: 'HTML',
              ...cardKeyboard,
            });
          } catch {
            // Edit failed (message too old, deleted, etc) — send new
            const sent = await sendMsg(info.chatId, cardHtml, {
              message_thread_id: info.topicId,
              ...cardKeyboard,
            });
            if (sent) completionCards.set(session.id, { messageId: sent.message_id, chatId: info.chatId, topicId: info.topicId });
          }
        } else {
          const sent = await sendMsg(info.chatId, cardHtml, {
            message_thread_id: info.topicId,
            ...cardKeyboard,
          });
          if (sent) completionCards.set(session.id, { messageId: sent.message_id, chatId: info.chatId, topicId: info.topicId });
        }

        // React on the completion card
        const card = completionCards.get(session.id);
        if (card) {
          const reactionEmoji = session.promptType === 'permission' ? '\u2753' : '\u2705';
          setReaction(card.chatId, card.messageId, reactionEmoji);
        }

        // Store history
        sm.addCompletionHistory(session.id, {
          prompt: session.promptHistory?.[session.promptHistory.length - 1]?.prompt || '',
          response: response.slice(0, 500),
          diffStat: diffStatSummary || undefined,
        });

        // Persist state
        saveState();

        // ClawTrol notification (silent)
        if (liveSession?.taskId) {
          clawtrol.notifyWaiting(liveSession, response.slice(-300)).catch(() => {});
        }
      } catch (err) {
        console.error(`${T.err} Response failed for ${session.id}:`, err.message || err);
      }
      console.log(`${T.send} ${c.green}${session.name || session.id}${c.reset} → topic ${c.cyan}${info.topicId}${c.reset}`);
    }
  }, POLL_MS);
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
        console.log(`${T.seed} topic ${c.cyan}${topicId}${c.reset} <-> pane ${c.green}${paneId}${c.reset} (${projectName})`);
      }
      i++;
    }
  }
}

// --- Startup ---
function startBot() {
  console.log(`\n${c.bold}${c.cyan}━━━ WezBridge V2.1 ━━━${c.reset}\n`);
  console.log(`${T.bot} Group: ${c.dim}${GROUP_ID}${c.reset}`);
  console.log(`${T.bot} Poll: ${c.dim}${POLL_MS}ms${c.reset}`);
  console.log(`${T.bot} Notify: ${c.dim}${NOTIFY_LEVEL}${c.reset}`);

  // Load plugins
  const loadedPlugins = pluginLoader.loadAll({
    sendMsg,
    sessionManager: sm,
    wezterm: wez,
    bot,
  });
  if (loadedPlugins.length > 0) {
    console.log(`${T.plugin} Loaded: ${c.dim}${loadedPlugins.join(', ')}${c.reset}`);
  }

  // Discover projects
  const projects = projectScanner.scanProjects();
  console.log(`${T.bot} Projects: ${c.green}${projects.length}${c.reset} discovered`);

  // Initialize orchestrator auto-coordination
  orchestrator.setupAutoCoordination();

  seedFromArgs();

  // Restore sessions, topic mappings, and history from previous run
  const savedState = loadState();
  if (savedState) {
    const restored = restoreState(savedState);
    if (restored > 0) {
      console.log(`${T.state} Restored ${c.green}${restored}${c.reset} history entries`);
    }
  }

  startCompletionLoop();

  // Auto-save state every 30 seconds
  setInterval(() => saveState(), 30000);

  // Listen for compaction events — notify user but keep waiting
  // Handle dashboard-spawned sessions — create Telegram topic and link
  sm.events.on('session:spawned-api', async ({ session, projectName }) => {
    try {
      const topic = await bot.createForumTopic(GROUP_ID, projectName, { icon_color: 7322096 });
      const topicId = topic.message_thread_id;
      sessionToTopic.set(session.id, { topicId, chatId: GROUP_ID, projectName });
      topicToSession.set(topicId, session.id);
      wez.setTabTitle(session.paneId, projectName);
      saveState();
      await sendMsg(GROUP_ID, [
        `<b>Session started</b> (from Dashboard)`,
        `Project: <code>${outputParser.escapeHtml(projectName)}</code>`,
        `Session: <code>${session.id}</code>`,
        `Pane: ${session.paneId}`,
      ].join('\n'), { message_thread_id: topicId });
    } catch (err) {
      console.error(`${T.err} Dashboard spawn topic creation failed:`, err.message);
    }
  });

  sm.events.on('session:dead', (session) => {
    const info = sessionToTopic.get(session.id);
    // Stop any live stream for this session
    liveStreams.delete(session.id);
    // Clean up stale Maps
    completionCards.delete(session.id);
    deleteThinkingMessage(session.id);
    if (info) {
      topicToSession.delete(info.topicId);
      sessionToTopic.delete(session.id);
      sendMsg(info.chatId, `\u274c <b>Session lost</b> \u2014 WezTerm pane ${session.paneId} no longer exists.\nUse /projects to start a new session.`, {
        message_thread_id: info.topicId,
      }).catch(() => {});
    }
  });

  sm.events.on('session:compacted', (session) => {
    const info = sessionToTopic.get(session.id);
    if (info) {
      sendMsg(info.chatId, '<i>\ud83d\udce6 Context compacted \u2014 Claude is continuing...</i>', {
        message_thread_id: info.topicId,
      }).then(sent => {
        if (sent) {
          setTimeout(() => {
            bot.deleteMessage(info.chatId, sent.message_id).catch(() => {});
          }, 20000);
        }
      }).catch(() => {});
    }
  });

  bot.on('message', (msg) => {
    if (msg.chat.id !== GROUP_ID) {
      console.log(`${T.recv} ${c.dim}Chat ${msg.chat.id} (${msg.chat.title || msg.chat.username || 'unknown'})${c.reset}`);
    }
  });

  if (process.env.WEZ_BRIDGE_PORT) {
    const { start } = require('./server.cjs');
    start();
  }

  console.log(`${c.bold}${c.green}✓ Bot is running${c.reset} — send /help in the group\n`);
}

// --- Global error handlers (prevent crash on Telegram API errors) ---
process.on('unhandledRejection', (err) => {
  console.error(`${T.err} Unhandled rejection:`, err?.message || err);
});
bot.on('polling_error', (err) => {
  console.error(`${T.err} Polling error:`, err?.message || err);
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log(`\n${T.bot} ${c.yellow}Shutting down — saving state...${c.reset}`);
  saveState();
  if (completionTimer) clearInterval(completionTimer);
  if (dashboardTimer) clearInterval(dashboardTimer);
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n${T.bot} ${c.yellow}Shutting down — saving state...${c.reset}`);
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
