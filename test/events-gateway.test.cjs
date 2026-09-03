'use strict';
/**
 * events-gateway.test.cjs — decision-push → POST /v1/events (T-0334 AC1/AC3).
 *
 * Contract under test is personaldashboard/docs/CENTRAL-NOTIFICATION-HUB.md @2d42cca:
 * headers X-Event-Source / X-Event-Timestamp (unix s) / X-Event-Signature=sha256=<hex>,
 * HMAC-SHA256 over the exact bytes `${ts}.${rawBody}`; required fields source,
 * kind, severity, title, body, dedupe_key, entity; actions {id,label,url}.
 * Guards: one event per decision with dedupe_key = task id and three SIGNED
 * board actions; the sink is chosen deterministically from env (gateway when
 * configured, Telegram otherwise — never both).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const {
  decisionEvent, signEventBody, createGatewaySender, selectDecisionSink,
} = require('../src/events-gateway.cjs');
const { verifyAction } = require('../board-app/lib/action-links.cjs');
const { pushDecisions } = require('../src/decision-push.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NOW = Date.parse('2026-09-03T20:00:00Z');
const BOARD = 'http://192.168.100.20:4272/';
const BOARD_TOKEN = 'board-token-x';
const SECRET = 'hub-secret-y';

const gated = {
  id: 'T-0334', repo: 'wezbridge', title: 'central de avisos F1', state: 'blocked',
  contract: { gate: 'operator' }, gate: null,
  blocker: '¿Desplegamos el PR #1701 ahora?',
};

test('decisionEvent: required fields, dedupe_key = task id, three signed actions to the board', () => {
  const ev = decisionEvent(gated, { boardUrl: BOARD, boardToken: BOARD_TOKEN, now: NOW });
  assert.strictEqual(ev.source, 'wezbridge');
  assert.strictEqual(ev.kind, 'decision');
  assert.strictEqual(ev.severity, 'P1');
  assert.strictEqual(ev.dedupe_key, 'T-0334');
  assert.strictEqual(ev.entity, 'T-0334');
  assert.ok(ev.title.includes('T-0334') && ev.title.includes('central de avisos F1'));
  assert.ok(ev.body.includes('Desplegamos'), 'body carries the question');
  assert.ok(ev.body.length <= 5000 && ev.title.length <= 255);
  assert.deepStrictEqual(ev.links, [{ label: 'Tablero', url: BOARD }]);
  assert.deepStrictEqual(ev.actions.map((a) => a.id), ['approved', 'cancelled', 'deferred']);
  for (const a of ev.actions) {
    const u = new URL(a.url);
    assert.strictEqual(u.origin, 'http://192.168.100.20:4272');
    assert.strictEqual(u.pathname, '/act');
    assert.strictEqual(verifyAction(BOARD_TOKEN, Object.fromEntries(u.searchParams), NOW).ok, true, `${a.id} must verify`);
    assert.ok(!('method' in a), 'GET links: the hub renders them, the board confirms on POST');
  }
});

test('without a board token there are no actions, only the board link (fail-soft, never a broken URL)', () => {
  const ev = decisionEvent(gated, { boardUrl: BOARD, boardToken: null, now: NOW });
  assert.deepStrictEqual(ev.actions, []);
  assert.strictEqual(ev.links[0].url, BOARD);
});

test('signature is HMAC-SHA256 over `${ts}.${rawBody}` exactly as the hub verifies it', () => {
  const raw = '{"a":1}';
  const ts = 1756929600;
  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex');
  assert.strictEqual(signEventBody(SECRET, ts, raw), expected);
});

test('the sender posts signed bytes and reports ok only on 2xx', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 201, ok: true, text: async () => '{"id":"evt-1"}' };
  };
  const send = createGatewaySender({
    url: 'http://hub.lan:4000', secret: SECRET, boardUrl: BOARD, boardToken: BOARD_TOKEN, fetchImpl, now: () => NOW,
  });
  const r = await send('ignored telegram text', gated);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.via, 'gateway');
  assert.strictEqual(calls.length, 1);
  const { url, init } = calls[0];
  assert.strictEqual(url, 'http://hub.lan:4000/v1/events');
  assert.strictEqual(init.method, 'POST');
  assert.strictEqual(init.headers['X-Event-Source'], 'wezbridge');
  const ts = Number(init.headers['X-Event-Timestamp']);
  assert.strictEqual(ts, Math.floor(NOW / 1000));
  const sig = init.headers['X-Event-Signature'];
  assert.strictEqual(sig, `sha256=${signEventBody(SECRET, ts, init.body)}`, 'signature must cover the exact body bytes sent');
  const parsed = JSON.parse(init.body);
  assert.strictEqual(parsed.dedupe_key, 'T-0334');

  const denied = createGatewaySender({
    url: 'http://hub.lan:4000/', secret: 'wrong', boardUrl: BOARD, boardToken: BOARD_TOKEN, now: () => NOW,
    fetchImpl: async () => ({ status: 401, ok: false, text: async () => 'bad signature' }),
  });
  const d = await denied('x', gated);
  assert.strictEqual(d.ok, false);
  assert.match(d.description, /401/);

  const down = createGatewaySender({
    url: 'http://hub.lan:4000', secret: SECRET, boardUrl: BOARD, boardToken: BOARD_TOKEN, now: () => NOW,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const e = await down('x', gated);
  assert.strictEqual(e.ok, false, 'a thrown fetch is a failed send, not a crash');
});

test('selectDecisionSink: gateway iff url+secret are configured; Telegram otherwise', () => {
  assert.strictEqual(selectDecisionSink({}), 'telegram');
  assert.strictEqual(selectDecisionSink({ WEZBRIDGE_EVENTS_URL: 'http://h:4000' }), 'telegram');
  assert.strictEqual(selectDecisionSink({ PERSONALDASHBOARD_EVENTS_HMAC_SECRET: 's' }), 'telegram');
  assert.strictEqual(selectDecisionSink({ WEZBRIDGE_EVENTS_URL: 'http://h:4000', PERSONALDASHBOARD_EVENTS_HMAC_SECRET: 's' }), 'gateway');
});

test('end to end through pushDecisions: one POST per new decision, dedupe on the second cycle, events.jsonl says via=gateway', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-gw-'));
  process.env.WEZBRIDGE_INTEL_DIR = dir;
  const posted = [];
  const send = createGatewaySender({
    url: 'http://hub.lan:4000', secret: SECRET, boardUrl: BOARD, boardToken: BOARD_TOKEN, now: () => NOW,
    fetchImpl: async (_u, init) => { posted.push(JSON.parse(init.body)); return { status: 201, ok: true, text: async () => '' }; },
  });
  const r1 = await pushDecisions({ tasks: [gated], send, now: NOW });
  assert.deepStrictEqual(r1.notified, ['T-0334']);
  const r2 = await pushDecisions({ tasks: [gated], send, now: NOW });
  assert.deepStrictEqual(r2.notified, []);
  assert.strictEqual(posted.length, 1);
  const evt = JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim());
  assert.strictEqual(evt.event, 'decision.notified');
  assert.strictEqual(evt.via, 'gateway');
});
