#!/usr/bin/env node
/**
 * Telegram Session Streamer v2 — ported from openclaw2claude/telegram-bot.cjs
 *
 * Streams Claude session output to Telegram Group Topics with live updates.
 * Each watched project has ONE message that gets edited via editMessageText
 * as the session produces new output.
 *
 * Key design decisions (learned from old openclaw2claude):
 *  - Run as STANDALONE process (NOT via Claude's Monitor tool)
 *  - Hash-based change detection to skip identical content
 *  - HTML formatting with tool-call highlighting
 *  - Fallback editMessageText if no message_id yet → sendMessage then store id
 *  - Consecutive error tracking (3 failures → stop streaming that pane)
 *  - Preserve spacing: single empty lines OK, breathing room before bullets
 *  - 4050 char budget (Telegram 4096 minus overhead for HTML tags)
 *  - Auto-truncate from the top if too long
 *
 * Launched from scripts/omniclaude-forever.sh as a background process:
 *   node src/telegram-streamer.cjs &
 */

const fs = require('fs');
const { readFileSync, existsSync } = fs;
const path = require('path');
const os = require('os');
const https = require('https');

// --- Config ---
// Bumped 5s → 10s on 2026-04-19 as part of wezterm CLI call-rate reduction.
// Combined with wezterm.cjs listPanes/getFullText TTL caches, this cuts
// steady-state wezterm CLI spawn rate roughly in half per pane per minute.
const POLL_INTERVAL_MS = parseInt(process.env.STREAMER_POLL_MS || '10000', 10);
const MIN_EDIT_INTERVAL_MS = 8000;    // Min 8s between edits per pane (Telegram rate limit)
const LIVE_LINES = 40;                 // Show last 40 lines
const MAX_HTML_LENGTH = 4050;          // Telegram 4096 minus overhead
const ERROR_LIMIT = 3;                 // Stop streaming pane after 3 consecutive errors
const HEARTBEAT_MS = 300000;           // 5 min heartbeat to stdout
// Streamer mode:
//   'raw'    = [DEFAULT] one edit-in-place message per project, dumps last
//              LIVE_LINES of scrollback verbatim. User confirmed this is the
//              most useful format — captures tables, checklists, reports
//              inline (card format was too terse; events format scrolled).
//   'card'   = structured digest (Ctx, Now, Commits, Actions, Errors, A2A).
//              Too compressed for sessions with rich output. Opt-in only.
//   'events' = one message per meaningful event, thread. Scrolls on every
//              new event. Opt-in only.
const STREAMER_MODE = (process.env.STREAMER_MODE || 'raw').toLowerCase();
const EVENT_MIN_INTERVAL_MS = 10000;   // Min 10s between event posts per project — Telegram group limit is ~1 msg/sec shared across threads, 10s per project × 10 projects ≈ safe
const EVENT_SCROLLBACK_LINES = 120;    // How many tail lines to scan for events each poll

// --- State ---
const streams = new Map(); // project -> { lastHash, lastSentAt, messageId, errorCount }
let lastUpdateId = 0;      // Telegram getUpdates cursor
const projectToPane = new Map(); // project -> pane_id (refreshed on each discovery)

// --- Load token and config ---
let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let GROUP_ID = process.env.TELEGRAM_GROUP_ID;

if (!BOT_TOKEN || !GROUP_ID) {
  const envPath = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m) {
        if (m[1] === 'TELEGRAM_BOT_TOKEN' && !BOT_TOKEN) BOT_TOKEN = m[2];
        if (m[1] === 'TELEGRAM_GROUP_ID' && !GROUP_ID) GROUP_ID = m[2];
      }
    }
  } catch (err) {
    stderr(`Cannot read ${envPath}: ${err.message}`);
  }
}

if (!BOT_TOKEN || !GROUP_ID) {
  stderr('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID');
  process.exit(1);
}

const topicConfigPath = path.join(os.homedir(), '.omniclaude', 'telegram-topics.json');
let topicMap = {};
try {
  topicMap = JSON.parse(readFileSync(topicConfigPath, 'utf8'));
} catch (err) {
  stderr(`Cannot read ${topicConfigPath}: ${err.message}`);
  process.exit(1);
}

function stderr(msg) {
  process.stderr.write(`[telegram-streamer] ${new Date().toISOString()} ${msg}\n`);
}

function emit(event) {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {}
}

// --- Pane identity (agent + model) ---
const paneAliasesPath = path.join(os.homedir(), '.omniclaude', 'pane-aliases.json');
let paneAliases = {};
function loadPaneAliases() {
  try {
    paneAliases = JSON.parse(readFileSync(paneAliasesPath, 'utf8'));
  } catch {
    paneAliases = {};
  }
}
loadPaneAliases();
// Reload every minute so user edits take effect without streamer restart
setInterval(loadPaneAliases, 60000);

// Detect "<agent>-<model>" label (e.g. "claude-opus", "codex-gpt5") from pane.
// Preference: pane-aliases.json → title/content heuristics → null.
function detectAgentModel(pane, rawText) {
  const alias = paneAliases[String(pane.pane_id)];
  if (alias) return String(alias);

  const title = String(pane.title || '');
  const text = String(rawText || '');

  let agent = null;
  if (/claude/i.test(title) || /[✳✶✻✽✢]/.test(title)) agent = 'claude';
  else if (/Model:\s*(Opus|Sonnet|Haiku)/i.test(text) && /Ctx:\s*\d+/.test(text)) agent = 'claude';
  else if (/\bgpt[- ]?\d/i.test(text)) agent = 'codex';

  let model = null;
  const claudeModel = text.match(/Model:\s*(Opus|Sonnet|Haiku)/i);
  if (claudeModel) {
    model = claudeModel[1].toLowerCase();
  } else {
    const gptModel = text.match(/\bgpt[- ]?(\d+)(?:\.\d+)?/i);
    if (gptModel) model = `gpt${gptModel[1]}`;
  }

  if (agent && model) return `${agent}-${model}`;
  if (agent) return agent;
  return null;
}

// --- WezTerm integration ---
const wez = require('./wezterm.cjs');

