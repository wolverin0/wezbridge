#!/usr/bin/env node
'use strict';

/**
 * daemon-heartbeat-sentinel.cjs — EXTERNAL watchdog for the :4200 daemon (T-0186).
 *
 * Covers: standalone daemon-death detection via heartbeat file + /api/health,
 * poke delivery to the orchestrator pane, episode cooldown, own heartbeat.
 * Key terms: sentinel, DAEMON DOWN, DAEMON WEDGED, _intel/evidence/wezbridge.
 * Read when: the daemon died and nobody was told, or the sentinel misfires.
 *
 * Why: on 2026-08-19 the daemon died at 07:19Z and the fleet learned of it 4.7h
 * later, by accident. Every in-daemon watcher dies with the daemon — this runs
 * from a Windows scheduled task (WezBridge-DaemonSentinel, every 5 min) and
 * depends on nothing the daemon owns. A monitor you have to query is a query;
 * this one speaks up on its own.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(REPO, '..', '_intel');
const EVIDENCE_DIR = path.join(INTEL, 'evidence', 'wezbridge');
const HEARTBEAT_FILE = path.join(INTEL, '.daemon-heartbeat.json');
const STATE_FILE = path.join(EVIDENCE_DIR, 'daemon-sentinel-state.json');
const OWN_BEAT_FILE = path.join(EVIDENCE_DIR, 'daemon-sentinel-heartbeat.json');
const LOG_FILE = path.join(EVIDENCE_DIR, 'daemon-sentinel.jsonl');

// T-0529: producer for the VM dead-man switch. Every in-daemon watcher dies
// with the daemon (see file header) — but so does THIS sentinel if the whole
// Windows box goes dark. Touching a heartbeat on a separate machine (the
// ubuntu VM) on every genuinely-up run gives ~/bin/omni-deadman.sh (VM cron)
// an out-of-band signal that covers "the daemon died" AND "the sentinel
// itself stopped running" — neither of which can page from this host alone.
const DEADMAN_TOUCH_FILE = path.join(EVIDENCE_DIR, 'deadman-touch.json');
const DEADMAN_SSH_KEY = process.env.WEZBRIDGE_DEADMAN_SSH_KEY || 'C:/Users/pauol/.ssh/ubuntuvm_key';
const DEADMAN_HOST = process.env.WEZBRIDGE_DEADMAN_HOST || 'ggorbalan@192.168.100.186';
const DEADMAN_TOUCH_TIMEOUT_MS = 8_000;

// Re-poke cadence while an episode stays open. One poke per episode start,
// then a reminder every 30 min — an alert repeated every 5 min trains the
// orchestrator to ignore it (same lesson as T-0176/T-0190).
const REPOKE_MS = 30 * 60_000;

// T-0220: a failed probe against a FRESH heartbeat is contention, not death
// (assessLiveness no longer calls it DOWN). But a dead HTTP listener with live
// timers would look identical forever — so the sentinel escalates only if the
// signal PERSISTS this many consecutive runs (runs are 5 min apart: 3 = ~15 min
// of sustained unreachability, which no contention spike of 2026-08-23 survived).
const HTTP_FAIL_STREAK_ALERT = 3;
// A watchdog's probe timeout must exceed its dependency's p99 under load —
// measured 6-15s for /api/health during the 2026-08-23 paging storm.
const SENTINEL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Pure decision: what to do this run. No I/O — fully testable.
 * The test that MUST keep failing if this breaks: a dead daemon (no HTTP,
 * stale beat) with a virgin state returns { alert: true } — acceptance
 * criterion 3 of T-0186.
 */
