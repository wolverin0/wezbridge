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

const REPO = path.join(__dirname, '..');
const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.join(REPO, '..', '_intel');
const EVIDENCE_DIR = path.join(INTEL, 'evidence', 'wezbridge');
const HEARTBEAT_FILE = path.join(INTEL, '.daemon-heartbeat.json');
const STATE_FILE = path.join(EVIDENCE_DIR, 'daemon-sentinel-state.json');
const OWN_BEAT_FILE = path.join(EVIDENCE_DIR, 'daemon-sentinel-heartbeat.json');
const LOG_FILE = path.join(EVIDENCE_DIR, 'daemon-sentinel.jsonl');

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

/** Find the orchestrator pane (Claude session whose project basename is the repo). */
async function findOrchestratorPane() {
  const discovery = require(path.join(REPO, 'src', 'pane-discovery.cjs'));
  const repo = (process.env.WEZBRIDGE_ORCH_REPO || 'wezbridge').toLowerCase();
  const panes = await discovery.discoverPanes();
  const hit = panes.find((p) => p.isClaude
    && String(p.project || '').toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean).pop() === repo);
  return hit ? hit.paneId ?? hit.pane_id : null;
}

async function deliverPoke(message) {
  const verified = require(path.join(REPO, 'src', 'verified-send.cjs'));
  const paneId = await findOrchestratorPane();
  if (paneId === null || paneId === undefined) return { delivered: false, reason: 'no orchestrator pane found' };
  // Two-phase send + read-back verification (verified-send.cjs): a raw
  // sendText('...\r') leaves the poke STUCK in the composer often enough that
  // drill #1 of this very card hit it. An alert that sits unsubmitted in an
  // input box is the daemon's silent death all over again, one layer up.
  const text = `[daemon-sentinel] ${message} Evidencia: _intel/evidence/wezbridge/daemon-sentinel.jsonl`;
  await verified.sendPromptDeferredEnter(paneId, text);
  const submitted = await verified.verifyPromptSubmission(paneId, text);
  try {
    require(path.join(REPO, 'src', 'action-log.cjs')).logAction('sentinel_poke', {
      target: `pane-${paneId}`, why: message.slice(0, 120), extra: { submitted },
    });
  } catch { /* attribution is best-effort, delivery already happened */ }
  return { delivered: true, paneId, submitted };
}

async function main() {
  const ds = require(path.join(REPO, 'src', 'daemon-status.cjs'));
  const { probeDaemon } = require(path.join(REPO, 'src', 'daemon-probe.cjs'));

  const heartbeat = ds.readHeartbeat(HEARTBEAT_FILE);
  const daemon = await probeDaemon({ timeoutMs: SENTINEL_PROBE_TIMEOUT_MS });
  const liveness = ds.assessLiveness({ heartbeat, daemonReachable: daemon.up });
  const state = readJson(STATE_FILE) || {};
  const decision = evaluate({ liveness, state });

  let delivery = null;
  if (decision.alert) {
    try {
      delivery = await deliverPoke(decision.message);
    } catch (err) {
      delivery = { delivered: false, reason: String(err && err.message).slice(0, 200) };
    }
    logLine({
      ts: new Date().toISOString(), verdict: decision.verdict, message: decision.message,
      heartbeat_ts: heartbeat && heartbeat.ts, daemon_up: daemon.up, delivery,
    });
  }
  if (decision.recovered) {
    logLine({ ts: new Date().toISOString(), verdict: 'recovered', episode_started_at: state.episodeStartedAt });
  }

  writeJson(STATE_FILE, decision.newState);
  // Own heartbeat EVERY run, healthy or not: silence from the sentinel must be
  // distinguishable from "all quiet" (F1 hardening rule 1).
  writeJson(OWN_BEAT_FILE, {
    ts: new Date().toISOString(), verdict: decision.verdict,
    alerted: decision.alert, daemon_up: daemon.up,
    heartbeat_age_ms: liveness.heartbeatAgeMs,
  });

  const line = `daemon-sentinel: ${decision.verdict}${decision.alert ? ` — poked (${JSON.stringify(delivery)})` : ''}`;
  console.log(line);
  process.exitCode = decision.verdict === 'healthy' ? 0 : 1;
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

module.exports = { evaluate, REPOKE_MS, HTTP_FAIL_STREAK_ALERT, SENTINEL_PROBE_TIMEOUT_MS };