function discoverPanes() {
  try { return wez.listPanes(); } catch { return []; }
}

function getFullText(paneId) {
  try { return wez.getFullText(paneId); } catch { return ''; }
}

function detectProject(pane) {
  const title = String(pane.title || '').toLowerCase();
  const cwdRaw = String(pane.cwd || '').split(/[/\\]/).join('/');
  // Reserved keys are config, not projects
  const reserved = new Set(['_group_id', '_blocklist']);
  const projects = Object.keys(topicMap).filter(k => !reserved.has(k));

  // Match by EXACT path segment (not arbitrary substring).
  // Prior bug: cwd.includes('app') matched 'Py Apps' → wezbridge routed to app topic.
  const cwdSegments = cwdRaw.replace(/\/+$/, '').toLowerCase().split('/').filter(Boolean);
  const titleWords = title.split(/[\s/\\]+/).filter(Boolean);

  for (const p of projects) {
    const pl = p.toLowerCase();
    if (cwdSegments.includes(pl)) return p;
    if (titleWords.includes(pl)) return p;
  }

  // Fallback: derive project name from cwd basename. New projects get auto-topic.
  if (cwdRaw) {
    const base = cwdRaw.replace(/\/+$/, '').split('/').pop();
    if (base && base !== '/' && base.length > 0) return base.toLowerCase();
  }
  return null;
}

// Atomic write: tmp + rename, so a crash mid-write doesn't corrupt topics.json
function persistTopicMap() {
  try {
    const tmp = topicConfigPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(topicMap, null, 2));
    fs.renameSync(tmp, topicConfigPath);
    return true;
  } catch (err) {
    stderr(`Failed to persist topic map: ${err.message}`);
    return false;
  }
}

// Tracks projects we already tried to create and failed, so we don't retry every poll
const topicCreationFailed = new Set();
// Tracks projects with creation in flight, so concurrent polls don't double-create
const topicCreationInFlight = new Set();

async function createTopicIfMissing(project) {
  // Reserved or already mapped
  if (project === '_group_id' || project === '_blocklist') return null;
  if (topicMap[project]) return topicMap[project];
  // Blocklist: user-controlled opt-out of auto-creation
  const blocklist = Array.isArray(topicMap._blocklist) ? topicMap._blocklist : [];
  if (blocklist.includes(project)) return null;
  if (topicCreationFailed.has(project)) return null;
  if (topicCreationInFlight.has(project)) return null;

  topicCreationInFlight.add(project);
  try {
    // Defensive re-read: another streamer instance might have created it concurrently
    try {
      const fresh = JSON.parse(readFileSync(topicConfigPath, 'utf8'));
      if (fresh[project]) {
        topicMap[project] = fresh[project];
        return topicMap[project];
      }
    } catch { /* ignore — keep in-memory map */ }

    // Telegram name limit: 128 chars
    const name = String(project).slice(0, 128);
    const result = await telegramPost('createForumTopic', {
      chat_id: GROUP_ID,
      name,
    });

    if (!result.ok || !result.result || !result.result.message_thread_id) {
      const desc = result.description || 'unknown';
      stderr(`createForumTopic failed for "${project}": ${desc}`);
      // If the group isn't a forum, no point retrying — block permanently
      if (/not.*forum|forum.*disabled|chat_admin_required|topic.*creation.*disabled/i.test(desc)) {
        topicCreationFailed.add(project);
      }
      return null;
    }

    const threadId = result.result.message_thread_id;
    topicMap[project] = threadId;
    persistTopicMap();
    stderr(`Created topic "${project}" → thread ${threadId}`);
    emit({ source: 'telegram-streamer', event: 'topic_created', project, thread_id: threadId });
    return threadId;
  } finally {
    topicCreationInFlight.delete(project);
  }
}

// --- ANSI stripping + Claude chrome removal ---
function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b[78DEHM]/g, '');
}

const CHROME_PATTERNS = [
  // Claude chrome / status bar lines
  /^.*Total cost:.*$/,
  /^.*tokens (remaining|used).*$/i,
  /^\s*Model:.*$/,
  /^\s*Ctx:.*\d+%.*$/,
  /^\s*Session:.*\d+%.*$/,
  /^\s*Weekly:.*\d+%.*$/,
  /^\s*cwd:.*$/,
  /^\s*Reset:.*$/,
  /^\s*Thinking:.*$/,
  /^\s*⏵⏵.*bypass permissions.*$/,
  /^\s*[·•●]\s*Tip:.*$/,
  /^\s*[·•●]\s*Ran \d+ stop hook.*$/,
  // Horizontal rule separator lines (Claude's ──── dividers)
  /^[\s─━═]{20,}$/,
  // Box-drawing ASCII table borders (top, bottom, separators)
  /^\s*[┌├└┬┴┼╭╮╯╰]+[─━═┌┐└┘├┤┬┴┼╭╮╯╰]*[┐┤┘]\s*$/,
  // Tool-result 1-liner boilerplate — the `●` tool-call line above already
  // tells you WHAT ran, so the ⎿ ack is redundant and just wastes space.
  /^\s*⎿\s*Prompt sent to pane \d+\./,
  /^\s*⎿\s*Key ".*" sent to pane \d+\./,
  /^\s*⎿\s*Updated task #\d+ status\s*$/,
  /^\s*⎿\s*Task #\d+ created successfully.*$/,
  // OmniClaude self-observation events — watcher event + "Standing by" acks
  // are pure meta-telemetry that dominate the feed but never carry new signal.
  // Keep substantive `●` lines (tool calls, real findings) — strip only the
  // acks that always say the same thing.
  /^\s*●\s*Monitor event: ".*"\s*$/,
  /^\s*●\s*Self-event\.?\s*([^.]*)?(Standing by\.?|Watching\.?|Awaiting.*)\s*$/,
  /^\s*●\s*Self-event \+ heartbeat\..*$/,
  /^\s*●\s*Heartbeat\.?\s*(Standing by\.?)?\s*$/,
  /^\s*●\s*Metrics \+ heartbeat\..*Standing by\.?\s*$/,
  // Pane N <state>. <acknowledgement>. — covers "idle|working|false positive"
  // with any of "Standing by|Watching|Ignored" as the follow-up verb.
  /^\s*●\s*Pane \d+\s+.{1,40}\.\s*(Standing by|Watching|Ignored|Awaiting.*)\.?\s*$/,
  /^\s*●\s*No new.*learnings.*Standing by\.?\s*$/,
  /^\s*●\s*Claim \d+\s+(saved|guardado|guardada)\.\s*Standing by\.?\s*$/,
  // Stop-hook error body (the `● Ran N stop hook` prefix line is already
  // filtered above; this catches the multi-line boilerplate that follows).
  /^\s*⎿\s*Stop hook error:\s*AUTO-SAVE checkpoint.*$/,
  /^\s*mcp__memorymaster__ingest_claim\. Ingest:.*$/,
  /^\s*credentials, IPs, tokens, or code\. After saving.*$/,
];

