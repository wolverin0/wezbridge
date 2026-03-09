#!/usr/bin/env node
/**
 * WezBridge — Telegram Mission Control for Claude Code.
 *
 * Maps Telegram Forum Topics to Claude Code sessions running in WezTerm panes.
 * Send prompts from your phone, receive formatted responses with action buttons.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN     — required (from @BotFather)
 *   TELEGRAM_GROUP_ID      — required (forum group chat ID, negative number)
 *   TELEGRAM_POLL_MS       — optional (completion poll interval, default 3000)
 *   WEZBRIDGE_PROJECTS     — optional (JSON map of project names to paths)
 */

const TelegramBot = require('node-telegram-bot-api');
const sm = require('./session-manager.cjs');
const wez = require('./wezterm.cjs');
const outputParser = require('./output-parser.cjs');
const TelegramRateLimiter = require('./telegram-rate-limiter.cjs');

// --- Config ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID ? Number(process.env.TELEGRAM_GROUP_ID) : null;
const POLL_MS = parseInt(process.env.TELEGRAM_POLL_MS || '3000', 10);
const THINKING_TIMEOUT_MS = 30000;
const THINKING_UPDATE_MS = 30000;

if (!TOKEN) {
  console.error('[wezbridge] TELEGRAM_BOT_TOKEN is required. Set it in .env or as an environment variable.');
  console.error('[wezbridge] Get one from @BotFather on Telegram.');
  process.exit(1);
}
if (!GROUP_ID) {
  console.error('[wezbridge] TELEGRAM_GROUP_ID is required. Set it in .env or as an environment variable.');
  console.error('[wezbridge] Tip: add the bot to a forum group, send a message, and check the logs for the chat ID.');
  process.exit(1);
}

// --- Project Map ---
// Load from WEZBRIDGE_PROJECTS env var (JSON) or default to empty
let PROJECT_MAP = {};
if (process.env.WEZBRIDGE_PROJECTS) {
  try {
    PROJECT_MAP = JSON.parse(process.env.WEZBRIDGE_PROJECTS);
  } catch (err) {
    console.error('[wezbridge] Failed to parse WEZBRIDGE_PROJECTS:', err.message);
    console.error('[wezbridge] Expected JSON like: {"myapp":"/path/to/myapp"}');
  }
}

// --- State ---
const sessionToTopic = new Map();
const topicToSession = new Map();
const thinkingMessages = new Map();

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

// --- Action buttons ---
function actionKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Continue', callback_data: 'action:continue' },
          { text: 'Run Tests', callback_data: 'action:tests' },
        ],
        [
          { text: 'Commit', callback_data: 'action:commit' },
          { text: 'Status', callback_data: 'action:status' },
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
      try {
        await bot.deleteMessage(info.chatId, thinking.messageId);
      } catch { /* ignore */ }
    }
  }
}

// --- Commands ---

