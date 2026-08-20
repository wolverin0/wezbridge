'use strict';
/**
 * decision-push.cjs — pushes operator-gated tasks to the operator (lib only).
 *
 * Slice 1 of the 2026-08-20 observability plan: nothing EMPUJA al operador al
 * board, so gated questions sit unseen for days. The telegram-streamer's
 * existing poll loop calls pushDecisions() so each NEW decision produces ONE
 * Telegram message in the 'decisiones' topic with a link to the board.
 *
 * This is a library, deliberately NOT a process: no timer, no pane-typing,
 * no daemon. The one always-on loop it rides is telegram-streamer.cjs, which
 * is already allowlisted in src/COORDINATORS.json.
 *
 * THE gate predicate is imported from scripts/fleet-board.cjs. The historical
 * bug (see the comment above gateOf there) was two diverging predicates —
 * `contract.gate` vs top-level `gate`. Do not write a third one here.
 */
const fs = require('node:fs');
const path = require('node:path');
const { gateOf } = require('../scripts/fleet-board.cjs');

/** Open per the slice contract: a done/cancelled task owes no decision. */
const OPEN_STATES = ['queued', 'ready', 'running', 'review', 'blocked'];

const STATE_BASENAME = '.decision-pushed.json';

function intelDir() {
  const dir = process.env.WEZBRIDGE_INTEL_DIR
    || 'G:/_OneDrive/OneDrive/Desktop/Py Apps/_intel';
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fail-soft */ }
  return dir;
}

function boardUrl() {
  return process.env.WEZBRIDGE_BOARD_URL || 'http://127.0.0.1:4272/';
}

const isDecision = (t) => OPEN_STATES.includes(t.state) && gateOf(t) === 'operator';

/**
 * PURE. Given the current ledger tasks and the pushed-state map, return:
 *   toNotify — decisions not yet pushed (new, or re-gated after a clear)
 *   state    — pushedState pruned of entries whose task is no longer a
 *              decision (ungated, closed, or gone). Clearing is what makes
 *              re-gating re-notify: the same task gated AGAIN is a NEW
 *              question the operator has not seen.
 * Never mutates its inputs.
 */
function detectNewDecisions(tasks, pushedState, now) { // eslint-disable-line no-unused-vars
  const decisions = (tasks || []).filter(isDecision);
  const decisionIds = new Set(decisions.map((t) => t.id));

  const state = {};
  for (const [id, entry] of Object.entries(pushedState || {})) {
    if (decisionIds.has(id)) state[id] = entry;
  }

  const toNotify = decisions.filter((t) => !(t.id in state));
  return { toNotify, state };
}

function loadPushedState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STATE_BASENAME), 'utf8')); }
  catch { return {}; }
}

/** Atomic tmp+rename so a crash mid-write cannot corrupt the dedupe state. */
function savePushedState(dir, state) {
  try {
    const file = path.join(dir, STATE_BASENAME);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* fail-soft: worst case is a duplicate notification next cycle */ }
}

// sendMsg posts with parse_mode HTML, so field text must be escaped.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ONE plain message: id, repo, title, blocker/question excerpt, board link. */
function formatDecisionMessage(task) {
  const excerpt = String(task.blocker || task.next_action || task.goal || '')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
  const lines = [
    `🔔 Decisión pendiente: ${esc(task.id)} · ${esc(task.repo || '?')}`,
    esc(task.title || '(sin título)'),
  ];
  if (excerpt) lines.push('', esc(excerpt));
  lines.push('', `Board: ${esc(boardUrl())}`);
  return lines.join('\n');
}

/** Durable metadata-only trace; the board's activity feed reads events.jsonl. */
function appendNotifiedEvent(dir, taskId, now) {
  try {
    const line = JSON.stringify({
      time: new Date(now).toISOString(), event: 'decision.notified', task_id: taskId,
    });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), line + '\n');
  } catch { /* fail-soft */ }
}

/**
 * One poll-cycle pass. `send(text) -> {ok}` is injected (the streamer passes
 * its sendMsg bound to the 'decisiones' topic; tests pass a stub).
 *
 * A task is marked pushed ONLY after a successful POST — a failed or thrown
 * send leaves the entry absent so the next cycle retries. Never throws.
 */
async function pushDecisions({ tasks, send, now = Date.now(), onNotified } = {}) {
  const dir = intelDir();
  const loaded = loadPushedState(dir);
  const { toNotify, state } = detectNewDecisions(tasks, loaded, now);

  // Persist prunes (ungate/close) even when there is nothing to send —
  // that durable clear is exactly what lets a later re-gate re-notify.
  let current = state;
  if (Object.keys(loaded).length !== Object.keys(state).length) {
    savePushedState(dir, current);
  }

  const notified = [];
  const failed = [];
  for (const task of toNotify) {
    let result;
    try { result = await send(formatDecisionMessage(task)); }
    catch (err) { result = { ok: false, description: err.message }; }

    if (result && result.ok) {
      current = { ...current, [task.id]: { pushed_at: new Date(now).toISOString() } };
      savePushedState(dir, current);
      appendNotifiedEvent(dir, task.id, now);
      notified.push(task.id);
      if (onNotified) { try { onNotified(task.id); } catch { /* fail-soft */ } }
    } else {
      failed.push(task.id);
    }
  }
  return { notified, failed };
}

module.exports = {
  detectNewDecisions, pushDecisions, formatDecisionMessage,
  loadPushedState, savePushedState, STATE_BASENAME, OPEN_STATES,
};