function stripClaudeChrome(text) {
  return text
    .split('\n')
    .filter(line => !CHROME_PATTERNS.some(p => p.test(line)))
    .join('\n');
}

// Collapse multi-line `●  <server> - <tool> (MCP)(arg: "...really long...")`
// call blocks. Claude TUI wraps long MCP args across many deeply-indented
// continuation lines (observed: `ingest_claim` call with full `text:` payload
// can wrap 6-15 lines). The `●` line stays visible so readers see WHICH tool
// ran; continuation lines collapse to an ellipsis.
//
// Detection: a `●` line containing `(MCP)(` where subsequent lines are
// heavily indented (column 20+) and don't start with a new `●` or `⎿`.
function collapseMcpCalls(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^(\s*)●\s+([^(]+?)\s+\(MCP\)\(/);
    if (!m) { out.push(l); continue; }
    const [, indent, toolName] = m;
    const paddingThreshold = indent.length + 10;
    const block = [l];
    let j = i + 1;
    while (j < lines.length) {
      const cont = lines[j];
      if (!cont.trim()) break;
      const firstNonSpace = cont.search(/\S/);
      if (firstNonSpace < paddingThreshold) break;
      if (/^\s*[●⎿]/.test(cont)) break;
      block.push(cont);
      j++;
    }
    if (block.length > 1) {
      out.push(`${indent}● ${toolName.trim()} (MCP)(…)`);
      i = j - 1;
    } else {
      out.push(l);
    }
  }
  return out.join('\n');
}

// Collapse `⎿`-initiated tool-result blocks longer than `maxLines` into a 1-line
// summary. Claude TUI renders MCP results as a `⎿` marker followed by indented
// continuation lines; `ingest_claim` JSON, `query_memory` rows, etc. can span
// 30+ lines and dominate the 40-line live window. The `●` tool-call line stays
// visible so viewers still see which tool ran.
function collapseToolResults(text, maxLines = 3) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(/^(\s*)⎿\s?(.*)$/);
    if (!m) { out.push(l); continue; }
    const [, indent, firstPayload] = m;
    const minContIndent = indent.length + 2;
    const block = [l];
    let j = i + 1;
    while (j < lines.length) {
      const cont = lines[j];
      if (!cont.trim()) break;
      const firstNonSpace = cont.search(/\S/);
      if (firstNonSpace < minContIndent) break;
      if (/^\s*[●⎿]/.test(cont)) break;
      block.push(cont);
      j++;
    }
    if (block.length > maxLines) {
      const preview = firstPayload.replace(/^[\s{["]+/, '').slice(0, 50).trim();
      const suffix = preview ? ` ${preview}…` : '';
      out.push(`${indent}⎿ [${block.length} lines]${suffix}`);
      i = j - 1;
    } else {
      out.push(...block);
      i = j - 1;
    }
  }
  return out.join('\n');
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// --- Telegram HTTPS calls ---
function telegramPost(method, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          // Synthesize description when Telegram returns ok:false without one
          // (happens on 400 "message is not modified" + other bare rejections).
          // Preserves error_code + http status for debugging the empty-error bug.
          if (parsed && parsed.ok === false && !parsed.description) {
            parsed.description = `http ${res.statusCode} error_code=${parsed.error_code || 'unknown'} raw=${buf.slice(0, 300).replace(/\s+/g, ' ')}`;
          }
          // TEMPORARY DEBUG: also log raw buf on any non-ok response so we
          // can confirm what Telegram is actually returning.
          if (parsed && parsed.ok === false) {
            process.stderr.write(`[telegram-streamer-debug] ${method} ok:false http=${res.statusCode} buf=${buf.slice(0, 300).replace(/\s+/g, ' ')}\n`);
          }
          resolve(parsed);
        } catch {
          resolve({ ok: false, description: `parse error: http ${res.statusCode} body=${buf.slice(0, 200).replace(/\s+/g, ' ')}` });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, description: `network error: ${e.message}` }));
    req.write(data);
    req.end();
  });
}

async function sendMsg(text, threadId, { notify = false } = {}) {
  return telegramPost('sendMessage', {
    chat_id: GROUP_ID,
    message_thread_id: threadId,
    text,
    parse_mode: 'HTML',
    // Live-stream edits stay silent; decision pushes exist to PING the
    // operator, so they opt into a real notification.
    disable_notification: !notify,
  });
}

async function editMsgSafe(messageId, text, threadId) {
  const result = await telegramPost('editMessageText', {
    chat_id: GROUP_ID,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  });
  return result;
}