async function handleSpawn(msg, match) {
  const chatId = msg.chat.id;
  const args = (match || '').trim().split(/\s+/);
  const projectName = args[0];

  if (!projectName) {
    const available = Object.keys(PROJECT_MAP);
    const list = available.length > 0
      ? `\nAvailable: ${available.join(', ')}`
      : '\nNo projects configured. Set WEZBRIDGE_PROJECTS env var.';
    return sendMsg(chatId, `Usage: /spawn &lt;project-name|/path/to/dir&gt; [--continue]${list}`, {
      message_thread_id: msg.message_thread_id,
    });
  }

  // Resolve project path: check map first, then treat as absolute path
  const projectPath = PROJECT_MAP[projectName] || projectName;
  const continueSession = args.includes('--continue');

  try {
    const topic = await bot.createForumTopic(GROUP_ID, projectName, {
      icon_color: 7322096,
    });
    const topicId = topic.message_thread_id;

    const session = sm.spawnSession({
      project: projectPath,
      name: projectName,
      continueSession,
    });

    sessionToTopic.set(session.id, { topicId, chatId: GROUP_ID, projectName });
    topicToSession.set(topicId, session.id);

    await sendMsg(GROUP_ID, [
      `<b>Session started</b>`,
      `Project: <code>${outputParser.escapeHtml(projectName)}</code>`,
      `Path: <code>${outputParser.escapeHtml(projectPath)}</code>`,
      `Session: <code>${session.id}</code>`,
      `Pane: ${session.paneId}`,
      continueSession ? 'Mode: --continue' : '',
    ].filter(Boolean).join('\n'), {
      message_thread_id: topicId,
    });

    if (msg.message_thread_id !== topicId) {
      await sendMsg(chatId, `Session <b>${outputParser.escapeHtml(projectName)}</b> created in its own topic.`, {
        message_thread_id: msg.message_thread_id,
      });
    }
  } catch (err) {
    console.error('[wezbridge] Spawn error:', err);
    await sendMsg(chatId, `Spawn failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: msg.message_thread_id,
    });
  }
}

async function handleKill(msg) {
  const chatId = msg.chat.id;
  const topicId = msg.message_thread_id;

  if (!topicId) {
    return sendMsg(chatId, 'Use /kill inside a session topic.');
  }

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) {
    return sendMsg(chatId, 'No session linked to this topic.', { message_thread_id: topicId });
  }

  try {
    sm.killSession(sessionId);
    await deleteThinkingMessage(sessionId);
    sessionToTopic.delete(sessionId);
    topicToSession.delete(topicId);

    await sendMsg(chatId, '<b>Session killed.</b>', { message_thread_id: topicId });

    try {
      await bot.closeForumTopic(GROUP_ID, topicId);
    } catch { /* may not have permission */ }
  } catch (err) {
    await sendMsg(chatId, `Kill failed: ${outputParser.escapeHtml(err.message)}`, {
      message_thread_id: topicId,
    });
  }
}

async function handleStatus(msg) {
  const chatId = msg.chat.id;
  const allSessions = sm.listSessions();

  if (allSessions.length === 0) {
    return sendMsg(chatId, 'No active sessions.', { message_thread_id: msg.message_thread_id });
  }

  const lines = allSessions.map(s => {
    const topicInfo = sessionToTopic.get(s.id);
    const name = topicInfo?.projectName || s.name;
    const elapsed = Math.round((Date.now() - new Date(s.createdAt).getTime()) / 60000);
    return `<b>${outputParser.escapeHtml(name)}</b> [${s.status}] — ${elapsed}m — pane ${s.paneId}`;
  });

  return sendMsg(chatId, lines.join('\n'), { message_thread_id: msg.message_thread_id });
}

async function handleHelp(msg) {
  return sendMsg(msg.chat.id, [
    '<b>WezBridge — Claude Code Mission Control</b>',
    '',
    '/spawn &lt;project&gt; [--continue] — Start Claude session',
    '/kill — Kill session (in topic)',
    '/status — List all sessions',
    '/help — This message',
    '',
    'Type in a topic to send prompts to Claude.',
    'Use inline buttons for quick actions.',
  ].join('\n'), { message_thread_id: msg.message_thread_id });
}

// --- Register commands ---
bot.onText(/\/spawn\s*(.*)/, (msg, match) => handleSpawn(msg, match[1]));
bot.onText(/\/kill$/, (msg) => handleKill(msg));
bot.onText(/\/status$/, (msg) => handleStatus(msg));
bot.onText(/\/help$/, (msg) => handleHelp(msg));
bot.onText(/\/start$/, (msg) => handleHelp(msg));

// --- Message handler: text in topic → inject as prompt ---
bot.on('message', (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  if (!msg.text) return;

  const topicId = msg.message_thread_id;
  if (!topicId) return;

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) return;

  const session = sm.getSession(sessionId);
  if (!session) return;

  try {
    sm.sendPrompt(sessionId, msg.text);
    startThinkingTimer(sessionId);
    bot.sendMessage(msg.chat.id, '<i>Sent to Claude</i>', {
      parse_mode: 'HTML',
      message_thread_id: topicId,
      reply_to_message_id: msg.message_id,
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
  if (!topicId) {
    return bot.answerCallbackQuery(query.id, { text: 'No topic context' });
  }

  const sessionId = topicToSession.get(topicId);
  if (!sessionId) {
    return bot.answerCallbackQuery(query.id, { text: 'No session for this topic' });
  }

  const action = query.data;
  let promptText = '';

  switch (action) {
    case 'action:continue':
      promptText = '';
      wez.sendText(sm.getSession(sessionId).paneId, '');
      break;
    case 'action:tests':
      promptText = 'run the tests';
      sm.sendPrompt(sessionId, promptText);
      break;
    case 'action:commit':
      promptText = 'commit the changes';
      sm.sendPrompt(sessionId, promptText);
      break;
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

  if (action !== 'action:status') {
    startThinkingTimer(sessionId);
    await bot.answerCallbackQuery(query.id, {
      text: promptText ? `Sent: "${promptText}"` : 'Sent Enter',
    });
  }
});

// --- Completion poll loop ---
let completionTimer = null;

function startCompletionLoop() {
  if (completionTimer) return;
  completionTimer = setInterval(async () => {
    const allSessions = sm.listSessions();
    if (allSessions.length === 0) return;

    const newlyWaiting = sm.pollAll();
    if (newlyWaiting.length > 0) {
      console.log(`[wezbridge] ${newlyWaiting.length} session(s) completed`);
    }

    for (const session of newlyWaiting) {
      const info = sessionToTopic.get(session.id);
      if (!info) continue;

      try {
        await deleteThinkingMessage(session.id);

        const raw = wez.getFullText(session.paneId, 500);
        const response = outputParser.extractLastResponse(raw);

        if (!response) {
          await sendMsg(info.chatId, '<i>Claude finished (no output detected)</i>', {
            message_thread_id: info.topicId,
            ...actionKeyboard(),
          });
          continue;
        }

        const summarized = outputParser.summarizeIfLong(response);
        const html = outputParser.formatForTelegram(summarized);

        const chunks = splitMessage(html, 4000);
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await sendMsg(info.chatId, chunks[i], {
            message_thread_id: info.topicId,
            ...(isLast ? actionKeyboard() : {}),
          });
        }
      } catch (err) {
        console.error(`[wezbridge] Error sending response for ${session.id}:`, err.message || err);
      }
    }
  }, POLL_MS);
}

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
    if (breakAt < maxLen * 0.5) breakAt = maxLen;

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
          project: PROJECT_MAP[projectName] || projectName,
          taskId: null,
          status: 'waiting',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          lastOutput: '',
          promptHistory: [],
        };
        sm._registerSession(session);

        sessionToTopic.set(sessionId, { topicId, chatId: GROUP_ID, projectName });
        topicToSession.set(topicId, sessionId);
        console.log(`[wezbridge] Seeded: topic ${topicId} <-> pane ${paneId} (${projectName})`);
      }
      i++;
    }
  }
}

// --- Startup ---
function startBot() {
  console.log('[wezbridge] Starting...');
  console.log(`[wezbridge] Group: ${GROUP_ID}`);
  console.log(`[wezbridge] Poll: ${POLL_MS}ms`);

  const projectNames = Object.keys(PROJECT_MAP);
  if (projectNames.length > 0) {
    console.log(`[wezbridge] Projects: ${projectNames.join(', ')}`);
  }

  seedFromArgs();
  startCompletionLoop();

  bot.on('message', (msg) => {
    if (msg.chat.id !== GROUP_ID) {
      console.log(`[wezbridge] Message from chat ${msg.chat.id} (${msg.chat.title || msg.chat.username || 'unknown'})`);
    }
  });

  console.log('[wezbridge] Bot is running. Send /help in the group.');
}

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('[wezbridge] Shutting down...');
  if (completionTimer) clearInterval(completionTimer);
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[wezbridge] Shutting down...');
  if (completionTimer) clearInterval(completionTimer);
  bot.stopPolling();
  process.exit(0);
});

if (require.main === module) {
  startBot();
}

module.exports = { startBot, bot, sessionToTopic, topicToSession, PROJECT_MAP };
