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