// --- Format individual lines with HTML highlighting (ported from openclaw2claude) ---
function formatLiveLines(lines) {
  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    // Tool call lines: ● Tool(args) → wrench emoji + bold
    if (/^[●•]\s/.test(trimmed) && /\(.*\)/.test(trimmed)) {
      return `🔧 <b>${escapeHtml(trimmed.slice(2))}</b>`;
    }
    // Bullet points (regular ● text) → keep bullet
    if (/^[●•]\s/.test(trimmed)) {
      return `● ${escapeHtml(trimmed.slice(2))}`;
    }
    // Tree/result lines: ⎿ └ ├ → indented code
    if (/^[⎿└├]\s*/.test(trimmed)) {
      return `  <code>${escapeHtml(trimmed)}</code>`;
    }
    // Thinking/cooking indicators → italic
    if (/^(✻\s*\w+|Thinking|Choreographing|Brewed|Running|Cooked|Baked|Sautéing|Waddling|Simmering|Marinating)/i.test(trimmed)) {
      return `⏳ <i>${escapeHtml(trimmed)}</i>`;
    }
    // Prompt waiting: ❯
    if (/^[❯>]\s*$/.test(trimmed)) {
      return `<b>❯</b> <i>waiting for input</i>`;
    }
    // Permission prompts
    if (/Do you want|❯\s*1\.\s*Yes|\(y\/n\)/i.test(trimmed)) {
      return `🚨 <b>${escapeHtml(trimmed)}</b>`;
    }
    // Indented code/output → code tag
    if (line.startsWith('    ') || line.startsWith('\t')) {
      return `<code>${escapeHtml(line)}</code>`;
    }
    // Default → plain escaped
    return escapeHtml(line);
  }).join('\n');
}

// Format the pane-identity chip shown in the Telegram header.
//  - Solo pane in project:      `[project · agent-model]`  (e.g. `[memorymaster · claude-opus]`)
//  - ≥2 panes same project:     `[project-agent · model]`   (e.g. `[app-codex · gpt5]`)
//  - No identity detected:      `[project]`
function formatPaneLabel(project, identity, isDuplicate) {
  if (!identity) return `[${project}]`;
  const firstHyphen = identity.indexOf('-');
  const agent = firstHyphen > 0 ? identity.slice(0, firstHyphen) : identity;
  const model = firstHyphen > 0 ? identity.slice(firstHyphen + 1) : null;
  if (isDuplicate) return model ? `[${project}-${agent} · ${model}]` : `[${project}-${agent}]`;
  return `[${project} · ${identity}]`;
}

// --- Build the live view HTML ---
function buildLiveHtml(project, paneId, rawText, startTime, paneLabel) {
  const cleaned = collapseToolResults(stripClaudeChrome(collapseMcpCalls(stripAnsi(rawText))))
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Preserve spacing: keep single empty lines, add breathing room before bullets
  const rawLines = cleaned.split('\n');
  const lines = [];
  let emptyRun = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i];
    if (!l.trim()) {
      emptyRun++;
      if (emptyRun <= 1) lines.push('');
    } else {
      if (/^\s*[●•]/.test(l) && lines.length > 0 && lines[lines.length - 1]?.trim()) {
        lines.push('');
      }
      emptyRun = 0;
      lines.push(l);
    }
  }

  const visible = lines.slice(-LIVE_LINES);
  if (visible.join('').trim() === '') {
    return `<b>🔴 ${escapeHtml(project)}</b> <code>${escapeHtml(paneLabel)}</code>\n\n<i>Terminal cleared. Waiting for output...</i>`;
  }

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;
  const header = `<b>🔴 LIVE: ${escapeHtml(project)}</b> <code>${escapeHtml(paneLabel)}</code> (${elapsedStr})\n\n`;

  // Fit within 4050 chars — trim from top if too long
  // Use plain escaped text inside <pre><code class="language-bash">...</code></pre>
  // (matches old openclaw2claude format — gives bash syntax highlight + native copy button)
  // Telegram's client has a content heuristic: if the content doesn't look shell-ish,
  // it may ignore the language-bash class. Force shell detection by replacing empty
  // Claude prompt lines (❯ or >) with a canonical bash prompt ($).
  function shellify(ls) {
    return ls.map((l, i, arr) => {
      if (i === arr.length - 1 && /^[❯>]\s*$/.test(l.trim())) return '$';
      return l;
    });
  }
  let showLines = shellify(visible);
  let html = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = escapeHtml(showLines.join('\n'));
    html = `${header}<pre><code class="language-bash">${body}</code></pre>`;
    if (html.length <= MAX_HTML_LENGTH) break;
    showLines = shellify(showLines.slice(Math.ceil(showLines.length * 0.2)));
  }
  if (html.length > MAX_HTML_LENGTH) {
    const body = escapeHtml(shellify(showLines.slice(-15)).join('\n'));
    html = `${header}<pre><code class="language-bash">${body}</code></pre>`;
  }

  return html;
}