function evaluate({ liveness, state, now = Date.now(), repokeMs = REPOKE_MS, httpFailStreakAlert = HTTP_FAIL_STREAK_ALERT }) {
  const downAlert = (liveness.alerts || []).find((a) => /^DAEMON (DOWN|WEDGED)/.test(a));
  if (!downAlert && liveness.probeFailedFreshBeat) {
    // Probe failed but the daemon is writing heartbeats. Count, don't cry —
    // yet. Sustained streaks mean the HTTP listener is genuinely gone.
    const streak = ((state && state.httpFailStreak) || 0) + 1;
    if (streak < httpFailStreakAlert) {
      return {
        verdict: 'suspect',
        alert: false,
        recovered: false,
        newState: { ...(state || {}), httpFailStreak: streak },
      };
    }
    const episodeStartedAt = (state && state.episodeStartedAt) || new Date(now).toISOString();
    const lastAlertAt = state && state.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
    const shouldPoke = now - lastAlertAt >= repokeMs;
    return {
      verdict: 'http-unresponsive',
      alert: shouldPoke,
      message: `DAEMON HTTP UNRESPONSIVE — /api/health has failed ${streak} consecutive sentinel runs while the heartbeat stays fresh. Timers live, HTTP dead (or sustained machine contention). Do NOT blind-restart: check RAM/paging first (mm-72c9), then the daemon's HTTP listener.`,
      newState: {
        episodeStartedAt,
        httpFailStreak: streak,
        lastAlertAt: shouldPoke ? new Date(now).toISOString() : (state && state.lastAlertAt) || null,
      },
    };
  }
  if (!downAlert) {
    const wasDown = Boolean(state && state.episodeStartedAt);
    return {
      verdict: 'healthy',
      alert: false,
      recovered: wasDown,
      newState: {}, // episode closed, streaks reset
    };
  }
  const episodeStartedAt = (state && state.episodeStartedAt) || new Date(now).toISOString();
  const lastAlertAt = state && state.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
  const shouldPoke = now - lastAlertAt >= repokeMs;
  return {
    verdict: /WEDGED/.test(downAlert) ? 'wedged' : 'down',
    alert: shouldPoke,
    message: downAlert,
    newState: {
      episodeStartedAt,
      lastAlertAt: shouldPoke ? new Date(now).toISOString() : (state && state.lastAlertAt) || null,
    },
  };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 1)}\n`);
  fs.renameSync(tmp, p);
}

function logLine(obj) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(obj)}\n`);
  } catch { /* evidence must never crash the sentinel */ }
}

/** Find the orchestrator pane (Claude session whose project basename is the repo). LEGACY WezTerm path only. */
async function findOrchestratorPane() {
  const discovery = require(path.join(REPO, 'src', 'pane-discovery.cjs'));
  const repo = (process.env.WEZBRIDGE_ORCH_REPO || 'wezbridge').toLowerCase();
  const panes = await discovery.discoverPanes();
  const hit = panes.find((p) => p.isClaude
    && String(p.project || '').toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean).pop() === repo);
  return hit ? hit.paneId ?? hit.pane_id : null;
}

/**
 * T-0599 fixup: the WezTerm-only poke was itself the finding — the fleet
 * lives in Orca (T-0596) and nobody has a live WezTerm pane to receive
 * sendPromptDeferredEnter anymore. Same pattern as decision-relay.cjs's
 * attemptSendOrca: resolve the orchestrator's live Orca terminal by
 * project/lane (src/orca-target.cjs — NOT a stored pane id, which
 * renumbers), send + read-back verify (src/orca-send.cjs), self-send guard
 * via ORCA_TERMINAL_HANDLE (harmless here — this runs from Task Scheduler,
 * not a pane, so ORCA_TERMINAL_HANDLE is normally unset, but the guard costs
 * nothing and keeps parity with every other Orca sender). WezTerm stays
 * legacy behind WEZBRIDGE_WEZTERM_TRANSPORT=1, same flag as T-0596/T-0599.
 * Dedupe/cooldown/deadman semantics are untouched — they live in evaluate()
 * and main(), upstream of this function.
 */
