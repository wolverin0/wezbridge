'use strict';

function createTaskHandlers(ctx) {
  const { sendJson, sendError, fs, ACTIVE_TASKS_PATH, parseTasksFile } = ctx;

  async function handleGetTasks(res) {
    try {
      if (!fs.existsSync(ACTIVE_TASKS_PATH)) {
        return sendJson(res, 200, { tasks: [], note: `no active_tasks.md at ${ACTIVE_TASKS_PATH}` });
      }
      const { tasks: tasksMap, errors } = parseTasksFile(ACTIVE_TASKS_PATH);
      const tasks = Array.from(tasksMap.values());
      sendJson(res, 200, { tasks, errors });
    } catch (err) {
      sendError(res, err);
    }
  }

  return { handleGetTasks };
}

module.exports = { createTaskHandlers };