// --- Structured status card (STREAMER_MODE=card, DEFAULT) ---
// Extracts meaningful sections from scrollback and formats them as a digest.
// Edits the SAME message each poll (no scroll churn in Telegram UI).
function extractSections(rawText) {
  const tail = rawText.split('\n').slice(-200).join('\n');
  const sections = { commits: [], tools: [], errors: [], a2as: [], current: '', ctx: '?', reset: '' };

  // Commits: "[branch abc1234] message"
  const seenShas = new Set();
  for (const m of tail.matchAll(/\[([\w\/-]+)\s+([a-f0-9]{7,})\]\s+(.+?)(?=\n|$)/g)) {
    if (seenShas.has(m[2])) continue;
    seenShas.add(m[2]);
    sections.commits.push({ sha: m[2].slice(0, 7), msg: m[3].trim().replace(/\s+/g, ' ').slice(0, 90) });
  }
  sections.commits = sections.commits.slice(-3);

  // File-mod tools (Edit/Write/MultiEdit)
  for (const m of tail.matchAll(/^●\s+(Edit|Write|MultiEdit)\(([^\n)]{0,100})\)?/gm)) {
    sections.tools.push({ tool: m[1], arg: m[2].trim().replace(/\s+/g, ' ').slice(0, 70) });
  }
  // High-signal Bash only (git commit/push/tag, docker, npm test, go test, make)
  for (const m of tail.matchAll(/^●\s+Bash\(([^\n)]{0,100})/gm)) {
    const arg = m[1].trim().replace(/\s+/g, ' ');
    if (!/\b(git\s+(commit|push|tag|rebase|merge|reset\s+--hard)|docker\s+compose|npm\s+(run|test|build)|npx\s+run|go\s+test|cargo\s+(test|build)|pnpm\s+(run|test|build)|make\s+\w+)\b/i.test(arg)) continue;
    sections.tools.push({ tool: 'Bash', arg: arg.slice(0, 70) });
  }
  sections.tools = sections.tools.slice(-4);

  // Errors (excluding streamer's own noise)
  for (const m of tail.matchAll(/^(.{0,40}(?:ERROR|Exception|FATAL|FAIL):\s*.{0,150})/gm)) {
    const line = m[1].trim().replace(/\s+/g, ' ');
    if (/Edit failed for|Send failed for|Stop hook error|Event (poll|send) (error|fail)/.test(line)) continue;
    sections.errors.push(line.slice(0, 140));
  }
  sections.errors = sections.errors.slice(-2);

  // A2A envelopes — last 2
  for (const m of tail.matchAll(/\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)\]/g)) {
    sections.a2as.push({ from: m[1], to: m[2], corr: m[3].slice(0, 40), type: m[4] });
  }
  sections.a2as = sections.a2as.slice(-2);

  // "Current activity" — last meaningful line (● bullet, ✻/✢/* thinking indicator)
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^Model:|^Session:|^Ctx:|^cwd:|^Reset:|bypass permissions|auto mode on|plan mode on|new task\? \/clear/.test(l)) continue;
    if (/^Found \d+ setting/.test(l)) continue;
    if (/^[─│]+/.test(l)) continue;
    if (/^❯\s*$/.test(l)) continue;
    if (/^⎿\s/.test(l)) continue;
    // Thinking indicator: ✻ Brewing... / ✢ Levitating... / * Processing...
    if (/^[✻✢*]\s/.test(l)) { sections.current = l.replace(/[…·]/g, '').slice(0, 140); break; }
    // Tool/result bullet
    if (/^[●◉◎]\s/.test(l)) { sections.current = l.slice(0, 140); break; }
    // Any other substantive text
    if (l.length > 3) { sections.current = l.slice(0, 140); break; }
  }
  if (!sections.current) sections.current = '(idle)';

  // Stats from the status bar
  const ctxM = rawText.match(/Ctx:\s*(\d+(?:\.\d+)?)%/);
  if (ctxM) sections.ctx = `${Math.round(parseFloat(ctxM[1]))}%`;
  const resetM = rawText.match(/Reset:\s*([^\s]+(?:\s\d+m)?)/);
  if (resetM) sections.reset = resetM[1];

  return sections;
}

function buildCardHtml(project, paneLabel, rawText) {
  const s = extractSections(rawText);
  const parts = [];
  const stats = [`Ctx ${s.ctx}`];
  if (s.reset) stats.push(`reset ${s.reset}`);
  parts.push(`<b>📌 ${escapeHtml(project)}</b> <code>${escapeHtml(paneLabel)}</code>`);
  parts.push(`<i>${stats.join(' · ')}</i>`);
  parts.push('');
  parts.push(`<b>⚡ Now:</b> ${escapeHtml(s.current)}`);

  if (s.commits.length) {
    parts.push('');
    parts.push('<b>📝 Commits</b>');
    for (const c of s.commits) {
      parts.push(`  • <code>${escapeHtml(c.sha)}</code> ${escapeHtml(c.msg)}`);
    }
  }

  if (s.tools.length) {
    parts.push('');
    parts.push('<b>🔧 Recent actions</b>');
    for (const t of s.tools) {
      parts.push(`  • ${escapeHtml(t.tool)}: <code>${escapeHtml(t.arg)}</code>`);
    }
  }

  if (s.errors.length) {
    parts.push('');
    parts.push(`<b>❗ Errors</b>`);
    for (const e of s.errors) parts.push(`  • <code>${escapeHtml(e)}</code>`);
  }

  if (s.a2as.length) {
    parts.push('');
    parts.push('<b>📡 A2A</b>');
    for (const a of s.a2as) {
      parts.push(`  • ${escapeHtml(a.type)} pane-${a.from}→pane-${a.to} <code>${escapeHtml(a.corr)}</code>`);
    }
  }

  const html = parts.join('\n');
  return html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
}