async function deliverPokeOrca(message, recheck, {
  resolveOrcaTargetFn = require(path.join(REPO, 'src', 'orca-target.cjs')).resolveOrcaTarget,
  sendToOrcaTerminalFn = require(path.join(REPO, 'src', 'orca-send.cjs')).sendToOrcaTerminal,
} = {}) {
  const repo = (process.env.WEZBRIDGE_ORCH_REPO || 'wezbridge').toLowerCase();
  const orcaHit = await resolveOrcaTargetFn(repo);
  if (!orcaHit.handle || orcaHit.ambiguous.length) {
    return { delivered: false, reason: orcaHit.ambiguous.length ? 'ambiguous-pane' : 'no orchestrator pane found' };
  }
  if (process.env.ORCA_TERMINAL_HANDLE && orcaHit.handle === process.env.ORCA_TERMINAL_HANDLE) {
    // Same guard a2a_send and decision-relay.cjs apply: never deliver to self.
    return { delivered: false, handle: orcaHit.handle, reason: 'self-send' };
  }
  const currentMessage = recheck ? recheck() : message;
  if (!currentMessage) return { delivered: false, handle: orcaHit.handle, reason: 'daemon recovered before alert delivery' };
  const text = `[daemon-sentinel] ${currentMessage} Evidencia: _intel/evidence/wezbridge/daemon-sentinel.jsonl`;
  const sent = await sendToOrcaTerminalFn(orcaHit.handle, text);
  try {
    require(path.join(REPO, 'src', 'action-log.cjs')).logAction('sentinel_poke', {
      target: `orca:${orcaHit.handle}`, why: currentMessage.slice(0, 120), extra: { submitted: sent.submitted, delivered: sent.delivered },
    });
  } catch { /* attribution is best-effort, delivery already happened */ }
  if (sent.ok !== true) {
    return { delivered: false, handle: orcaHit.handle, submitted: sent.submitted, reason: sent.error || 'send-unverified' };
  }
  return { delivered: true, handle: orcaHit.handle, submitted: sent.submitted };
}

/** LEGACY WezTerm poke path, kept behind WEZBRIDGE_WEZTERM_TRANSPORT=1. */
async function deliverPokeWezTerm(message, recheck) {
  const verified = require(path.join(REPO, 'src', 'verified-send.cjs'));
  const paneId = await findOrchestratorPane();
  if (paneId === null || paneId === undefined) return { delivered: false, reason: 'no orchestrator pane found' };
  const currentMessage = recheck ? recheck() : message;
  if (!currentMessage) return { delivered: false, reason: 'daemon recovered before alert delivery' };
  // Two-phase send + read-back verification (verified-send.cjs): a raw
  // sendText('...\r') leaves the poke STUCK in the composer often enough that
  // drill #1 of this very card hit it. An alert that sits unsubmitted in an
  // input box is the daemon's silent death all over again, one layer up.
  const text = `[daemon-sentinel] ${currentMessage} Evidencia: _intel/evidence/wezbridge/daemon-sentinel.jsonl`;
  const sent = await verified.sendPromptDeferredEnter(paneId, text);
  // T-0323: composer con texto ajeno => la primitiva no escribio; no verificar
  // (reintentaria Enter sobre el texto del operador). El poke se reporta como
  // no entregado y el proximo tick lo reintenta.
  if (sent && sent.refused) return { delivered: false, paneId, reason: `${sent.refused}: ${String(sent.held).slice(0, 80)}` };
  const submitted = await verified.verifyPromptSubmission(paneId, text);
  try {
    require(path.join(REPO, 'src', 'action-log.cjs')).logAction('sentinel_poke', {
      target: `pane-${paneId}`, why: currentMessage.slice(0, 120), extra: { submitted },
    });
  } catch { /* attribution is best-effort, delivery already happened */ }
  return { delivered: true, paneId, submitted };
}

/**
 * Dispatch: Orca by default (fleet lives in Orca, T-0596/T-0599), WezTerm
 * only behind WEZBRIDGE_WEZTERM_TRANSPORT=1. `deps` is test-injection only
 * (resolveOrcaTargetFn/sendToOrcaTerminalFn) — main() never passes it.
 */
