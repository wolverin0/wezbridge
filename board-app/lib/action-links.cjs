'use strict';
/**
 * action-links.cjs — signed action URLs for the tablero (T-0334).
 *
 * The central de avisos renders each decision with actions the operator taps
 * from a phone. A phone has no x-board-token and cannot attach a JSON body, so
 * the URL is the credential: `/act?task&verb&exp&sig` where sig is an
 * HMAC-SHA256 over "task\nverb\nexp" keyed by a value DERIVED from BOARD_TOKEN
 * (never the token itself, so a leaked link never leaks the token). The
 * server answers GET /act with a confirmation form and applies the ruling only
 * on POST /act — a link prefetch can never approve anything.
 *
 * Pure module: no IO, no clock of its own (callers pass `now`).
 */
const crypto = require('node:crypto');

/** verb → label shown to the operator; the ONLY verbs a link may carry. */
const ACTION_VERBS = Object.freeze({
  approved: 'Aprobar',
  cancelled: 'Cancelar',
  deferred: 'Diferir',
});

const DEFAULT_TTL_SEC = 7 * 86400;
const TASK_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function actionKey(token) {
  return crypto.createHmac('sha256', String(token)).update('board-action-v1').digest();
}

function payload({ task, verb, exp }) {
  return `${task}\n${verb}\n${exp}`;
}

function signAction(token, { task, verb, exp }) {
  if (!ACTION_VERBS[verb]) throw new Error(`unknown action verb: ${verb}`);
  if (!TASK_RE.test(String(task))) throw new Error(`invalid task id: ${task}`);
  const e = Number(exp);
  if (!Number.isInteger(e)) throw new Error('exp must be an integer (unix seconds)');
  return crypto.createHmac('sha256', actionKey(token)).update(payload({ task, verb, exp: e })).digest('hex');
}

/** Never throws: a phone-typed or tampered query gets {ok:false, error}. */
function verifyAction(token, query, now = Date.now()) {
  if (!query || typeof query !== 'object') return { ok: false, error: 'missing query' };
  const task = String(query.task || '');
  const verb = String(query.verb || '');
  const exp = Number(query.exp);
  const sig = String(query.sig || '');
  if (!TASK_RE.test(task)) return { ok: false, error: 'invalid task id' };
  if (!ACTION_VERBS[verb]) return { ok: false, error: 'unknown verb' };
  if (!Number.isInteger(exp)) return { ok: false, error: 'invalid exp' };
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, error: 'invalid signature format' };
  if (exp * 1000 < now) return { ok: false, error: 'link expired' };
  const expected = signAction(token, { task, verb, exp });
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'bad signature' };
  return { ok: true, task, verb, exp };
}

function buildActionUrl(base, token, { task, verb, now = Date.now(), ttlSec = DEFAULT_TTL_SEC }) {
  const exp = Math.floor(now / 1000) + Math.max(60, Number(ttlSec) || DEFAULT_TTL_SEC);
  const sig = signAction(token, { task, verb, exp });
  const u = new URL('/act', base);
  u.search = new URLSearchParams({ task, verb, exp: String(exp), sig }).toString();
  return u.toString();
}

/** The three actions a decision carries, in the order the bandeja shows them. */
function decisionActions(base, token, task, opts = {}) {
  return Object.entries(ACTION_VERBS).map(([verb, label]) => ({
    id: verb,
    label,
    url: buildActionUrl(base, token, { task, verb, ...opts }),
  }));
}

module.exports = {
  ACTION_VERBS, DEFAULT_TTL_SEC, signAction, verifyAction, buildActionUrl, decisionActions,
};