// --- Event detection (STREAMER_MODE=events) ---
// Scans the tail of a pane's scrollback for meaningful events. Each event
// has a fingerprint used for dedup across polls (so a commit that stays
// visible for multiple poll cycles only posts once).
function detectEvents(text) {
  const events = [];
  if (!text) return events;
  const tail = text.split('\n').slice(-EVENT_SCROLLBACK_LINES).join('\n');

  // Commits: "[branch abc1234] message"
  for (const m of tail.matchAll(/\[([\w\/-]+)\s+([a-f0-9]{7,})\]\s+(.+?)(?=\n|$)/g)) {
    const sha = m[2];
    const msg = m[3].trim().replace(/\s+/g, ' ').slice(0, 180);
    events.push({
      type: 'commit',
      title: `📝 Commit <code>${escapeHtml(sha)}</code>`,
      detail: escapeHtml(msg),
      fingerprint: `commit:${sha}`,
    });
  }

  // Pushes: "abc1234..def5678 branch -> branch" line
  for (const m of tail.matchAll(/^\s+([a-f0-9]{7,}\.\.[a-f0-9]{7,})\s+(\S+)\s+->\s+(\S+)/gm)) {
    events.push({
      type: 'push',
      title: `🚀 Pushed <code>${escapeHtml(m[1])}</code>`,
      detail: `${escapeHtml(m[2])} → ${escapeHtml(m[3])}`,
      fingerprint: `push:${m[1]}`,
    });
  }
  // New-branch push
  for (const m of tail.matchAll(/\*\s+\[new branch\]\s+(\S+)\s+->\s+(\S+)/g)) {
    events.push({
      type: 'push',
      title: `🌱 New branch pushed`,
      detail: `${escapeHtml(m[1])} → ${escapeHtml(m[2])}`,
      fingerprint: `push-new:${m[1]}-${m[2]}`,
    });
  }

  // File-modification tool calls (Edit/Write/MultiEdit) — rare, high-signal.
  // Skip Bash/Read/Glob/Grep entirely: they fire many times per second during
  // active work and saturate Telegram's 20msg/min group rate limit. Commits
  // and pushes detected separately provide the git-activity signal instead.
  for (const m of tail.matchAll(/^●\s+(Edit|Write|MultiEdit)\(([^\n]{0,120})/gm)) {
    const tool = m[1];
    const arg = m[2].replace(/\s+/g, ' ').slice(0, 100).trim();
    events.push({
      type: 'tool',
      title: `✏️ ${tool}`,
      detail: `<code>${escapeHtml(arg)}</code>`,
      fingerprint: `tool:${tool}:${arg.slice(0, 60)}`,
    });
  }

  // High-signal Bash calls only: git commit/push/tag, docker up/down/restart,
  // npm run test/build, npx run, go test. Everything else skipped.
  for (const m of tail.matchAll(/^●\s+Bash\(([^\n]{0,120})/gm)) {
    const arg = m[1].replace(/\s+/g, ' ').slice(0, 100).trim();
    if (!/\b(git\s+(commit|push|tag|rebase|merge|reset\s+--hard)|docker\s+compose|npm\s+(run|test|build)|npx\s+run|go\s+test|cargo\s+(test|build)|pnpm\s+(run|test|build)|make\s+\w+)\b/i.test(arg)) continue;
    events.push({
      type: 'tool',
      title: `🔧 Bash`,
      detail: `<code>${escapeHtml(arg)}</code>`,
      fingerprint: `bash:${arg.slice(0, 80)}`,
    });
  }

  // Errors: standalone "ERROR" / "Exception" / "FATAL" markers
  for (const m of tail.matchAll(/^(.{0,60}(?:ERROR|Exception|FATAL|FAIL)[:\s].{0,200})$/gm)) {
    const line = m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
    // Skip the streamer's own error logs (they contain "Edit failed for")
    if (/Edit failed for|Send failed for|Stop hook error/.test(line)) continue;
    events.push({
      type: 'error',
      title: `❌ Error`,
      detail: `<code>${escapeHtml(line)}</code>`,
      fingerprint: `error:${line.slice(0, 80)}`,
    });
  }

  // A2A envelopes — cross-pane messages
  for (const m of tail.matchAll(/\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)\]/g)) {
    events.push({
      type: 'a2a',
      title: `📡 A2A ${escapeHtml(m[4])} pane-${m[1]}→pane-${m[2]}`,
      detail: `corr=<code>${escapeHtml(m[3])}</code>`,
      fingerprint: `a2a:${m[3]}:${m[4]}:${m[1]}-${m[2]}`,
    });
  }

  return events;
}

// Event-mode stream loop for a single pane
async function streamPaneEvents(pane, project) {
  let threadId = topicMap[project];
  if (!threadId) {
    threadId = await createTopicIfMissing(project);
    if (!threadId) return;
  }

  const streamKey = `${project}:${pane.pane_id}`;
  let stream = streams.get(streamKey);
  if (!stream) {
    stream = { seen: new Set(), lastSentAt: 0, errorCount: 0, rateLimitedUntil: 0, mode: 'events' };
    streams.set(streamKey, stream);
  }

  const now = Date.now();
  if (stream.rateLimitedUntil && now < stream.rateLimitedUntil) return;
  if (now - stream.lastSentAt < EVENT_MIN_INTERVAL_MS) return;

  try {
    const raw = getFullText(pane.pane_id);
    if (!raw) {
      stream.errorCount++;
      if (stream.errorCount >= ERROR_LIMIT) {
        stderr(`Pane ${pane.pane_id} (${project}) dead after ${ERROR_LIMIT} errors, stopping`);
        streams.delete(streamKey);
      }
      return;
    }
    stream.errorCount = 0;

    const events = detectEvents(raw);
    // Post only NEW events (not seen yet). One per poll to space out Telegram calls.
    const fresh = events.filter(e => !stream.seen.has(e.fingerprint));
    if (fresh.length === 0) {
      // Still mark all currently-detected as seen so they don't re-fire when the seen set is reset
      for (const ev of events) stream.seen.add(ev.fingerprint);
      return;
    }

    // Prefer higher-value events first if multiple are new this cycle
    const priority = { error: 0, a2a: 1, push: 2, commit: 3, tool: 4 };
    fresh.sort((a, b) => (priority[a.type] ?? 9) - (priority[b.type] ?? 9));
    const ev = fresh[0];

    const text = `<b>${ev.title}</b>\n${ev.detail}`;
    const result = await telegramPost('sendMessage', {
      chat_id: GROUP_ID,
      message_thread_id: threadId,
      text,
      parse_mode: 'HTML',
      disable_notification: true,
    });

    if (result.ok) {
      stream.seen.add(ev.fingerprint);
      // Cap seen-set size to avoid unbounded memory growth
      if (stream.seen.size > 300) {
        stream.seen = new Set([...stream.seen].slice(-150));
      }
      stream.lastSentAt = now;
      emit({ source: 'telegram-streamer', project, event: 'event_posted', event_type: ev.type, pane: pane.pane_id });
    } else if (result.description && /Too Many Requests|retry after/i.test(result.description)) {
      const match = result.description.match(/retry after (\d+)/);
      const retryAfter = match ? parseInt(match[1], 10) : 15;
      stream.rateLimitedUntil = now + retryAfter * 1000 + 500;
      stderr(`Rate limited ${project} for ${retryAfter}s (event mode)`);
    } else if (result.description && /can't parse entities/i.test(result.description)) {
      // HTML broken — retry as plain
      const plain = text.replace(/<[^>]+>/g, '').slice(0, 4000);
      const retry = await telegramPost('sendMessage', {
        chat_id: GROUP_ID,
        message_thread_id: threadId,
        text: plain,
        disable_notification: true,
      });
      if (retry.ok) {
        stream.seen.add(ev.fingerprint);
        stream.lastSentAt = now;
      } else {
        stderr(`Event plain-text retry failed for ${project}: ${retry.description || 'unknown'}`);
      }
    } else {
      stderr(`Event send failed for ${project}: ${result.description || 'unknown'}`);
    }
  } catch (err) {
    stream.errorCount++;
    stderr(`Event poll error for ${project}: ${err.message} (count ${stream.errorCount})`);
  }
}

