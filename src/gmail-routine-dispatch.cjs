'use strict';
const fs = require('node:fs');
const identity = require('./pane-identity.cjs');
const projectQueue = require('./project-queue.cjs');
const { a2aLengthRefusal } = require('./a2a-length-guard.cjs');

function queueOutcome(options, body, hit, outcome, enqueue) {
  const ok = outcome.submitted === 'submitted' && outcome.delivered === 'ok';
  const saved = enqueue({ project: 'wezbridge', corr: `gmail-recordatorios:${options.runId}`,
    type: 'request', from_pane: null, from_project: 'gmail-recordatorios',
    resolved_pane: hit.paneId, submitted: outcome.submitted || null,
    delivered: outcome.delivered || null, ok, body }, { base: options.intelDir });
  return { ...outcome, queued: saved.ok && !ok, queue_id: saved.id,
    resolved_pane: hit.paneId, exit_status: saved.ok ? outcome.exit_status : 1,
    ...(saved.ok ? {} : { error: 'durable queue append failed' }) };
}

async function dispatchGmailRoutine(options, dependencies = {}) {
  const discover = dependencies.discover || require('./pane-discovery.cjs').discoverPanes;
  const resolve = dependencies.resolve || identity.resolve;
  const send = dependencies.send || require('./verified-send.cjs');
  const enqueue = dependencies.enqueue || projectQueue.enqueue;
  const prompt = fs.readFileSync(options.promptFile, 'utf8').trim();
  const completion = `Run ${options.runId}. Al terminar: node scripts/gmail-recordatorios-run.cjs complete --run ${options.runId} --seen N --created N --existing N --doubtful N. Si falla Gmail/SP: fail --run ${options.runId} --reason <motivo>.`;
  const body = `${prompt}\n${completion}`;
  const refusal = a2aLengthRefusal(body);
  if (refusal) return { exit_status: 2, error: refusal, queued: false };
  let panes = [];
  try { panes = discover().filter(p => p.agent); } catch { /* unresolved -> existing durable queue */ }
  const hit = resolve('wezbridge', panes.map(p => ({ pane_id: p.paneId,
    cwd: p.project, tab_title: p.tabTitle || p.title || null })));
  const target = panes.find(p => p.paneId === hit.paneId);
  let outcome = { exit_status: 0, submitted: null, delivered: null };
  if (hit.paneId === null || hit.ambiguous.length || hit.matchedBy !== 'cwd') {
    return queueOutcome(options, body, { ...hit, paneId: null },
      { ...outcome, exit_status: hit.ambiguous.length ? 5 : 4, reason: 'no unambiguous project/cwd target' }, enqueue);
  }
  try {
  if (target.status === 'idle' && !send.paneComposerHoldsForeignText?.(hit.paneId)) {
    const envelope = `[A2A from gmail-recordatorios to wezbridge | corr=gmail-recordatorios:${options.runId} | type=request]\n${body}`;
    try {
      const delivered = await send.sendPromptDeferredEnter(hit.paneId, envelope);
      const submitted = delivered?.refused ? null : await send.verifyPromptSubmission(hit.paneId, envelope);
      outcome = { delivered, submitted, exit_status: delivered === 'ok' && submitted === 'submitted' ? 0 : 7 };
    } catch (error) { outcome = { ...outcome, exit_status: 6, error: String(error.message || error).slice(0, 240) }; }
  }
  } catch (error) { outcome = { ...outcome, exit_status: 6, error: String(error.message || error).slice(0, 240) }; }
  return queueOutcome(options, body, hit, outcome, enqueue);
}

module.exports = { dispatchGmailRoutine };
