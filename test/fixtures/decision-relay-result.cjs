'use strict';
// Only the engine is replaced; execute the real CLI and real report consumer.
const engine = require.resolve('../../src/decision-relay.cjs');
require.cache[engine] = { id: engine, filename: engine, loaded: true, exports: {
  createRelay: () => ({
    relayOnce: async () => {
      if (process.env.RELAY_TEST_RESULT === 'fatal') throw new Error('fixture fatal');
      return { ingested: 0, delivered: [], queued: [], undeliverable: [],
        flagged: process.env.RELAY_TEST_RESULT === 'flagged'
          ? [{ task: 'T-0351', project: 'wezbridge', reason: 'attempt cap reached (3)' }] : [] };
    },
    status: () => ({ pending: 0, flagged: 0 }),
  }),
} };