// --- Main stream loop for a single pane ---
async function streamPane(pane, project, isDuplicate) {
  // In events mode, delegate entirely to the event-based streamer.
  if (STREAMER_MODE === 'events') return streamPaneEvents(pane, project);
  let threadId = topicMap[project];
  if (!threadId) {
    // Auto-create topic for this project (first time we see it)
    threadId = await createTopicIfMissing(project);
    if (!threadId) return; // creation blocked or failed
  }

  const streamKey = `${project}:${pane.pane_id}`;
  let stream = streams.get(streamKey);
  if (!stream) {
    stream = { lastHash: 0, lastSentAt: 0, messageId: null, errorCount: 0, startTime: Date.now() };
    streams.set(streamKey, stream);
  }

  const now = Date.now();
  if (stream.rateLimitedUntil && now < stream.rateLimitedUntil) return;
  if (now - stream.lastSentAt < MIN_EDIT_INTERVAL_MS) return;

  try {
    const raw = getFullText(pane.pane_id);
    if (!raw) {
      stream.errorCount++;
      if (stream.errorCount >= ERROR_LIMIT) {
        stderr(`Pane ${pane.pane_id} (${project}) dead after ${ERROR_LIMIT} errors, stopping`);
        emit({ source: 'telegram-streamer', project, event: 'pane_dead', pane: pane.pane_id });
        streams.delete(streamKey);
      }
      return;
    }
    stream.errorCount = 0;

    const identity = detectAgentModel(pane, raw);
    const paneLabel = formatPaneLabel(project, identity, isDuplicate);
    // `card` = structured digest (Ctx/Now/Commits/Actions/Errors/A2A), edited in place.
    // `raw`  = legacy verbatim last-40-lines dump. Kept for rollback via env var.
    const html = STREAMER_MODE === 'raw'
      ? buildLiveHtml(project, pane.pane_id, raw, stream.startTime, paneLabel)
      : buildCardHtml(project, paneLabel, raw);
    const hash = simpleHash(html);

    // Skip if unchanged
    if (hash === stream.lastHash) return;

    stream.lastHash = hash;
    stream.lastSentAt = now;

    // Edit existing message or send new
    if (stream.messageId) {
      const result = await editMsgSafe(stream.messageId, html, threadId);
      if (!result.ok) {
        const desc = result.description || '';
        // "message is not modified" is OK — content hash collision, just skip
        if (desc.includes('not modified')) return;
        // "message to edit not found" — message was deleted, create new
        if (desc.includes('not found') || desc.includes('can\'t be edited')) {
          stderr(`Edit failed for ${project}: ${desc}. Creating new message.`);
          stream.messageId = null;
          // Fall through to sendMsg below
        } else if (desc.includes("can't parse entities")) {
          // HTML parse failed — strip tags and retry as plain
          stderr(`HTML parse failed for ${project}, retrying as plain text`);
          const plain = html.replace(/<[^>]+>/g, '').slice(0, 4000);
          const retryResult = await telegramPost('editMessageText', {
            chat_id: GROUP_ID,
            message_id: stream.messageId,
            text: plain,
          });
          if (!retryResult.ok) stream.messageId = null;
          return;
        } else if (desc.includes('Too Many Requests')) {
          // Respect retry_after from Telegram
          const match = desc.match(/retry after (\d+)/);
          const retryAfter = match ? parseInt(match[1], 10) : 10;
          stream.rateLimitedUntil = now + retryAfter * 1000 + 500;
          stderr(`Rate limited ${project} for ${retryAfter}s`);
          return;
        } else {
          stderr(`Edit failed for ${project}: ${desc}`);
          return;
        }
      } else {
        emit({ source: 'telegram-streamer', project, event: 'edited', pane: pane.pane_id });
        return;
      }
    }

    // Send new message — mark as sending to prevent concurrent sends creating duplicates
    if (stream.sending) return;
    stream.sending = true;
    const sendResult = await sendMsg(html, threadId);
    stream.sending = false;
    if (sendResult.ok && sendResult.result && sendResult.result.message_id) {
      stream.messageId = sendResult.result.message_id;
      stderr(`New message ${stream.messageId} for ${project}`);
      emit({ source: 'telegram-streamer', project, event: 'message_created', pane: pane.pane_id, message_id: stream.messageId });
    } else if (sendResult.description && sendResult.description.includes("can't parse entities")) {
      // HTML broken — send as plain
      const plain = html.replace(/<[^>]+>/g, '').slice(0, 4000);
      const plainResult = await telegramPost('sendMessage', {
        chat_id: GROUP_ID,
        message_thread_id: threadId,
        text: plain,
        disable_notification: true,
      });
      if (plainResult.ok && plainResult.result && plainResult.result.message_id) {
        stream.messageId = plainResult.result.message_id;
      }
    } else {
      stderr(`Send failed for ${project}: ${sendResult.description || 'unknown'}`);
    }
  } catch (err) {
    stream.errorCount++;
    stderr(`Poll error for ${project}: ${err.message} (count ${stream.errorCount})`);
    if (stream.errorCount >= ERROR_LIMIT) {
      streams.delete(streamKey);
    }
  }
}

// --- Inbound message routing: topic → pane ---
// Build reverse map: thread_id → project name
function getThreadToProject() {
  const map = new Map();
  for (const [project, threadId] of Object.entries(topicMap)) {
    if (project === '_group_id') continue;
    map.set(Number(threadId), project);
  }
  return map;
}

