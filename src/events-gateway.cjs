'use strict';
/**
 * events-gateway.cjs — decision-push sink towards the central de avisos (T-0334).
 *
 * Emits ONE event per pending operator decision to personaldashboard's
 * `POST /v1/events` (contract: personaldashboard/docs/CENTRAL-NOTIFICATION-HUB.md
 * @2d42cca). Policy there is deterministic: source=wezbridge kind=decision → P1
 * (bandeja + digest 09/18, never direct Telegram). Each event carries three
 * SIGNED actions to the tablero's /act (approve/cancel/defer) so a tap from
 * the phone writes the same ruling the board writes.
 *
 * Signing per the hub: HMAC-SHA256 over the exact UTF-8 bytes
 * `${unix_ts}.${rawBody}`, headers X-Event-Source / X-Event-Timestamp /
 * X-Event-Signature: sha256=<hex>. The secret comes from env
 * (PERSONALDASHBOARD_EVENTS_HMAC_SECRET, loaded by the streamer launcher from
 * wezbridge/.env.local); it is never logged and never travels over A2A.
 *
 * Library only: no timer, no process. telegram-streamer.cjs calls
 * selectDecisionSink(process.env) once and passes the sender to pushDecisions.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { decisionActions } = require('../board-app/lib/action-links.cjs');

const SOURCE = 'wezbridge';
const KIND_DECISION = 'decision';
const TTL_SEC = 604800;

function signEventBody(secret, ts, rawBody) {
  return crypto.createHmac('sha256', String(secret)).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
}

/** 'gateway' iff both the URL and the secret are configured; never both sinks. */
function selectDecisionSink(env = process.env) {
  const url = String(env.WEZBRIDGE_EVENTS_URL || '').trim();
  const secret = String(env.PERSONALDASHBOARD_EVENTS_HMAC_SECRET || '').trim();
  return url && secret ? 'gateway' : 'telegram';
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** PURE. The event the hub ingests for one gated task. */
function decisionEvent(task, { boardUrl, boardToken, now = Date.now() } = {}) {
  const question = clip(task.blocker || task.next_action || task.goal || '', 1500);
  const bodyLines = [
    `${task.id} · ${task.repo || '?'} · estado ${task.state || '?'}`,
    question,
    '',
    `Tablero: ${boardUrl}`,
  ].filter((l, i) => i !== 1 || l);
  return {
    source: SOURCE,
    kind: KIND_DECISION,
    severity: 'P1',
    title: clip(`${task.id} · ${task.repo || '?'}: ${task.title || '(sin título)'}`, 255),
    body: bodyLines.join('\n').slice(0, 5000),
    dedupe_key: String(task.id),
    entity: String(task.id),
    links: [{ label: 'Tablero', url: boardUrl }],
    actions: boardToken ? decisionActions(boardUrl, boardToken, task.id, { now }) : [],
    ttl: TTL_SEC,
  };
}

/** BOARD_TOKEN from board-app/.env.local; null when absent (no signing, no actions). */
function loadBoardToken(file = path.join(__dirname, '..', 'board-app', '.env.local')) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^BOARD_TOKEN=(.+)$/m);
    return m && m[1].trim() ? m[1].trim() : null;
  } catch { return null; }
}

/**
 * Returns `send(text, task) -> {ok, via, status, description}` shaped like the
 * Telegram sender so pushDecisions is sink-agnostic. Never throws.
 */
function createGatewaySender({
  url, secret, boardUrl, boardToken, fetchImpl = globalThis.fetch, now = Date.now, source = SOURCE,
}) {
  const endpoint = new URL('/v1/events', url).toString();
  return async function send(_text, task) {
    if (!task || !task.id) return { ok: false, via: 'gateway', description: 'no task for event' };
    const ts = Math.floor(now() / 1000);
    const rawBody = JSON.stringify(decisionEvent(task, { boardUrl, boardToken, now: ts * 1000 }));
    const headers = {
      'Content-Type': 'application/json',
      'X-Event-Source': source,
      'X-Event-Timestamp': String(ts),
      'X-Event-Signature': `sha256=${signEventBody(secret, ts, rawBody)}`,
    };
    try {
      const res = await fetchImpl(endpoint, { method: 'POST', headers, body: rawBody });
      if (res.status >= 200 && res.status < 300) return { ok: true, via: 'gateway', status: res.status };
      let detail = '';
      try { detail = clip(await res.text(), 200); } catch { /* body optional */ }
      return { ok: false, via: 'gateway', status: res.status, description: `HTTP ${res.status} ${detail}`.trim() };
    } catch (err) {
      return { ok: false, via: 'gateway', description: err.message };
    }
  };
}

/** Builds the sender from env, or null when the gateway is not configured. */
function gatewaySenderFromEnv(env = process.env, opts = {}) {
  if (selectDecisionSink(env) !== 'gateway') return null;
  return createGatewaySender({
    url: env.WEZBRIDGE_EVENTS_URL,
    secret: env.PERSONALDASHBOARD_EVENTS_HMAC_SECRET,
    boardUrl: env.WEZBRIDGE_BOARD_PUBLIC_URL || env.WEZBRIDGE_BOARD_URL || 'http://127.0.0.1:4272/',
    boardToken: opts.boardToken !== undefined ? opts.boardToken : loadBoardToken(),
    ...opts,
  });
}

module.exports = {
  SOURCE, KIND_DECISION, TTL_SEC,
  signEventBody, selectDecisionSink, decisionEvent, createGatewaySender, gatewaySenderFromEnv, loadBoardToken,
};
