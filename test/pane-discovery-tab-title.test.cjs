const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEZTERM_PATH = path.resolve(__dirname, '..', 'src', 'wezterm.cjs');
const DISCOVERY_PATH = path.resolve(__dirname, '..', 'src', 'pane-discovery.cjs');

test('discovery exposes the user-set tab title for deterministic peer selection', () => {
  const originalWezterm = require.cache[WEZTERM_PATH];
  require.cache[WEZTERM_PATH] = {
    id: WEZTERM_PATH,
    filename: WEZTERM_PATH,
    loaded: true,
    exports: {
      listPanes: () => [{
        pane_id: 10,
        title: 'whatsappbot-final',
        tab_title: 'whatsappbot-roadmap-autopilot-codex',
        workspace: 'whatsappbot-roadmap-autopilot',
        cwd: 'file:///G:/repo/',
      }],
      getFullText: () => 'gpt-5.6-sol\n> ',
    },
  };

  try {
    delete require.cache[DISCOVERY_PATH];
    const { discoverPanes } = require(DISCOVERY_PATH);
    const [pane] = discoverPanes();
    assert.equal(pane.agent, 'codex');
    assert.equal(pane.tabTitle, 'whatsappbot-roadmap-autopilot-codex');
  } finally {
    delete require.cache[DISCOVERY_PATH];
    if (originalWezterm) require.cache[WEZTERM_PATH] = originalWezterm;
    else delete require.cache[WEZTERM_PATH];
  }
});

test('discover_sessions publishes codex identity and tab title', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'mcp-server.cjs'), 'utf8');
  assert.match(source, /is_codex:\s*p\.isCodex/);
  assert.match(source, /agent:\s*p\.agent/);
  assert.match(source, /tab_title:\s*p\.tabTitle/);
});
