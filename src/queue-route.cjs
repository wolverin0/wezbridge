'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {operatorQuestionVisible, composerHoldsForeignText} = require('./verified-send.cjs');

function selectAvailable(panes, readText) {
  const candidates = panes.map(pane => {
    const id = pane.paneId ?? pane.pane_id;
    if (pane.verified === false) return {id,reason:'unverified'};
    if (pane.status !== 'idle') return {id,reason:'not-idle'};
    try {
      const tail = readText(id);
      if (typeof tail !== 'string' || !tail.trim()) return {id,reason:'unreadable'};
      if (/usage limit reached.*continuing automatically|out of usage credits|hit your monthly spend limit/i
        .test(tail.split('\n').slice(-15).join('\n'))) return {id,reason:'usage-limit'};
      if (operatorQuestionVisible(tail)) return {id,reason:'operator-question'};
      if (composerHoldsForeignText(tail)) return {id,reason:'composer-text'};
      return {id,reason:null};
    } catch { return {id,reason:'unreadable'}; }
  });
  const eligible = candidates.filter(p => p.reason === null);
  return {paneId:eligible.length === 1 ? eligible[0].id : null, candidates,
    reason:eligible.length === 1 ? null : eligible.length ? 'multiple-eligible' : 'none-eligible'};
}

// Use the existing routine reader: identical blocked ticks retain their age.
function reportRoute(base, project, blocked) {
  const slug = project.replace(/[^a-zA-Z0-9_-]/g,'-');
  const dir = path.join(base,'routine-findings');
  const name = `queue-route-${slug}.json`;
  if (!blocked && !fs.existsSync(path.join(dir,name))) return;
  fs.mkdirSync(dir,{recursive:true});
  const report = blocked ? {verdict:'findings',survived:[{
    title:`queue ${project}: ${blocked.reason}`, ...blocked}]} : {verdict:'clean'};
  const text = JSON.stringify(report)+'\n';
  const target = path.join(dir,name);
  try { if (fs.readFileSync(target,'utf8') === text) return; } catch {}
  fs.writeFileSync(target+'.tmp',text);
  fs.renameSync(target+'.tmp',target);
  const run = path.join(dir,'run-'+name);
  fs.writeFileSync(run+'.tmp',JSON.stringify({routine:'queue-route',repo:project,
    cadence_hours:5/60,exit_status:0,findings_file:name})+'\n');
  fs.renameSync(run+'.tmp',run);
}
module.exports = {selectAvailable,reportRoute};
