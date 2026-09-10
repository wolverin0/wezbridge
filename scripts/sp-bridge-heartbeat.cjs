#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { gatewaySenderFromEnv } = require('../src/events-gateway.cjs');

const STALE_MS = 15 * 60000;
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '../..', '_intel');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function heartbeatStatus(beat, now) {
  const stamp = typeof beat?.ts === 'string' ? Date.parse(beat.ts) : NaN;
  const valid = Number.isFinite(stamp) && stamp <= now;
  const ageMs = valid ? now - stamp : null;
  return { stale: !valid || ageMs > STALE_MS, age_ms: ageMs,
    last_success_at: valid ? beat.ts : null, reason: valid ? 'age' : 'missing-or-invalid-heartbeat' };
}
function heartbeatSender(env = process.env, file = path.join(__dirname, '../.env.local')) {
  let local = {};
  try { local = parseEnv(fs.readFileSync(file, 'utf8')); } catch { /* unconfigured is reported, never a Telegram fallback */ }
  const config = { ...local, ...env };
  return gatewaySenderFromEnv(config, { boardToken: null,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }) });
}
function alertTask(event, episode) {
  return { id: `sp-bridge.stale:${episode}`, repo: 'wezbridge', state: 'attention',
    title: 'SP bridge sin sincronizacion reciente',
    blocker: `Revisar el plugin SP y su tarea programada. Ultimo exito: ${event.last_success_at || 'ausente o invalido'}. `
      + `Umbral: 15 minutos. Evidencia: _intel/events.jsonl, sp-bridge.stale. No se reinicio ni cambio nada.` };
}

async function checkSpHeartbeat({ intelDir = INTEL, now = Date.now(), send = heartbeatSender() } = {}) {
  const dir = path.join(intelDir, '.sp-bridge');
  const stateFile = path.join(dir, 'heartbeat-state.json');
  const status = heartbeatStatus(readJson(path.join(dir, 'last-success.json')), now);
  const prior = readJson(stateFile) || {};
  const observation = { checked_at: new Date(now).toISOString(), ...status };
  if (!status.stale) { writeJson(stateFile, observation); return { ...status, notified: false }; }
  const time = new Date(now).toISOString();
  const episode = prior.episode || time;
  const event = { time, event: 'sp-bridge.stale', source: 'sp-bridge-heartbeat', severity: 'P1',
    threshold_ms: STALE_MS, episode, ...status };
  fs.mkdirSync(dir, { recursive: true });
  if (!prior.episode) fs.appendFileSync(path.join(intelDir, 'events.jsonl'), JSON.stringify(event) + '\n');
  writeJson(stateFile, { ...prior, ...observation, episode });
  if (prior.notified) return { ...status, episode, notified: true, duplicate: true };
  let delivery = { ok: false, reason: 'gateway-unconfigured' };
  if (send) {
    try {
      const result = await send('', alertTask(event, episode));
      delivery = { ok: result?.ok === true, status: result?.status || null,
        reason: result?.ok ? 'gateway-accepted-not-feed-verified' : 'gateway-delivery-failed' };
    } catch { delivery = { ok: false, reason: 'gateway-delivery-failed' }; }
  }
  fs.appendFileSync(path.join(intelDir, 'events.jsonl'), JSON.stringify({ time, event: 'sp-bridge.stale_delivery', episode, ...delivery }) + '\n');
  writeJson(stateFile, { ...observation, episode, notified: delivery.ok, last_attempt_at: time, delivery });
  return { ...status, episode, notified: delivery.ok, delivery };
}

if (require.main === module) checkSpHeartbeat().then(result => {
  console.log(JSON.stringify(result)); process.exitCode = result.stale ? 1 : 0;
}).catch(() => { console.error('sp-bridge heartbeat check failed; inspect file access'); process.exitCode = 2; });
module.exports = { STALE_MS, heartbeatStatus, heartbeatSender, checkSpHeartbeat };