async function deliverPoke(message, recheck, deps) {
  if (process.env.WEZBRIDGE_WEZTERM_TRANSPORT === '1') return deliverPokeWezTerm(message, recheck);
  return deliverPokeOrca(message, recheck, deps);
}

/**
 * T-0526: deliver `message` via deliverPoke, and if that didn't land
 * (delivered !== true — no pane, refused, or thrown), fall back to
 * ntfy/Telegram in the SAME run so a missing orchestrator pane can no longer
 * swallow an alert silently (157 of 199 alerts since 2026-08-22 were lost
 * exactly this way — see file header). Dependencies are injectable so tests
 * exercise this without a pane, a network call, or a subprocess.
 */
async function deliverAlert(message, recheck, { deliverPokeFn = deliverPoke, sendFallbackFn } = {}) {
  let delivery;
  try {
    delivery = await deliverPokeFn(message, recheck);
  } catch (err) {
    delivery = { delivered: false, reason: String(err && err.message).slice(0, 200) };
  }
  let fallback = null;
  if (delivery.delivered !== true) {
    const sendFallback = sendFallbackFn || require(path.join(REPO, 'src', 'alert-fallback.cjs')).sendFallback;
    try {
      fallback = await sendFallback(message);
    } catch (err) {
      fallback = { ok: false, error: String(err && err.message).slice(0, 200) };
    }
  }
  return { delivery, fallback };
}

/**
 * T-0529: best-effort touch of the VM dead-man heartbeat. Bounded timeout,
 * never throws, never blocks the daemon-liveness verdict this file exists
 * for — a hung SSH must not turn into a missed poke.
 */
function touchVmHeartbeat() {
  return new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-i', DEADMAN_SSH_KEY,
      DEADMAN_HOST,
      'date -Is > ~/omniclaude.heartbeat',
    ];
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      const child = execFile('ssh', args, { timeout: DEADMAN_TOUCH_TIMEOUT_MS, windowsHide: true }, (err) => {
        done(err
          ? { ok: false, at: new Date().toISOString(), error: String(err.message || err).slice(0, 200) }
          : { ok: true, at: new Date().toISOString() });
      });
      child.on('error', (err) => done({ ok: false, at: new Date().toISOString(), error: String(err.message || err).slice(0, 200) }));
    } catch (err) {
      done({ ok: false, at: new Date().toISOString(), error: String(err && err.message).slice(0, 200) });
    }
  });
}

