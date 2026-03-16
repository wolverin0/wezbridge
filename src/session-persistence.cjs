/**
 * Session Persistence — save/load orchestrator state across reboots.
 *
 * Inspired by claude-launcher's approach:
 * - Reads Claude Code's native session files (~/.claude/projects/*.jsonl)
 * - Stores only orchestrator-specific metadata in its own state file
 * - Uses `claude -r <session_id>` to resume sessions in new panes
 *
 * State file: ~/.wezbridge-orchestrator.json
 * Prompt queue backup: ~/.wezbridge-queue.json
 *
 * On reboot:
 * 1. Load saved state → know which aliases/roles/project existed
 * 2. For each member, find the Claude session JSONL → get the conversation ID
 * 3. Spawn new WezTerm panes
 * 4. Launch `claude -r <conversation_id>` in each pane
 * 5. Re-register aliases and restore prompt queue
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const events = new EventEmitter();

// State file paths
const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const STATE_FILE = path.join(HOME, '.wezbridge-orchestrator.json');
const QUEUE_FILE = path.join(HOME, '.wezbridge-queue.json');

/**
 * @typedef {object} SavedMember
 * @property {string} alias - Team member alias
 * @property {string} role - Role description
 * @property {string} sessionId - WezBridge session ID (wez-N)
 * @property {string|null} claudeSessionId - Claude conversation ID for resume
 * @property {string} project - Project directory
 */

/**
 * @typedef {object} OrchestratorState
 * @property {string} project - Project directory
 * @property {SavedMember[]} members - Team members
 * @property {boolean} hasOrchestrator - Whether an overseer was running
 * @property {boolean} yolo - Skip permissions flag
 * @property {number} stability - Stability count
 * @property {number} poll - Poll interval ms
 * @property {number|null} port - REST API port
 * @property {string} savedAt - ISO timestamp
 * @property {string} version - State format version
 */

const STATE_VERSION = '1';

// ─── Claude Session Discovery ─────────────────────────────────────────────
// Adapted from claude-launcher: scan ~/.claude/projects/ for JSONL files

/**
 * Encode a project path the way Claude Code does for its session directory.
 * @param {string} projectPath
 * @returns {string} Encoded directory name
 */
function encodeProjectPath(projectPath) {
  const normalized = projectPath.replace(/\\/g, '/');
  return normalized.replace(/[:\\/\s_-]/g, '-');
}

/**
 * Find Claude session JSONL files for a project.
 * Returns sorted by modification time (most recent first).
 * @param {string} projectPath
 * @returns {Array<{id: string, file: string, size: number, mtime: number, health: string}>}
 */
function findClaudeSessions(projectPath) {
  try {
    const encoded = encodeProjectPath(projectPath);
    const sessionsDir = path.join(HOME, '.claude', 'projects', encoded);

    if (!fs.existsSync(sessionsDir)) return [];

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    const sessions = [];

    for (const file of files) {
      const fullPath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        sessions.push({
          id: file.replace('.jsonl', ''),
          file: fullPath,
          size: stat.size,
          mtime: stat.mtimeMs,
          health: getSessionHealth(fullPath),
        });
      } catch {
        // Skip unreadable files
      }
    }

    sessions.sort((a, b) => b.mtime - a.mtime);
    return sessions;
  } catch {
    return [];
  }
}

/**
 * Determine session health by reading the tail of the JSONL file.
 * Adapted from claude-launcher's health detection.
 * @param {string} filePath
 * @returns {'clean'|'interrupted'|'unknown'}
 */
function getSessionHealth(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 10240); // Last 10KB
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const tail = buf.toString('utf-8');
    const lines = tail.split('\n').filter(l => l.trim());

    // Walk backwards to find the last valid JSON line
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const type = entry.type || '';
        if (type === 'system' || type === 'queue-operation') return 'clean';
        if (type === 'assistant' || type === 'progress') return 'interrupted';
        return 'unknown';
      } catch {
        continue; // Incomplete JSON line, try previous
      }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Find the best Claude session to resume for a given project + alias combo.
 * Looks for sessions modified after the orchestrator state was saved.
 * Falls back to the most recent large session.
 * @param {string} projectPath
 * @param {string} [savedAfter] - ISO timestamp; prefer sessions modified after this
 * @returns {string|null} Claude conversation ID
 */
function findResumableSession(projectPath, savedAfter) {
  const sessions = findClaudeSessions(projectPath);
  if (sessions.length === 0) return null;

  const cutoff = savedAfter ? new Date(savedAfter).getTime() : 0;

  // Prefer sessions that were active after the state was saved and are large enough
  const candidates = sessions.filter(s => s.size > 10000); // >10KB = real session
  if (candidates.length === 0) return null;

  // If we have a saved timestamp, prefer sessions modified after it
  if (cutoff > 0) {
    const recent = candidates.filter(s => s.mtime > cutoff);
    if (recent.length > 0) return recent[0].id;
  }

  // Fallback: most recent session
  return candidates[0].id;
}

// ─── State Save/Load ──────────────────────────────────────────────────────

/**
 * Save the current orchestrator state to disk.
 * Called on team creation, member changes, and periodically.
 * @param {object} state - OrchestratorState to save
 */
