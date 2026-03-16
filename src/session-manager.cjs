/**
 * Session Manager — tracks Claude Code sessions running in WezTerm panes.
 * Handles spawn, prompt injection, completion detection, and lifecycle.
 */
const { EventEmitter } = require('events');
const wez = require('./wezterm.cjs');
const fs = require('fs');
const path = require('path');

// Event emitter for session lifecycle events
const events = new EventEmitter();

// Active sessions: Map<sessionId, SessionInfo>
const sessions = new Map();
let nextId = 1;

// Completion detection patterns with prompt type classification
const PROMPT_PATTERN = /[❯>]\s*$/m;
const COST_PATTERN = /Total cost:/;

// Patterns mapped to prompt types
const WAITING_PATTERN_MAP = [
  { pattern: /[❯>]\s*$/m, type: 'idle' },
  { pattern: /\? \(y\/n\)/, type: 'permission' },
  { pattern: /\(Y\/n\)/i, type: 'permission' },
  { pattern: /Do you want to proceed/i, type: 'permission' },
  { pattern: /Allow .+\? \[y\/N\]/i, type: 'permission' },
  { pattern: /❯\s*1\.\s*Yes/i, type: 'permission' },
  { pattern: /\? Would you like/i, type: 'permission' },
  { pattern: /\? Are you sure/i, type: 'permission' },
  { pattern: /\? Proceed\?/i, type: 'permission' },
  { pattern: /\? Select.*:/i, type: 'permission' },
  { pattern: /Press Enter to continue/, type: 'continuation' },
  { pattern: /\? Enter .+ to continue/, type: 'continuation' },
];

const WAITING_PATTERNS = WAITING_PATTERN_MAP.map(p => p.pattern);

// Max history entries per session
const MAX_HISTORY = 20;

// Stability check: how many consecutive polls must show the same ❯ before we declare "done"
// At 3s poll interval, STABILITY_COUNT=3 means 9s of stable ❯ before firing.
// This prevents false triggers from ❯ flashing between tool calls or Claude pausing mid-thought.
// Configurable via WEZBRIDGE_STABILITY_COUNT env var.
const STABILITY_COUNT = parseInt(process.env.WEZBRIDGE_STABILITY_COUNT || '3', 10);

// Patterns that indicate Claude is still actively working (even if ❯ is visible)
const STILL_WORKING_PATTERNS = [
  /Running in the background/i,
  /background tasks? still running/i,
  /waiting on .+ agent/i,
  /waiting for .+ to/i,
  /Brewed for \d+s/,
  /\d+ background task/,
  /still running/i,
  /Thinking\.\.\./i,
  /Choreographing/i,
];

// Compaction patterns — when detected, Claude will auto-continue after the ❯
// We notify the user but keep waiting for the real completion
const COMPACTION_PATTERNS = [
  /Auto-compact/i,
  /compacting conversation/i,
  /\bcompacted\b/i,
  /\/compact/,
  /Context compressed/i,
  /context window.*compact/i,
  /messages were summarized/i,
  /conversation was compressed/i,
];

// How long after compaction to suppress completion (ms).
// Claude auto-continues within ~10s after compaction.
const COMPACTION_COOLDOWN_MS = 20000;

/**
 * Spawn a new Claude Code session in a WezTerm pane.
 * @param {object} opts
 * @param {string} opts.project - Project directory path
 * @param {string} opts.name - Human-readable session name
 * @param {string} [opts.initialPrompt] - Prompt to send after Claude starts
 * @param {boolean} [opts.continueSession] - Use --continue flag
 * @param {boolean} [opts.dangerouslySkipPermissions] - Use --dangerously-skip-permissions
 * @param {string} [opts.taskId] - ClawTrol task ID to link
 * @returns {object} Session info
 */
/**
 * Find the best Claude session to resume for a project.
 * Picks the largest .jsonl from the last 7 days (real working session, not tiny throwaway).
 */