async function pollIncoming() {
  try {
    const result = await telegramPost('getUpdates', {
      offset: lastUpdateId + 1,
      limit: 30,
      timeout: 0,
      allowed_updates: ['message'],
    });
    if (!result.ok || !result.result) return;

    const threadToProject = getThreadToProject();

    for (const update of result.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg) continue;

      // Only process messages FROM the user IN the group we care about
      if (String(msg.chat?.id) !== String(GROUP_ID)) continue;
      // Ignore bot's own messages (avoid infinite loops)
      if (msg.from?.is_bot) continue;
      // Only text messages
      if (!msg.text) continue;
      // Must have thread_id (General has no thread_id → skip, let channel plugin handle)
      const threadId = msg.message_thread_id;
      if (!threadId) continue;

      const project = threadToProject.get(threadId);
      if (!project) continue;

      // Skip OmniClaude Status topic — that's for OmniClaude itself, not a pane
      if (project === 'OmniClaude Status') continue;

      // Find the pane for this project
      const paneId = projectToPane.get(project);
      if (paneId == null) {
        stderr(`No pane mapped for project "${project}" (thread ${threadId}), skipping`);
        continue;
      }

      // Forward the message directly to the pane
      try {
        wez.sendText(paneId, msg.text);
        stderr(`Forwarded topic "${project}" msg → pane ${paneId}: ${msg.text.slice(0, 60)}`);
        emit({
          source: 'telegram-streamer',
          event: 'topic_forwarded',
          project,
          pane: paneId,
          thread_id: threadId,
          text_preview: msg.text.slice(0, 80),
        });

        // Acknowledge in the topic with a reaction (cheap + non-intrusive)
        await telegramPost('setMessageReaction', {
          chat_id: GROUP_ID,
          message_id: msg.message_id,
          reaction: JSON.stringify([{ type: 'emoji', emoji: '👀' }]),
        }).catch(() => {});
      } catch (err) {
        stderr(`Failed to forward to pane ${paneId}: ${err.message}`);
      }
    }
  } catch (err) {
    stderr(`pollIncoming error: ${err.message}`);
  }
}

// --- Decision push (slice 1, 2026-08-20) ---
// Rides THIS poll loop — no new process (src/COORDINATORS.json discipline).
// Detection/dedupe/format live in decision-push.cjs (pure, tested); ledger
// reading reuses fleet-steward's loadTasks so there is one task reader.
// Everything here is fail-soft: a broken ledger or a Telegram outage must
// never take down the live streams.
const decisionPush = require('./decision-push.cjs');
const { loadTasks } = require('../scripts/fleet-steward.cjs');
const DECISION_CHECK_MS = parseInt(process.env.DECISION_CHECK_MS || '60000', 10);
const DECISION_TOPIC = 'decisiones';
let lastDecisionCheckAt = 0;

async function checkDecisions() {
  const now = Date.now();
  if (now - lastDecisionCheckAt < DECISION_CHECK_MS) return;
  lastDecisionCheckAt = now;
  try {
    const tasks = loadTasks();
    if (!tasks.length) return; // no ledger visible from here — nothing to push
    await decisionPush.pushDecisions({
      tasks,
      now,
      send: async (text) => {
        const threadId = topicMap[DECISION_TOPIC] || await createTopicIfMissing(DECISION_TOPIC);
        if (!threadId) return { ok: false, description: `no "${DECISION_TOPIC}" topic` };
        return sendMsg(text, threadId, { notify: true });
      },
      onNotified: (taskId) => emit({
        source: 'telegram-streamer', event: 'decision_notified', task_id: taskId,
      }),
    });
  } catch (err) {
    stderr(`decision push error: ${err.message}`);
  }
}

// --- Main poll loop ---
async function pollAll() {
  const panes = discoverPanes();

  // Two-pass: first resolve every pane's project and count occurrences so
  // duplicate-project panes can be disambiguated by agent in the header.
  const resolved = [];
  const projectCount = new Map();
  for (const pane of panes) {
    const project = detectProject(pane);
    if (!project) continue;
    resolved.push({ pane, project });
    projectCount.set(project, (projectCount.get(project) || 0) + 1);
  }

  // Refresh project → pane map so pollIncoming can find panes
  projectToPane.clear();
  for (const { pane, project } of resolved) {
    projectToPane.set(project, pane.pane_id);
    const isDuplicate = (projectCount.get(project) || 0) > 1;
    // Run streams in parallel (non-blocking)
    streamPane(pane, project, isDuplicate).catch(err => stderr(`streamPane fail: ${err.message}`));
  }

  // Push new operator decisions to the 'decisiones' topic (self-throttled).
  checkDecisions().catch(err => stderr(`decision push fail: ${err.message}`));
}

// --- Startup ---
emit({
  source: 'telegram-streamer',
  event: 'started',
  version: 'v2-ported-from-openclaw2claude',
  mode: STREAMER_MODE,
  topics: Object.keys(topicMap).filter(k => k !== '_group_id').length,
  poll_interval_ms: POLL_INTERVAL_MS,
  min_edit_interval_ms: STREAMER_MODE === 'events' ? EVENT_MIN_INTERVAL_MS : MIN_EDIT_INTERVAL_MS,
});
stderr(`v2 started. Mode: ${STREAMER_MODE}. Watching ${Object.keys(topicMap).length - 1} topics. Poll every ${POLL_INTERVAL_MS}ms.`);

// Initial poll
pollAll().catch(err => stderr(`Initial poll error: ${err.message}`));

// Periodic outbound poll (send pane output to topics)
setInterval(() => {
  pollAll().catch(err => stderr(`Poll error: ${err.message}`));
}, POLL_INTERVAL_MS);

// NOTE: inbound polling (pollIncoming) is DISABLED because the telegram
// channel plugin (server.ts) is also long-polling the same bot token via
// grammy.Bot — if we also call getUpdates here, we race with the plugin
// and steal DM updates that should go to OmniClaude. Instead, we patched
// server.ts to forward message_thread_id in the channel meta, so OmniClaude
// can route topic messages to panes itself using the thread_id.
// See ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4/server.ts

// Heartbeat
setInterval(() => {
  emit({
    source: 'telegram-streamer',
    event: 'heartbeat',
    active_streams: streams.size,
    tracked_panes: streams.size,
  });
}, HEARTBEAT_MS);

// Graceful shutdown
process.on('SIGTERM', () => {
  stderr('SIGTERM received, exiting');
  process.exit(0);
});
process.on('SIGINT', () => {
  stderr('SIGINT received, exiting');
  process.exit(0);
});
