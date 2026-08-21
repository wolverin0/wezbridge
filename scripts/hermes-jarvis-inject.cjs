#!/usr/bin/env node
'use strict';
/**
 * hermes-jarvis-inject.cjs — inject a tagged pane message into the LIVE Jarvis
 * Telegram session as a conversational participant, via the native pane_bridge
 * plugin ingress. The agent's reply is delivered BY THE GATEWAY through Telegram
 * (not returned here) — that Telegram reply is the proof of success, per the
 * Snake directive 2026-08-21 (corr=hermes-pane-bridge-20260821).
 *
 * Native path (see integrations/hermes-pane-bridge/adapter.py):
 *   POST http://<gateway>:8642/api/platforms/pane_bridge/events
 *   Authorization: Bearer <PANE_BRIDGE_SECRET>   (scoped — NOT the master key)
 *   body: {"message": "<text>"}
 *   -> plugin builds a SessionSource for the live Telegram chat and calls
 *      gateway.wake.deliver_wake(telegram_adapter, source=...) -> synthetic
 *      inbound MessageEvent -> Jarvis runs a participant turn -> reply via Telegram.
 *
 * Secret handling: PANE_BRIDGE_SECRET is read from an ACL-restricted file
 * %USERPROFILE%\.hermes-bridge\pane-bridge.secret — never argv/prompt/log.
 *
 * Usage: node hermes-jarvis-inject.cjs "message text"
 *        node hermes-jarvis-inject.cjs --gateway 192.168.100.186:8642 "message"
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SECRETS_DIR = path.join(process.env.USERPROFILE || '', '.hermes-bridge');
let GATEWAY = { host: '192.168.100.186', port: 8642 };

function readSecret(name) {
  const p = path.join(SECRETS_DIR, name);
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    console.error(`[inject] missing secret file: ${p}`);
    process.exit(2);
  }
}

function post(gw, urlPath, bearer, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({
      host: gw.host, port: gw.port, path: urlPath, method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--gateway') {
    const [h, p] = String(args[1]).split(':');
    GATEWAY = { host: h, port: parseInt(p, 10) || 8642 };
    args.splice(0, 2);
  }
  const message = args.join(' ').trim();
  if (!message) { console.error('[inject] no message given'); process.exit(2); }

  const secret = readSecret('pane-bridge.secret');
  const res = await post(GATEWAY, '/api/platforms/pane_bridge/events', secret, { message });

  const evidence = {
    request: { gateway: `${GATEWAY.host}:${GATEWAY.port}`, path: '/api/platforms/pane_bridge/events' },
    http_status: res.status,
    response: res.body,
    note: 'HTTP accepted != conversational delivery. Confirm the tagged message + Jarvis reply appear in the Telegram chat.',
  };
  console.log(JSON.stringify(evidence, null, 2));
  // 200/202 = the gateway accepted and scheduled the participant turn.
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
})().catch((e) => { console.error(`[inject] error: ${e.message}`); process.exit(1); });
