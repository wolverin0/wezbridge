'use strict';

const { createSharedContext } = require('./shared.cjs');
const { createPaneHandlers } = require('./pane-handlers.cjs');
const { createTaskHandlers } = require('./task-handlers.cjs');
const { createEventHandlers } = require('./event-handlers.cjs');
const { createAgentHandlers } = require('./agent-handlers.cjs');
const { createMiscHandlers } = require('./misc-handlers.cjs');

function createHandlers(deps) {
  const ctx = createSharedContext(deps);
  return {
    ...createPaneHandlers(ctx),
    ...createTaskHandlers(ctx),
    ...createEventHandlers(ctx),
    ...createAgentHandlers(ctx),
    ...createMiscHandlers(ctx),
  };
}

module.exports = { createHandlers };
