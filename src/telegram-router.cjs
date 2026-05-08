'use strict';
/**
 * telegram-router.cjs — Maps Telegram thread_id → project for the OmniClaude
 * pane to dispatch inbound DMs to the right worker pane.
 *
 * The Telegram channel plugin already attaches `message_thread_id` in the
 * channel notification meta (see plugin server.ts patch from 2026-04-11),
 * but no consumer was reading it. Result: every group message landed in
 * whichever pane was paired, regardless of topic.
 *
 * This library is the missing consumer. The OmniClaude pane calls
 * routeInbound({ chat_id, message_thread_id }) and gets back:
 *   - action: 'route' / 'self' / 'unknown_chat' / 'unknown_topic'
 *   - project: project name to forward to (when action is 'route')
 *
 * The OmniClaude pane then either handles the message inline (action 'self')
 * or forwards via mcp__wezbridge__send_prompt to the matching pane.
 *
 * The topic→project map lives at ~/.omniclaude/telegram-topics.json and is
 * the same file telegram-streamer.cjs uses for outbound topic addressing.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_PATH = path.join(os.homedir(), '.omniclaude', 'telegram-topics.json');

/**
 * Read the topic-mapping JSON and build bidirectional maps.
 *
 * Returns { byTopic, byProject, groupId, path } where:
 *   - byTopic:   Map<thread_id (number), project_name>
 *   - byProject: Map<project_name, thread_id (number)>
 *   - groupId:   string ("-100..." chat_id of the wezbridge Telegram group)
 *   - path:      the file path that was loaded (for error messages)
 *
 * Returns empty maps + null groupId if the file is missing.
 */
function loadTopicMap(opts = {}) {
  const filePath = opts.path || DEFAULT_PATH;
  const result = { byTopic: new Map(), byProject: new Map(), groupId: null, path: filePath };
  if (!fs.existsSync(filePath)) return result;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return result;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === '_group_id') {
      result.groupId = String(value);
      continue;
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      result.byTopic.set(value, key);
      result.byProject.set(key, value);
    }
  }
  return result;
}

/**
 * Decide what to do with an inbound Telegram channel block.
 *
 * @param {object} inbound - { chat_id (string|number), message_thread_id (number|string|null) }
 * @param {object} opts    - { topicMap?: returned by loadTopicMap, path?: override }
 * @returns {object} { action, project, threadId } where action ∈ {
 *   'route'         — group + known topic, forward to project's pane,
 *   'self'          — handle in OmniClaude pane (private DM, group general,
 *                     or thread that has no project mapping is treated as self
 *                     ONLY if no map exists — see 'unknown_topic' otherwise),
 *   'unknown_chat'  — not the configured group; do nothing,
 *   'unknown_topic' — group + thread_id, but thread_id has no project mapping,
 * }
 */
function routeInbound(inbound, opts = {}) {
  const map = opts.topicMap || loadTopicMap({ path: opts.path });
  const chatId = String(inbound.chat_id);
  const threadId = (inbound.message_thread_id !== undefined && inbound.message_thread_id !== null && inbound.message_thread_id !== '')
    ? Number(inbound.message_thread_id)
    : null;

  const isGroup = chatId.startsWith('-');

  // Private DM (chat_id is the user's own user_id, not a group id) → self
  if (!isGroup) {
    return { action: 'self', project: null, threadId };
  }

  // Group, but not the configured one → ignore
  if (map.groupId && chatId !== map.groupId) {
    return { action: 'unknown_chat', project: null, threadId };
  }

  // Group main thread (no topic) → self (handle in OmniClaude pane)
  if (threadId === null) {
    return { action: 'self', project: null, threadId: null };
  }

  const project = map.byTopic.get(threadId);
  if (project) {
    return { action: 'route', project, threadId };
  }

  return { action: 'unknown_topic', project: null, threadId };
}

module.exports = {
  DEFAULT_PATH,
  loadTopicMap,
  routeInbound,
};
