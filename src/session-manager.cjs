/**
 * Session Manager — tracks Claude Code sessions running in WezTerm panes.
 * Handles spawn, prompt injection, completion detection, and lifecycle.
 */
const { EventEmitter } = require('events');
const wez = require('./wezterm.cjs');

const events = new EventEmitter();
const sessions = new Map();
let nextId = 1;

// Completion detection patterns — Claude Code shows ❯ when waiting for input
const WAITING_PATTERNS = [
  /[❯>]\s*$/m,                    // Claude Code idle prompt
  /\? \(y\/n\)/,                   // Yes/no prompt
  /Press Enter to continue/,
  /Do you want to proceed/,
];

// How many seconds to wait after sending a prompt before checking for completion.
// Prevents false positives from the OLD ❯ still visible in scrollback.
const COOLDOWN_MS = 8000;

// How many terminal lines to check for the ❯ prompt.
// Claude Code has a ~7 line status bar below the prompt, so we need enough lines.
const DETECTION_WINDOW = 15;

/**
 * Spawn a new Claude Code session in a WezTerm pane.
 */
function spawnSession(opts) {
  const {
    project,
    name,
    initialPrompt,
    continueSession = false,
    dangerouslySkipPermissions = false,
    taskId = null,
  } = opts;

  const paneId = wez.spawnPane({ cwd: project });

  const sessionId = `wez-${nextId++}`;
  const session = {
    id: sessionId,
    name: name || `session-${sessionId}`,
    paneId,
    project,
    taskId,
    status: 'starting',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastOutput: '',
    promptHistory: [],
  };

  sessions.set(sessionId, session);
  events.emit('session:spawned', session);

  const claudeArgs = ['claude'];
  if (dangerouslySkipPermissions) claudeArgs.push('--dangerously-skip-permissions');
  if (continueSession) claudeArgs.push('--continue');

  // Wait for shell to init, then launch claude
  setTimeout(() => {
    try {
      wez.sendText(paneId, claudeArgs.join(' '));
      session.status = 'running';

      if (initialPrompt) {
        setTimeout(() => {
          sendPrompt(sessionId, initialPrompt);
        }, 5000);
      }
    } catch (err) {
      session.status = 'error';
      session.error = err.message;
    }
  }, 2000);

  return session;
}

/**
 * Send a prompt to a running Claude session.
 */
function sendPrompt(sessionId, prompt) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  wez.sendText(session.paneId, prompt);
  session.status = 'running';
  session.lastActivity = new Date().toISOString();
  session.promptSentAt = Date.now();
  session.promptHistory.push({
    prompt,
    sentAt: new Date().toISOString(),
  });

  return session;
}

/**
 * Read current output from a session's pane.
 */
function readOutput(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const text = wez.getFullText(session.paneId, 500);
  session.lastOutput = text;
  return text;
}

/**
 * Check if a session is waiting for input (Claude finished its response).
 */
function checkCompletion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { waiting: false, session: null };

  // Don't check too soon after sending a prompt
  if (session.promptSentAt && (Date.now() - session.promptSentAt) < COOLDOWN_MS) {
    return { waiting: false, session };
  }

  try {
    const text = wez.getFullText(session.paneId, 100);
    const lines = text.split('\n').filter(l => l.trim());
    const lastLines = lines.slice(-DETECTION_WINDOW).join('\n');

    session.lastOutput = text;

    const isWaiting = WAITING_PATTERNS.some(p => p.test(lastLines));

    if (isWaiting && session.status === 'running') {
      session.status = 'waiting';
      session.lastActivity = new Date().toISOString();
      session.promptSentAt = null;
      events.emit('session:waiting', session);
      console.log(`[session] ${sessionId} completed — detected prompt in tail`);
    }

    return { waiting: isWaiting, session, lastLines };
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    return { waiting: false, session, error: err.message };
  }
}

function listSessions() {
  return Array.from(sessions.values());
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  wez.killPane(session.paneId);
  session.status = 'completed';
  events.emit('session:killed', session);
  sessions.delete(sessionId);
  return true;
}

/**
 * Poll all active sessions for completion.
 * Returns sessions that just became "waiting".
 */
function pollAll() {
  const newlyWaiting = [];
  for (const [id, session] of sessions) {
    if (session.status === 'running' || session.status === 'starting') {
      const result = checkCompletion(id);
      if (result.waiting) {
        newlyWaiting.push({ ...session, lastLines: result.lastLines });
      }
    }
  }
  return newlyWaiting;
}

/**
 * Register an externally-created session (for seeding existing panes).
 */
function _registerSession(session) {
  sessions.set(session.id, session);
  events.emit('session:spawned', session);
}

module.exports = {
  spawnSession,
  sendPrompt,
  readOutput,
  checkCompletion,
  listSessions,
  getSession,
  killSession,
  pollAll,
  events,
  _registerSession,
};
