'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolve } = require('./pane-identity.cjs');
const SOURCES = new Set(['orchestrator-pane', 'ledger-cli']);
const normalize = p => String(p || '').replace(/^file:\/\/\/?/, '').replace(/^\/([A-Za-z]:)/, '$1')
  .replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const within = (cwd, root) => normalize(cwd) === normalize(root) || normalize(cwd).startsWith(normalize(root) + '/');

// Capture at WRITE time: a later busy target or a task's state cannot prove origin.
function recordSelfDelivery(intel, ruling, now) {
  if (!SOURCES.has(ruling.source) || !['approved','cancelled'].includes(ruling.ruling)) return false;
  if (!/^\d+$/.test(process.env.WEZTERM_PANE || '')) return false;
  try {
    const card = JSON.parse(fs.readFileSync(path.join(intel, 'tasks', ruling.task + '.json'), 'utf8'));
    if (!card.repo || String(card.lease?.owner || '').startsWith('eve:')) return false;
    let relative = card.repo;
    try { relative = JSON.parse(fs.readFileSync(path.join(intel,'repos.json'),'utf8')).repos[card.repo].path || relative; } catch {}
    const root = fs.realpathSync(path.resolve(intel, '..', relative));
    if (!within(fs.realpathSync(process.cwd()), root)) return false;
    const panes = require('./pane-discovery.cjs').discoverRoutingPanes();
    const mapped = panes.filter(p => p.agent && p.verified === true).map(p => ({pane_id:p.paneId ?? p.pane_id,
      cwd:p.project || p.cwd, tab_title:p.tabTitle || p.title}));
    const target = resolve(card.repo, mapped);
    const writer = Number(process.env.WEZTERM_PANE);
    const pane = mapped.find(p => p.pane_id === writer);
    if (target.paneId !== writer || target.ambiguous.length || !pane || !within(pane.cwd,root)) return false;
    fs.appendFileSync(path.join(intel,'events.jsonl'), JSON.stringify({event:'decision.delivered',
      time:new Date(now).toISOString(),task:ruling.task,ruling:ruling.ruling,decision_at:ruling.at,
      source:ruling.source,project:card.repo,pane:writer,delivery:'self',proof:'writer-live-pane'})+'\n');
    return true;
  } catch { return false; } // No receipt means normal relay, never assumed delivery.
}

function hasSelfDelivery(intel, entry, project) {
  try {
    return fs.readFileSync(path.join(intel,'events.jsonl'),'utf8').split('\n').some(line => {
      let e; try { e=JSON.parse(line); } catch { return false; }
      return e.event==='decision.delivered' && e.delivery==='self' && e.proof==='writer-live-pane'
        && e.task===entry.task && e.ruling===entry.ruling && e.decision_at===entry.at
        && e.source===entry.source && SOURCES.has(e.source) && e.project===project
        && Number.isInteger(e.pane) && e.pane>=0 && Date.parse(e.time)>=Date.parse(entry.at);
    });
  } catch { return false; }
}
module.exports = {recordSelfDelivery,hasSelfDelivery};