function saveState(state) {
  try {
    const data = {
      ...state,
      savedAt: new Date().toISOString(),
      version: STATE_VERSION,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    events.emit('state:saved', data);
  } catch (err) {
    console.error('[persistence] Save failed:', err.message);
  }
}

/**
 * Load the saved orchestrator state from disk.
 * @returns {OrchestratorState|null}
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);

    if (state.version !== STATE_VERSION) {
      console.warn('[persistence] State file version mismatch, ignoring');
      return null;
    }

    return state;
  } catch (err) {
    console.error('[persistence] Load failed:', err.message);
    return null;
  }
}

/**
 * Clear the saved state (after successful resume or disband).
 */
function clearState() {
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    events.emit('state:cleared');
  } catch (err) {
    console.error('[persistence] Clear failed:', err.message);
  }
}

/**
 * Check if a saved state exists.
 * @returns {boolean}
 */
function hasSavedState() {
  return fs.existsSync(STATE_FILE);
}

/**
 * Get a summary of the saved state without loading everything.
 * @returns {object|null} Brief summary
 */
function peekState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    return {
      project: state.project,
      memberCount: state.members ? state.members.length : 0,
      members: (state.members || []).map(m => `@${m.alias}`),
      hasOrchestrator: state.hasOrchestrator || false,
      savedAt: state.savedAt,
      age: Date.now() - new Date(state.savedAt).getTime(),
    };
  } catch {
    return null;
  }
}

// ─── Prompt Queue Persistence ─────────────────────────────────────────────

/**
 * Save pending prompt queue items to disk.
 * Only saves the text and metadata — callbacks are not serializable.
 * @param {Map|object} queues - sessionId → Array<QueueItem>
 */
function saveQueue(queues) {
  try {
    const data = {};
    const entries = queues instanceof Map ? queues.entries() : Object.entries(queues);
    for (const [sessionId, items] of entries) {
      if (items.length > 0) {
        data[sessionId] = items.map(item => ({
          id: item.id,
          text: item.text,
          source: item.source,
          priority: item.priority,
          enqueuedAt: item.enqueuedAt,
        }));
      }
    }

    if (Object.keys(data).length === 0) {
      // No pending items — remove the file
      if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
      return;
    }

    fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[persistence] Queue save failed:', err.message);
  }
}

/**
 * Load pending prompt queue items from disk.
 * @returns {object} sessionId → Array<{text, source, priority}>
 */
function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return {};
    const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return data;
  } catch (err) {
    console.error('[persistence] Queue load failed:', err.message);
    return {};
  }
}

/**
 * Clear saved queue file.
 */
function clearQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
  } catch {}
}

// ─── Build State from Live Orchestrator ───────────────────────────────────

/**
 * Build a saveable state object from the live orchestrator and session manager.
 * This is the bridge between in-memory state and the persistence layer.
 *
 * @param {object} opts
 * @param {string} opts.project
 * @param {Function} opts.listAliases - From terminal-orchestrator
 * @param {Function} opts.getSession - From session-manager
 * @param {Function} opts.isOrchestratorRunning - From terminal-orchestrator
 * @param {object} [opts.cliOpts] - Original CLI options (yolo, stability, poll, port)
 * @returns {OrchestratorState}
 */
function buildState(opts) {
  const aliases = opts.listAliases();
  const members = [];

  for (const entry of aliases) {
    if (entry.alias === 'orchestrator') continue;
    const session = opts.getSession(entry.sessionId);
    members.push({
      alias: entry.alias,
      role: session?.name || entry.alias,
      sessionId: entry.sessionId,
      claudeSessionId: null, // Populated during save from JSONL discovery
      project: session?.project || opts.project,
    });
  }

  // Try to find Claude conversation IDs for each member
  for (const member of members) {
    const claudeId = findResumableSession(member.project);
    if (claudeId) member.claudeSessionId = claudeId;
  }

  return {
    project: opts.project,
    members,
    hasOrchestrator: opts.isOrchestratorRunning(),
    yolo: opts.cliOpts?.yolo || false,
    stability: opts.cliOpts?.stability || 3,
    poll: opts.cliOpts?.poll || 3000,
    port: opts.cliOpts?.port || null,
  };
}

// ─── Auto-save Timer ──────────────────────────────────────────────────────

let autoSaveTimer = null;
let autoSaveFn = null;

/**
 * Start auto-saving state at a regular interval.
 * @param {Function} buildStateFn - Function that returns the current state
 * @param {number} [intervalMs=30000] - Save interval (default 30s)
 */
function startAutoSave(buildStateFn, intervalMs = 30000) {
  stopAutoSave();
  autoSaveFn = buildStateFn;
  autoSaveTimer = setInterval(() => {
    try {
      const state = autoSaveFn();
      saveState(state);
    } catch (err) {
      console.error('[persistence] Auto-save failed:', err.message);
    }
  }, intervalMs);
  console.log(`[persistence] Auto-save every ${intervalMs / 1000}s → ${STATE_FILE}`);
}

/**
 * Stop auto-saving.
 */
function stopAutoSave() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
}

/**
 * Do a final save (call on shutdown).
 */
function finalSave() {
  if (autoSaveFn) {
    try {
      const state = autoSaveFn();
      saveState(state);
      console.log('[persistence] Final state saved');
    } catch {}
  }
}

module.exports = {
  // Claude session discovery
  findClaudeSessions,
  getSessionHealth,
  findResumableSession,
  encodeProjectPath,
  // State management
  saveState,
  loadState,
  clearState,
  hasSavedState,
  peekState,
  buildState,
  // Queue persistence
  saveQueue,
  loadQueue,
  clearQueue,
  // Auto-save
  startAutoSave,
  stopAutoSave,
  finalSave,
  // Events
  events,
  // Paths (for testing/debug)
  STATE_FILE,
  QUEUE_FILE,
};
