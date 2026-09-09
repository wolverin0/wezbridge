'use strict';
const discovery = require('../../src/pane-discovery.cjs');
require.cache[require.resolve('../../src/pane-discovery.cjs')].exports = {
  ...discovery, discoverPanes: () => [{ paneId: 1, agent: 'claude', project: '/tmp', tabTitle: 'mock' }],
  discoverRoutingPanes: () => [{ paneId: 1, agent: 'claude', project: '/tmp', tabTitle: 'mock' }],
};
if (process.env.PINNED_TEST_FAILURE === 'after-paste') {
  const pinned = require('../../src/pinned-send.cjs');
  require.cache[require.resolve('../../src/pinned-send.cjs')].exports = {
    ...pinned, createPinnedSend: () => ({ sendPromptDeferredEnter: async () => { throw new Error('transport failed after paste'); } }),
  };
}
if (process.env.PINNED_TEST_FAILURE === 'legacy') {
  const sender = require('../../src/verified-send.cjs');
  require.cache[require.resolve('../../src/verified-send.cjs')].exports = {
    ...sender, sendPromptDeferredEnter: async () => { throw new Error('legacy transport timeout'); },
  };
}