function findBestSession(projectPath) {
  try {
    if (!projectPath) return null;

    // Encode project path like Claude does
    const normalized = projectPath.replace(/\\/g, '/');
    const encoded = normalized.replace(/[:\\/\s_-]/g, '-');
    const homeDir = process.env.USERPROFILE || process.env.HOME;
    const sessionsDir = path.join(homeDir, '.claude', 'projects', encoded);

    if (!fs.existsSync(sessionsDir)) return null;

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return null;

    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const candidates = [];

    for (const file of files) {
      const fullPath = path.join(sessionsDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > sevenDaysAgo && stat.size > 50000) { // >50KB = real session
        candidates.push({ id: file.replace('.jsonl', ''), size: stat.size, mtime: stat.mtimeMs });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by modification time (most recent first), then by size as tiebreaker
    candidates.sort((a, b) => b.mtime - a.mtime || b.size - a.size);
    return candidates[0].id;
  } catch {
    return null;
  }
}

/**
 * Find an existing session for a project with a live pane.
 * Returns the session if found, null otherwise.
 */
function findSessionByProject(projectPath) {
  if (!projectPath) return null;
  const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (const existing of sessions.values()) {
    if (!existing.project) continue;
    const existingNorm = existing.project.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (existingNorm === normalizedProject && existing.paneId != null) {
      try {
        const panes = wez.listPanes();
        const pid = existing.paneId;
        const paneExists = panes.some(p => (p.pane_id === pid || p.pane_id === String(pid) || p.paneid === String(pid)));
        if (paneExists) return existing;
      } catch {
        // Pane check failed
      }
    }
  }
  return null;
}

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
    status: 'starting',       // starting | running | waiting | completed | error
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastOutput: '',
    promptHistory: [],
    completionHistory: [],  // V2: {prompt, response, diffStat, timestamp}
    promptType: null,       // V2: 'idle' | 'permission' | 'continuation'
  };

  sessions.set(sessionId, session);
  events.emit('session:spawned', session);

  // Build the claude command
  const claudeArgs = ['claude'];
  if (dangerouslySkipPermissions) claudeArgs.push('--dangerously-skip-permissions');
  if (continueSession) {
    // Find the best session to resume: largest .jsonl from last 7 days
    const bestSession = findBestSession(project);
    if (bestSession) {
      claudeArgs.push('--resume', bestSession);
      console.log(`\x1b[32m[session]\x1b[0m Resuming session ${bestSession} (largest recent)`);
    } else {
      claudeArgs.push('--continue');
      console.log(`\x1b[33m[session]\x1b[0m No large session found, using --continue`);
    }
  }

  // Wait for bash to init, then launch claude
  setTimeout(() => {
    try {
      wez.sendText(paneId, 'unset CLAUDECODE && ' + claudeArgs.join(' '));
      session.status = 'running';

      // If there's an initial prompt, send it after Claude starts
      if (initialPrompt) {
        setTimeout(() => {
          sendPrompt(sessionId, initialPrompt);
        }, 5000); // Wait for Claude to fully initialize
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

  try {
    wez.sendText(session.paneId, prompt);
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    events.emit('session:send-failed', { session, error: err });
    throw err;
  }

  session.status = 'running';
  session.lastActivity = new Date().toISOString();
  session.promptSentAt = Date.now();
  session._compactionAt = null;  // Reset compaction state on new prompt
  session._stabilityCount = 0;
  session._lastScrollbackHash = null;
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

  const text = wez.getText(session.paneId);
  session.lastOutput = text;
  return text;
}

/**
 * Check if a session is waiting for input (i.e., Claude finished its response).
 *
 * V2 stability logic:
 * 1. Initial cooldown (8s after prompt sent) — prevents OLD ❯ false positive
 * 2. When ❯ is detected, check for "still working" patterns — if found, skip
 * 3. Take a scrollback hash — on next poll, if hash is SAME and ❯ still present,
 *    mark as "waiting" (output is stable = Claude is truly done)
 * 4. If hash changed between polls — reset counter (Claude was still outputting)
 *
 * Permission prompts (y/n) bypass stability — they're always immediate.
 */
function checkCompletion(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { waiting: false, session: null };

  // Don't check too soon after sending a prompt (give Claude 8s to start processing)
  if (session.promptSentAt && (Date.now() - session.promptSentAt) < 8000) {
    return { waiting: false, session };
  }

  try {
    const text = wez.getFullText(session.paneId, 100);
    const lines = text.split('\n').filter(l => l.trim());
    const lastLines = lines.slice(-15).join('\n');
    const scrollbackHash = simpleHash(lines.slice(-30).join('\n'));

    session.lastOutput = text;

    // Detect which pattern matched and classify prompt type
    let isWaiting = false;
    let detectedType = null;
    for (const { pattern, type } of WAITING_PATTERN_MAP) {
      if (pattern.test(lastLines)) {
        isWaiting = true;
        detectedType = type;
        break;
      }
    }

    if (!isWaiting) {
      // No prompt detected — reset stability counter
      session._stabilityCount = 0;
      session._lastScrollbackHash = null;
      return { waiting: false, session, lastLines };
    }

    // Permission/continuation prompts fire immediately (no stability wait)
    if (detectedType === 'permission' || detectedType === 'continuation') {
      if (session.status === 'running') {
        session.status = 'waiting';
        session.promptType = detectedType;
        session.lastActivity = new Date().toISOString();
        session.promptSentAt = null;
        session._stabilityCount = 0;
        session._lastScrollbackHash = null;
        events.emit('session:waiting', { ...session, promptType: detectedType });
        console.log(`\x1b[33m[session]\x1b[0m ${sessionId} — \x1b[33m${detectedType}\x1b[0m prompt detected (immediate)`);
      }
      return { waiting: true, promptType: detectedType, session, lastLines };
    }

    // For idle (❯) prompts: check for "still working" indicators
    const stillWorking = STILL_WORKING_PATTERNS.some(p => p.test(lastLines));
    if (stillWorking) {
      session._stabilityCount = 0;
      session._lastScrollbackHash = null;
      return { waiting: false, session, lastLines };
    }

    // Check broader scrollback for compaction (it may not be in last 15 lines)
    const recentText = lines.slice(-40).join('\n');
    const compactionDetected = COMPACTION_PATTERNS.some(p => p.test(recentText));

    if (compactionDetected) {
      // First time detecting compaction for this session cycle?
      if (!session._compactionAt) {
        // Save full scrollback before compaction wipes it
        try {
          const fullText = wez.getFullText(session.paneId, 2000);
          session._preCompactionSnapshot = fullText;
          console.log(`\x1b[2m[session]\x1b[0m ${sessionId} — saved ${fullText.length} chars pre-compaction snapshot`);
        } catch { /* ignore */ }
        session._compactionAt = Date.now();
        session._stabilityCount = 0;
        session._lastScrollbackHash = null;
        events.emit('session:compacted', session);
        console.log(`\x1b[33m[session]\x1b[0m ${sessionId} — \x1b[33mcompaction detected\x1b[0m, suppressing completion for ${COMPACTION_COOLDOWN_MS / 1000}s`);
        return { waiting: false, compacted: true, session, lastLines };
      }

      // Still within compaction cooldown?
      if (Date.now() - session._compactionAt < COMPACTION_COOLDOWN_MS) {
        session._stabilityCount = 0;
        session._lastScrollbackHash = null;
        return { waiting: false, compacted: true, session, lastLines };
      }

      // Cooldown expired — compaction is old, allow normal stability check
    }

    // Stability check: scrollback must be unchanged for STABILITY_COUNT consecutive polls
    if (!session._stabilityCount) session._stabilityCount = 0;
    if (!session._lastScrollbackHash) session._lastScrollbackHash = null;

    if (session._lastScrollbackHash === scrollbackHash) {
      session._stabilityCount++;
    } else {
      // Output changed — reset counter
      session._stabilityCount = 1;
      session._lastScrollbackHash = scrollbackHash;
    }

    if (session._stabilityCount >= STABILITY_COUNT && session.status === 'running') {
      session.status = 'waiting';
      session.promptType = detectedType;
      session.lastActivity = new Date().toISOString();
      session.promptSentAt = null;
      session._stabilityCount = 0;
      session._lastScrollbackHash = null;
      session._compactionAt = null; // Reset compaction state
      events.emit('session:waiting', { ...session, promptType: detectedType });
      console.log(`\x1b[32m[session]\x1b[0m ${sessionId} \x1b[32mcompleted\x1b[0m — stable ❯ after ${STABILITY_COUNT} polls`);
      return { waiting: true, promptType: detectedType, session, lastLines };
    }

    // Not yet stable — ❯ detected but waiting for confirmation
    // Only log when stability count actually changes (avoid spam)
    if (session._stabilityCount > 0 && session._stabilityCount !== session._lastLoggedStability) {
      console.log(`\x1b[33m[session]\x1b[0m ${sessionId} — ❯ detected, stability ${session._stabilityCount}/${STABILITY_COUNT}`);
      session._lastLoggedStability = session._stabilityCount;
    }

    return { waiting: false, session, lastLines };
  } catch (err) {
    session.status = 'error';
    session.error = err.message;
    return { waiting: false, session, error: err.message };
  }
}

/**
 * Hash of a string for stability comparison (MD5 — fast, no 32-bit collision risk).
 */
function simpleHash(str) {
  return require('crypto').createHash('md5').update(str).digest('hex');
}

/**
 * Get all sessions.
 */
function listSessions() {
  return Array.from(sessions.values());
}

/**
 * Get a specific session.
 */
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Kill a session and its pane.
 */
function killSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  wez.killPane(session.paneId);
  session.status = 'completed';
  events.emit('session:killed', session);
  sessions.delete(sessionId);
  return true;
}

// Counter for stale-waiting checks (only run every 6th poll cycle)
let _pollCycleCounter = 0;

/**
 * Poll all sessions for completion. Returns sessions that just became "waiting".
 */
function pollAll() {
  _pollCycleCounter++;
  const newlyWaiting = [];
  const toRemove = [];
  for (const [id, session] of sessions) {
    if (session.status === 'running' || session.status === 'starting') {
      const result = checkCompletion(id);
      if (result.waiting) {
        newlyWaiting.push({ ...session, lastLines: result.lastLines });
      }
      // Track consecutive errors for dead pane detection
      if (result.error) {
        session._errorCount = (session._errorCount || 0) + 1;
        if (session._errorCount >= 3) {
          console.log(`\x1b[31m[session]\x1b[0m ${id} — pane dead after ${session._errorCount} errors, removing`);
          toRemove.push(id);
        }
      } else {
        session._errorCount = 0;
      }
    }

    // M3: Check stale 'waiting' sessions every 6th cycle — verify pane is still alive
    if (session.status === 'waiting' && _pollCycleCounter % 6 === 0) {
      try {
        wez.getText(session.paneId);
      } catch {
        console.log(`\x1b[31m[session]\x1b[0m ${id} — waiting session pane dead, removing`);
        toRemove.push(id);
      }
    }
  }
  for (const id of toRemove) {
    const session = sessions.get(id);
    if (session) {
      session.status = 'dead';
      events.emit('session:dead', session);
      sessions.delete(id);
    }
  }
  return newlyWaiting;
}

/**
 * Add an entry to a session's completion history.
 * @param {string} sessionId
 * @param {object} entry - { prompt, response, diffStat, timestamp }
 */
function addCompletionHistory(sessionId, entry) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.completionHistory) session.completionHistory = [];
  session.completionHistory.push({
    prompt: entry.prompt || '',
    response: entry.response || '',
    diffStat: entry.diffStat || null,
    timestamp: entry.timestamp || new Date().toISOString(),
  });
  // Cap at MAX_HISTORY
  if (session.completionHistory.length > MAX_HISTORY) {
    session.completionHistory = session.completionHistory.slice(-MAX_HISTORY);
  }
}

/**
 * Get completion history for a session.
 */
function getCompletionHistory(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return session.completionHistory || [];
}

/**
 * Register an externally-created session (e.g., for seeding existing panes).
 */
function _registerSession(session) {
  if (!session.completionHistory) session.completionHistory = [];
  if (!session.promptType) session.promptType = null;
  sessions.set(session.id, session);

  // Bump nextId past any restored session IDs to prevent collisions
  const match = session.id.match(/^wez-(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= nextId) nextId = num + 1;
  }

  events.emit('session:spawned', session);
}

module.exports = {
  spawnSession,
  sendPrompt,
  readOutput,
  checkCompletion,
  listSessions,
  getSession,
  findSessionByProject,
  killSession,
  pollAll,
  addCompletionHistory,
  getCompletionHistory,
  events,
  _registerSession,
};
