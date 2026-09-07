'use strict';
// One task per child. The parent owns the deadline and process-tree cleanup.
const WEZ_METHODS = new Set(['listPanes', 'getFullText', 'getText', 'sendText',
  'sendTextNoEnter', 'sendTextBracketed', 'spawnPane', 'killPane', 'setTabTitle']);
const SEND_METHODS = new Set(['sendPromptDeferredEnter', 'verifyPromptSubmission',
  'paneComposerHoldsForeignText', 'composerHoldsTail']);

function snapshot(options = {}) {
  const wez = require('./wezterm.cjs');
  return require('./session-snapshot.cjs').snapshotOnce({ ...options, listPanes: () => {
    const raw = wez.listPanes();
    const discovered = require('./pane-discovery.cjs').discoverPanes();
    const agents = new Map(discovered.filter(pane => pane.agent).map(pane => [pane.paneId, pane.agent]));
    return raw.map(pane => agents.has(pane.pane_id) ? { ...pane, cmdline_hint: agents.get(pane.pane_id) } : pane);
  } });
}

async function execute(operation, args) {
  if (operation === 'discover') return require('./pane-discovery.cjs').discoverPanes();
  if (operation === 'snapshot') return snapshot(args[0]);
  const [group, name] = String(operation).split('.');
  if (group === 'wez' && WEZ_METHODS.has(name)) return require('./wezterm.cjs')[name](...args);
  if (group === 'verified' && SEND_METHODS.has(name)) return require('./verified-send.cjs')[name](...args);
  throw new Error('unsupported daemon CLI operation');
}

process.once('message', async message => {
  let response;
  try { response = { type: 'result', value: await execute(message.operation, message.args || []) }; }
  catch (error) { response = { type: 'result', error: { code: error.code || 'DAEMON_CLI_FAILED', message: error.message } }; }
  if (!process.connected) return process.exit(1);
  // Keep the worker as the tree root until the parent kills its CLI descendants.
  // Only successful pane creation may deliberately leave a GUI child alive.
  process.send(response, () => {
    if (!response.error && message.operation === 'wez.spawnPane') process.exit(0);
  });
});
process.once('disconnect', () => process.exit(0));
