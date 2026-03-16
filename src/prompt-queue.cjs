/**
 * Prompt Queue — FIFO queue per session with atomic delivery.
 *
 * Solves:
 * - Race conditions: No concurrent sendPrompt() calls to the same session
 * - Prompt interleaving: Multiple messages queued → delivered one at a time
 * - Dead pane crashes: try-catch around delivery, marks pane as dead
 *
 * RULE: All sendPrompt() calls in the system go through this queue.
 *       Nobody calls sm.sendPrompt() directly except promptQueue.drain().
 */
const { EventEmitter } = require('events');
const sm = require('./session-manager.cjs');

const events = new EventEmitter();

// Per-session FIFO queues: Map<sessionId, Array<QueueItem>>
const queues = new Map();

// Per-session delivery locks: Map<sessionId, boolean>
const locks = new Map();

// Stats
let totalEnqueued = 0;
let totalDelivered = 0;
let totalFailed = 0;

/**
 * @typedef {object} QueueItem
 * @property {string} id - Unique item ID
 * @property {string} text - Prompt text to inject
 * @property {string} source - Who enqueued: 'user' | 'orchestrator' | '@alias' | 'system'
 * @property {number} priority - 0=critical, 1=high, 2=normal, 3=low
 * @property {number} enqueuedAt - Timestamp
 * @property {Function} [onDelivered] - Optional callback on successful delivery
 * @property {Function} [onFailed] - Optional callback on failure
 */

/**
 * Enqueue a prompt for delivery to a session.
 * If the session is idle and no lock is held, attempts immediate delivery.
 *
 * @param {string} sessionId
 * @param {string} text - Prompt text
 * @param {object} [opts]
 * @param {string} [opts.source='system'] - Who is sending
 * @param {number} [opts.priority=2] - 0=critical, 1=high, 2=normal, 3=low
 * @param {Function} [opts.onDelivered] - Success callback
 * @param {Function} [opts.onFailed] - Failure callback
 * @returns {object} The queued item
 */
function enqueue(sessionId, text, opts = {}) {
  if (!queues.has(sessionId)) {
    queues.set(sessionId, []);
  }

  const item = {
    id: `pq-${Date.now().toString(36)}-${(++totalEnqueued).toString(36)}`,
    text,
    source: opts.source || 'system',
    priority: opts.priority !== undefined ? opts.priority : 2,
    enqueuedAt: Date.now(),
    onDelivered: opts.onDelivered || null,
    onFailed: opts.onFailed || null,
  };

  const queue = queues.get(sessionId);

  // Insert by priority (lower number = higher priority)
  // Same priority: FIFO (append)
  let inserted = false;
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].priority > item.priority) {
      queue.splice(i, 0, item);
      inserted = true;
      break;
    }
  }
  if (!inserted) queue.push(item);

  events.emit('prompt:enqueued', { sessionId, item });

  // Try immediate delivery
  drain(sessionId);

  return item;
}

/**
 * Attempt to deliver the next queued prompt to a session.
 * Atomic: acquires a lock, checks status, sends, releases lock.
 * Only delivers if session status is 'waiting'.
 *
 * @param {string} sessionId
 * @returns {boolean} Whether a prompt was delivered
 */
function drain(sessionId) {
  // Check lock — only one delivery at a time per session
  if (locks.get(sessionId)) return false;

  const queue = queues.get(sessionId);
  if (!queue || queue.length === 0) return false;

  const session = sm.getSession(sessionId);
  if (!session) {
    // Session doesn't exist — fail all queued items
    failAll(sessionId, 'Session not found');
    return false;
  }

  // Only deliver to idle sessions
  if (session.status !== 'waiting') return false;

  // Acquire lock
  locks.set(sessionId, true);

  const item = queue.shift();

  try {
    sm.sendPrompt(sessionId, item.text);
    totalDelivered++;

    events.emit('prompt:delivered', {
      sessionId,
      item,
      queueRemaining: queue.length,
    });

    if (item.onDelivered) {
      try { item.onDelivered(item); } catch {}
    }

    console.log(`\x1b[32m[queue]\x1b[0m Delivered to ${sessionId}: ${item.text.slice(0, 80)}${item.text.length > 80 ? '...' : ''} (${queue.length} remaining)`);
  } catch (err) {
    totalFailed++;

    events.emit('prompt:failed', {
      sessionId,
      item,
      error: err.message,
    });

    if (item.onFailed) {
      try { item.onFailed(item, err); } catch {}
    }

    console.error(`\x1b[31m[queue]\x1b[0m Delivery failed to ${sessionId}: ${err.message}`);

    // If pane is dead, fail all remaining items for this session
    if (err.message.includes('failed') || err.message.includes('not found')) {
      failAll(sessionId, `Pane dead: ${err.message}`);
    }
  } finally {
    // Release lock
    locks.set(sessionId, false);
  }

  return true;
}

/**
 * Called when a session becomes idle (from pollAll completion detection).
 * Attempts to deliver the next queued prompt.
 *
 * @param {string} sessionId
 * @returns {boolean} Whether a prompt was delivered
 */
function onSessionIdle(sessionId) {
  return drain(sessionId);
}

/**
 * Fail all queued items for a session.
 * Used when a pane dies or session is removed.
 */
function failAll(sessionId, reason) {
  const queue = queues.get(sessionId);
  if (!queue) return;

  for (const item of queue) {
    totalFailed++;
    events.emit('prompt:failed', { sessionId, item, error: reason });
    if (item.onFailed) {
      try { item.onFailed(item, new Error(reason)); } catch {}
    }
  }

  queues.delete(sessionId);
  locks.delete(sessionId);
  console.log(`\x1b[31m[queue]\x1b[0m Failed all ${queue.length} items for ${sessionId}: ${reason}`);
}

/**
 * Get the queue for a session.
 */
function getQueue(sessionId) {
  return queues.get(sessionId) || [];
}

/**
 * Get queue length for a session.
 */
function getQueueLength(sessionId) {
  const q = queues.get(sessionId);
  return q ? q.length : 0;
}

/**
 * Get total queue stats.
 */
function getStats() {
  let totalPending = 0;
  for (const [, q] of queues) {
    totalPending += q.length;
  }
  return {
    totalPending,
    totalEnqueued,
    totalDelivered,
    totalFailed,
    activeSessions: queues.size,
    lockedSessions: Array.from(locks.entries()).filter(([, v]) => v).length,
  };
}

/**
 * Clear all queues (for shutdown).
 */
function clearAll() {
  queues.clear();
  locks.clear();
}

// Auto-cleanup dead sessions
sm.events.on('session:dead', (session) => {
  failAll(session.id, 'Session pane died');
});

module.exports = {
  enqueue,
  drain,
  onSessionIdle,
  failAll,
  getQueue,
  getQueueLength,
  getStats,
  clearAll,
  events,
};
