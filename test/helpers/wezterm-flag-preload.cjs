'use strict';
// T-0596 item 4: preload for wezterm-transport-flag.test.cjs. Stubs a live
// WezTerm agent pane for `consumer` (same shape as
// helpers/queue-sender-preload.cjs) and COUNTS every call into the WezTerm
// send primitive, persisting the count to WEZTERM_CALL_COUNT_FILE so the
// parent test can assert "0 wezterm sends" with the flag off and ">0" with
// it on, without racing the child process's stdout.
require('../setup.cjs');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const countFile = process.env.WEZTERM_CALL_COUNT_FILE;

const stub = (name, overrides) => {
  const id = require.resolve(path.join(root, 'src', name));
  const original = require(id);
  require.cache[id].exports = { ...original, ...overrides };
};

stub('pane-discovery.cjs', {
  discoverRoutingPanes: () => [
    { paneId: 1, project: process.cwd(), agent: 'claude' },
    { paneId: 2, project: path.join(path.dirname(process.cwd()), 'consumer'), agent: 'claude' },
  ],
});
stub('safety-policy.cjs', { evaluate: () => ({ allowed: true }) });
stub('orca-target.cjs', {
  // No live Orca terminal either — isolates the assertion to "did the
  // WezTerm branch get used", independent of Orca resolution succeeding.
  resolveOrcaTarget: async () => ({ handle: null, matchedBy: null, ambiguous: [], warning: 'no orca terminal (test double)' }),
});
stub('verified-send.cjs', {
  sendPromptDeferredEnter: async (paneId, text) => {
    fs.writeFileSync(countFile, String(Number(fs.readFileSync(countFile, 'utf8')) + 1));
    return 'ok';
  },
  verifyPromptSubmission: async () => 'submitted',
});
