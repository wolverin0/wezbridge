'use strict';

const { createVerifiedSend } = require('./verified-send.cjs');

function normalizeCwd(value) {
  return decodeURIComponent(String(value || '').replace(/^file:\/\/[^/]*/, ''))
    .replace(/^\/([a-z]:)/i, '$1').replace(/\\/g, '/').replace(/\s/g, ' ')
    .replace(/\/+$/, '').toLowerCase();
}

function assertPinnedTarget({ paneId, cwd, socket, currentSocket, panes, text }) {
  const pane = panes.find(p => Number(p.pane_id) === paneId);
  const matches = [...String(text).matchAll(/cwd:\s*([^\r\n\uE000-\uF8FF]+)/g)];
  const visibleCwd = matches.at(-1)?.[1]?.trim();
  if (!socket || socket !== currentSocket || !pane ||
      normalizeCwd(pane.cwd) !== normalizeCwd(cwd) ||
      !visibleCwd || normalizeCwd(visibleCwd) !== normalizeCwd(cwd)) {
    throw new Error('pinned-target-mismatch: socket, census cwd and visible cwd must agree');
  }
}

function createPinnedSend({ paneId, cwd, wez = require('./wezterm.cjs'), sleep }) {
  const socket = wez.currentSocket();
  const guard = () => {
    wez.invalidateListPanesCache();
    wez.invalidateGetTextCache(paneId);
    assertPinnedTarget({ paneId, cwd, socket, currentSocket: wez.currentSocket(),
      panes: wez.listPanes(), text: wez.getFullText(paneId, 30) });
  };
  const guarded = { ...wez };
  for (const method of ['sendTextBracketed', 'sendTextNoEnter', 'sendText']) {
    guarded[method] = (...args) => { guard(); return wez[method](...args); };
  }
  guard();
  return createVerifiedSend({ wez: guarded, sleep: sleep || (ms => new Promise(r => setTimeout(r, ms))) });
}

module.exports = { normalizeCwd, assertPinnedTarget, createPinnedSend };
