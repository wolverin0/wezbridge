'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const dir = process.env.WEZBRIDGE_INTEL_DIR;
const mode = process.env.SENTINEL_FIXTURE_MODE;
const refresh = () => fs.writeFileSync(path.join(dir, '.daemon-heartbeat.json'), JSON.stringify({
  ts: new Date().toISOString(), services: { orchestrator_waker: { armed: true } },
}));
function inject(relative, exports) {
  const file = require.resolve(path.join(root, relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
inject('src/daemon-probe.cjs', { probeDaemon: async () => {
  if (mode === 'during-probe') refresh();
  if (mode === 'missing-during-probe') fs.unlinkSync(path.join(dir, '.daemon-heartbeat.json'));
  return { up: true };
} });
inject('src/pane-discovery.cjs', { discoverPanes: async () => {
  if (mode === 'during-discovery') refresh();
  return [{ paneId: 9123, project: 'wezbridge', isClaude: true }];
} });
inject('src/verified-send.cjs', {
  sendPromptDeferredEnter: async (_pane, text) => {
    fs.appendFileSync(path.join(dir, 'sentinel-pokes.jsonl'), JSON.stringify({ text }) + '\n');
    return { ok: true };
  },
  verifyPromptSubmission: async () => 'submitted',
});
// T-0599 fixup: deliverPoke's default transport is now Orca (WEZBRIDGE_WEZTERM_TRANSPORT
// unset in this fixture's spawned process — same as production default), so the real
// sentinel process resolves/delivers through src/orca-target.cjs / src/orca-send.cjs, not
// the pane-discovery/verified-send doubles above (those still back the legacy WezTerm path
// when a test sets WEZBRIDGE_WEZTERM_TRANSPORT=1). Inject the Orca pair too so this
// fixture's poke capture (`sentinel-pokes.jsonl`) keeps observing whichever path the
// sentinel actually takes by default. 'during-discovery' mode simulates the heartbeat
// refreshing WHILE the sentinel is resolving its delivery target — resolveOrcaTarget is the
// Orca-path equivalent of the WezTerm path's discoverPanes() for that purpose.
inject('src/orca-target.cjs', { resolveOrcaTarget: async () => {
  if (mode === 'during-discovery') refresh();
  return { handle: 'term_sentinel_test', matchedBy: 'lane', ambiguous: [], warning: null };
} });
inject('src/orca-send.cjs', { sendToOrcaTerminal: async (handle, text) => {
  fs.appendFileSync(path.join(dir, 'sentinel-pokes.jsonl'), JSON.stringify({ text }) + '\n');
  return { ok: true, submitted: 'submitted', delivered: 'ok', handle, retryId: null, tail: ['...'], error: null };
} });