async function main() {
  // Independent of the SP plugin and checked before potentially slow daemon/pane probes.
  try {
    const sp = await require('./sp-bridge-heartbeat.cjs').checkSpHeartbeat();
    console.log(`sp-bridge-heartbeat: ${JSON.stringify(sp)}`);
  } catch { console.error('sp-bridge-heartbeat: check failed; inspect file access'); }
  const ds = require(path.join(REPO, 'src', 'daemon-status.cjs'));
  const { probeDaemon } = require(path.join(REPO, 'src', 'daemon-probe.cjs'));

  const initialHeartbeat = ds.readHeartbeat(HEARTBEAT_FILE); // forensic only; never the alert verdict
  const daemon = await probeDaemon({ timeoutMs: SENTINEL_PROBE_TIMEOUT_MS });
  const state = readJson(STATE_FILE) || {};
  // A slow probe or pane discovery may outlive the outage. Assess the latest
  // heartbeat after each wait, not the stale record read before it started.
  const observe = () => {
    const heartbeat = ds.readHeartbeat(HEARTBEAT_FILE);
    const liveness = ds.assessLiveness({ heartbeat, daemonReachable: daemon.up });
    return { heartbeat, liveness, decision: evaluate({ liveness, state }) };
  };
  let { heartbeat, liveness, decision } = observe();

  let delivery = null;
  let fallback = null;
  if (decision.alert) {
    ({ delivery, fallback } = await deliverAlert(decision.message, () => {
      ({ heartbeat, liveness, decision } = observe());
      return decision.alert ? decision.message : null;
    }));
    logLine({
      ts: new Date().toISOString(), verdict: decision.verdict, message: decision.message,
      heartbeat_ts: heartbeat && heartbeat.ts, daemon_up: daemon.up, delivery,
      ...(fallback ? { fallback } : {}),
    });
  }
  if (decision.recovered) {
    logLine({ ts: new Date().toISOString(), verdict: 'recovered', episode_started_at: state.episodeStartedAt });
  }
  const recoveredDuringCheck = initialHeartbeat?.ts && heartbeat?.ts && heartbeat.ts !== initialHeartbeat.ts
    && Date.now() - Date.parse(initialHeartbeat.ts) > ds.HEARTBEAT_STALE_MS
    && liveness.heartbeatAgeMs <= ds.HEARTBEAT_STALE_MS;
  if (recoveredDuringCheck) logLine({ ts: new Date().toISOString(), verdict: 'recovered-before-alert',
    prior_heartbeat_ts: initialHeartbeat.ts, heartbeat_ts: heartbeat.ts });

  // T-0529: only touch the VM dead-man heartbeat when the daemon is actually
  // up. Skipping on down/wedged/suspect means the VM switch also alerts on
  // "daemon down" as an independent, out-of-band channel — see file header.
  let deadmanTouch;
  if (daemon.up) {
    try {
      deadmanTouch = await touchVmHeartbeat();
    } catch (err) {
      deadmanTouch = { ok: false, at: new Date().toISOString(), error: String(err && err.message).slice(0, 200) };
    }
  } else {
    deadmanTouch = { ok: false, skipped: true, at: new Date().toISOString(), reason: 'daemon not up' };
  }
  try { writeJson(DEADMAN_TOUCH_FILE, deadmanTouch); } catch { /* evidence must never crash the sentinel */ }
  logLine({ ts: new Date().toISOString(), verdict: decision.verdict, daemon_up: daemon.up, deadman_touch: deadmanTouch });

  writeJson(STATE_FILE, decision.newState);
  // Own heartbeat EVERY run, healthy or not: silence from the sentinel must be
  // distinguishable from "all quiet" (F1 hardening rule 1).
  writeJson(OWN_BEAT_FILE, {
    ts: new Date().toISOString(), verdict: decision.verdict,
    alerted: decision.alert, daemon_up: daemon.up,
    heartbeat_age_ms: liveness.heartbeatAgeMs,
    recovered_during_check: Boolean(recoveredDuringCheck),
    deadman_touch: deadmanTouch,
  });

  const line = `daemon-sentinel: ${decision.verdict}${decision.alert ? ` — poked (${JSON.stringify(delivery)})${fallback ? ` fallback (${JSON.stringify(fallback)})` : ''}` : ''}`;
  console.log(line);
  // T-0526: both the primary poke AND the fallback failing is the exact
  // silent-loss defect this card exists to kill — that gets its own exit
  // code (3) so a scheduled-task failure history distinguishes "daemon is
  // down, alert delivered" (1) from "daemon is down, NOBODY WAS TOLD" (3).
  const bothChannelsFailed = decision.alert && delivery && delivery.delivered !== true && fallback && fallback.ok !== true;
  process.exitCode = bothChannelsFailed ? 3 : (decision.verdict === 'healthy' ? 0 : 1);
}

if (require.main === module) {
  process.env.WEZBRIDGE_ACTOR = process.env.WEZBRIDGE_ACTOR || 'daemon-sentinel';
  main().catch((err) => {
    // The sentinel failing is itself a signal — leave it in its own heartbeat.
    try {
      writeJson(OWN_BEAT_FILE, { ts: new Date().toISOString(), verdict: 'sentinel-error', error: String(err && err.message).slice(0, 300) });
    } catch { /* nothing left to report to */ }
    console.error(`daemon-sentinel error: ${err && err.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  evaluate, deliverAlert, deliverPoke, deliverPokeOrca, deliverPokeWezTerm, findOrchestratorPane,
  touchVmHeartbeat, REPOKE_MS, HTTP_FAIL_STREAK_ALERT, SENTINEL_PROBE_TIMEOUT_MS,
};
