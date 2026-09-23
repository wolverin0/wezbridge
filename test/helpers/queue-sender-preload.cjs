'use strict';
require('../setup.cjs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const mode = process.env.QUEUE_SENDER_TEST_MODE;
const stub = (name, overrides) => {
  const id = require.resolve(path.join(root, 'src', name));
  const original = require(id);
  require.cache[id].exports = { ...original, ...overrides };
};
stub('pane-discovery.cjs', {
  discoverRoutingPanes: () => mode === 'queued' ? [] : [
    { paneId: 1, project: process.cwd(), agent: 'claude' },
    { paneId: 2, project: path.join(path.dirname(process.cwd()), 'consumer'), agent: 'claude' },
  ],
});
stub('safety-policy.cjs', { evaluate: () => ({ allowed: true }) });
stub('verified-send.cjs', {
  sendPromptDeferredEnter: async () => {
    if (mode === 'transport-error') throw new Error('synthetic transport unavailable');
    return mode === 'truncated' ? 'truncated' : 'ok';
  },
  verifyPromptSubmission: async () => 'submitted',
});
if (mode === 'unknown-sender') {
  stub('pane-identity.cjs', { resolveSelfPane: () => ({ paneId: 1, project: null, source: 'explicit' }) });
}
