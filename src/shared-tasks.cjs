/**
 * Shared Tasks — a task list shared across all Claude Code sessions.
 * Mirrors Claude Code Agent Teams' shared task list concept.
 * Sessions can create, claim, complete, and depend on tasks.
 * The orchestrator uses this to coordinate work across terminals.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const events = new EventEmitter();

// Task storage
const tasks = new Map();
const TASKS_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.wezbridge-tasks.json');

/**
 * Task states:
 * - pending: Available for claiming
 * - in_progress: Claimed by a session
 * - completed: Done
 * - blocked: Waiting on dependencies
 * - failed: Session reported failure
 */
const VALID_STATES = ['pending', 'in_progress', 'completed', 'blocked', 'failed'];

/**
 * Create a new shared task.
 * @param {object} opts
 * @param {string} opts.title - Short description
 * @param {string} [opts.description] - Detailed instructions
 * @param {string} [opts.createdBy] - Session ID or 'orchestrator'
 * @param {string} [opts.assignedTo] - Session ID to pre-assign
 * @param {string[]} [opts.dependsOn] - Task IDs this depends on
 * @param {string} [opts.priority] - 'low' | 'normal' | 'high' | 'critical'
 * @returns {object} Created task
 */
function createTask(opts) {
  const id = crypto.randomBytes(4).toString('hex');
  const task = {
    id,
    title: opts.title,
    description: opts.description || '',
    status: 'pending',
    createdBy: opts.createdBy || 'user',
    assignedTo: opts.assignedTo || null,
    dependsOn: opts.dependsOn || [],
    priority: opts.priority || 'normal',
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };

  // Check if dependencies exist
  for (const depId of task.dependsOn) {
    if (!tasks.has(depId)) {
      throw new Error(`Dependency task ${depId} not found`);
    }
  }

  // If has unresolved dependencies, mark as blocked
  if (task.dependsOn.length > 0) {
    const allResolved = task.dependsOn.every(depId => {
      const dep = tasks.get(depId);
      return dep && dep.status === 'completed';
    });
    if (!allResolved) task.status = 'blocked';
  }

  tasks.set(id, task);
  events.emit('task:created', task);
  save();
  return task;
}

/**
 * Claim a task for a session.
 * @param {string} taskId
 * @param {string} sessionId - Who is claiming
 * @returns {object|null} The claimed task, or null if not claimable
 */
function claimTask(taskId, sessionId) {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.status !== 'pending') return null;

  // Check dependencies
  for (const depId of task.dependsOn) {
    const dep = tasks.get(depId);
    if (!dep || dep.status !== 'completed') return null;
  }

  task.status = 'in_progress';
  task.assignedTo = sessionId;
  task.updatedAt = new Date().toISOString();
  events.emit('task:claimed', task);
  save();
  return task;
}

/**
 * Complete a task with an optional result message.
 * @param {string} taskId
 * @param {string} sessionId - Who is completing
 * @param {string} [result] - Result/summary text
 * @returns {object|null}
 */
function completeTask(taskId, sessionId, result) {
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.assignedTo && task.assignedTo !== sessionId) return null;

  task.status = 'completed';
  task.result = result || null;
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  events.emit('task:completed', task);

  // Unblock dependent tasks
  for (const [, other] of tasks) {
    if (other.status === 'blocked' && other.dependsOn.includes(taskId)) {
      const allResolved = other.dependsOn.every(depId => {
        const dep = tasks.get(depId);
        return dep && dep.status === 'completed';
      });
      if (allResolved) {
        other.status = 'pending';
        other.updatedAt = new Date().toISOString();
        events.emit('task:unblocked', other);
      }
    }
  }

  save();
  return task;
}

/**
 * Fail a task.
 */
function failTask(taskId, sessionId, reason) {
  const task = tasks.get(taskId);
  if (!task) return null;

  task.status = 'failed';
  task.result = reason || 'Failed';
  task.updatedAt = new Date().toISOString();
  events.emit('task:failed', task);
  save();
  return task;
}

/**
 * Get all tasks, optionally filtered.
 */
function listTasks(filter = {}) {
  let result = Array.from(tasks.values());
  if (filter.status) result = result.filter(t => t.status === filter.status);
  if (filter.assignedTo) result = result.filter(t => t.assignedTo === filter.assignedTo);
  if (filter.createdBy) result = result.filter(t => t.createdBy === filter.createdBy);
  return result;
}

/**
 * Get a single task.
 */
function getTask(taskId) {
  return tasks.get(taskId) || null;
}

/**
 * Delete a task.
 */
function deleteTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return false;
  tasks.delete(taskId);
  events.emit('task:deleted', task);
  save();
  return true;
}

/**
 * Get next available task for a session (auto-claim the highest priority pending task).
 */
function claimNext(sessionId) {
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  const pending = listTasks({ status: 'pending' })
    .filter(t => !t.assignedTo || t.assignedTo === sessionId)
    .sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

  for (const task of pending) {
    const claimed = claimTask(task.id, sessionId);
    if (claimed) return claimed;
  }
  return null;
}

/**
 * Format task list for Telegram display.
 */
function formatForTelegram() {
  const all = listTasks();
  if (all.length === 0) return '<i>No shared tasks</i>';

  const statusIcon = { pending: '\u23f3', in_progress: '\u26a1', completed: '\u2705', blocked: '\ud83d\udd12', failed: '\u274c' };
  const priorityIcon = { critical: '\ud83d\udd34', high: '\ud83d\udfe0', normal: '\ud83d\udfe2', low: '\u26aa' };

  const lines = all.map(t => {
    const status = statusIcon[t.status] || '\u2753';
    const priority = priorityIcon[t.priority] || '';
    const assignee = t.assignedTo ? ` \u2192 <code>${t.assignedTo}</code>` : '';
    const deps = t.dependsOn.length > 0 ? ` [deps: ${t.dependsOn.join(', ')}]` : '';
    return `${status} ${priority} <code>${t.id}</code> ${t.title}${assignee}${deps}`;
  });

  const stats = {
    total: all.length,
    pending: all.filter(t => t.status === 'pending').length,
    active: all.filter(t => t.status === 'in_progress').length,
    done: all.filter(t => t.status === 'completed').length,
  };

  return [
    `<b>Shared Tasks</b> (${stats.done}/${stats.total} done, ${stats.active} active)`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Persist tasks to disk.
 */
function save() {
  try {
    const data = Object.fromEntries(tasks);
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[shared-tasks] Save failed:', err.message);
  }
}

/**
 * Load tasks from disk.
 */
function load() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return;
    const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    for (const [id, task] of Object.entries(data)) {
      tasks.set(id, task);
    }
    console.log(`[shared-tasks] Loaded ${tasks.size} tasks`);
  } catch (err) {
    console.error('[shared-tasks] Load failed:', err.message);
  }
}

/**
 * Clear all completed/failed tasks.
 */
function clearDone() {
  let cleared = 0;
  for (const [id, task] of tasks) {
    if (task.status === 'completed' || task.status === 'failed') {
      tasks.delete(id);
      cleared++;
    }
  }
  if (cleared > 0) save();
  return cleared;
}

// Load on require
load();

module.exports = {
  createTask,
  claimTask,
  completeTask,
  failTask,
  listTasks,
  getTask,
  deleteTask,
  claimNext,
  formatForTelegram,
  clearDone,
  events,
};
