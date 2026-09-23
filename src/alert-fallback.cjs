'use strict';

/**
 * alert-fallback.cjs — out-of-band delivery for daemon-sentinel alerts (T-0526).
 *
 * Covers: sending a DAEMON DOWN/WEDGED message via ntfy and/or Telegram when
 * deliverPoke() could not reach an orchestrator pane. Depends on nothing the
 * daemon owns (same design constraint as the sentinel itself).
 * Key terms: sendFallback, ntfy-notifier, TELEGRAM_BOT_TOKEN, no fallback
 * channel configured.
 * Read when: an alert needs a channel that survives "no orchestrator pane
 * found", or when adding/removing a fallback channel.
 *
 * Why: 157 of 199 sentinel alerts since 2026-08-22 logged delivered:false
 * ("no orchestrator pane found") and nobody was told — 70h of daemon
 * downtime in September went unnoticed. deliverPoke() alone is a single
 * point of failure; this module is the second, independent one.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const ntfy = require('./ntfy-notifier.cjs');

// Same env-file fallback telegram-streamer.cjs uses (lines ~58-84 there) —
// reused here by RESOLUTION LOGIC ONLY, not by requiring that module: it
// process.exit(1)s at load time when unconfigured and carries streamer-only
// global state, neither of which a watchdog can tolerate.
const TELEGRAM_ENV_PATH = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');
const TELEGRAM_TIMEOUT_MS = 8000;

function resolveTelegramConfig() {
  let token = process.env.TELEGRAM_BOT_TOKEN || null;
  let chatId = process.env.TELEGRAM_GROUP_ID || null;
  if (!token || !chatId) {
    try {
      for (const line of fs.readFileSync(TELEGRAM_ENV_PATH, 'utf8').split('\n')) {
        const m = line.match(/^(\w+)=(.*)$/);
        if (!m) continue;
        if (m[1] === 'TELEGRAM_BOT_TOKEN' && !token) token = m[2];
        if (m[1] === 'TELEGRAM_GROUP_ID' && !chatId) chatId = m[2];
      }
    } catch { /* no env file on this host; telegram stays unconfigured */ }
  }
  return { token: token || null, chatId: chatId || null };
}

function isTelegramConfigured() {
  const { token, chatId } = resolveTelegramConfig();
  return Boolean(token && chatId);
}

/** POST sendMessage. Never throws — resolves { ok, status|error }. Timeout-bounded. */
function sendTelegram(message, { timeoutMs = TELEGRAM_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const { token, chatId } = resolveTelegramConfig();
    if (!token || !chatId) return resolve({ ok: false, error: 'telegram not configured' });
    const body = JSON.stringify({ chat_id: chatId, text: message });
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        done(ok ? { ok: true, status: res.statusCode } : { ok: false, status: res.statusCode, error: buf.slice(0, 200) });
      });
    });
    req.on('error', (err) => done({ ok: false, error: String(err && err.message).slice(0, 200) }));
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

/**
 * Send `message` through whichever out-of-band channel(s) are configured.
 * Never throws — every branch is timeout-bounded and caught. `senders` lets
 * tests inject fake transports/config checks instead of hitting the network.
 * Returns { ok:false, reason: 'no fallback channel configured' } when neither
 * channel resolves — AC2: that must be loud, not silent, at the call site.
 */
async function sendFallback(message, { title = 'daemon-sentinel', senders = {} } = {}) {
  const ntfyEnabled = senders.ntfyEnabled || ntfy.isEnabled;
  const telegramEnabled = senders.telegramEnabled || isTelegramConfigured;
  const sendNtfy = senders.sendNtfy || ((msg) => ntfy.notify({ title, message: msg, priority: 'urgent', tags: ['rotating_light', 'daemon-sentinel'] }));
  const sendTg = senders.sendTelegram || sendTelegram;

  const ntfyOn = Boolean(ntfyEnabled());
  const tgOn = Boolean(telegramEnabled());
  if (!ntfyOn && !tgOn) {
    return { ok: false, reason: 'no fallback channel configured' };
  }

  const results = [];
  if (ntfyOn) {
    try {
      const ok = await sendNtfy(message);
      results.push({ channel: 'ntfy', ok: Boolean(ok) });
    } catch (err) {
      results.push({ channel: 'ntfy', ok: false, error: String(err && err.message).slice(0, 200) });
    }
  }
  if (tgOn) {
    try {
      const r = await sendTg(message);
      results.push({ channel: 'telegram', ok: Boolean(r && r.ok), error: r && !r.ok ? (r.error || `http ${r.status}`) : undefined });
    } catch (err) {
      results.push({ channel: 'telegram', ok: false, error: String(err && err.message).slice(0, 200) });
    }
  }

  const channel = results.map((r) => r.channel).join(',');
  const ok = results.some((r) => r.ok);
  const errorParts = results.filter((r) => !r.ok).map((r) => `${r.channel}:${r.error || 'failed'}`);
  return { channel, ok, ...(errorParts.length ? { error: errorParts.join('; ') } : {}) };
}

module.exports = { sendFallback, isTelegramConfigured, resolveTelegramConfig, sendTelegram };
