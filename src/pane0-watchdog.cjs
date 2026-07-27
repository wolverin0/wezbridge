'use strict';
/**
 * pane0-watchdog.cjs — orchestrator (pane-0) supervision inside the daemon.
 *
 * Control-plane v1: makes the reasoning pane replaceable. Recovery fires ONLY
 * when BOTH conditions hold — the orchestrator's beacon heartbeat is stale or
 * absent, AND no matching orchestrator pane exists in wezterm. A stale beacon
 * with a live pane is a busy/idle session, not a death; a missing pane with a
 * fresh beacon is a race — neither triggers.
 *
 * Recovery: spawn a pane in the orchestrator cwd and send
 * `claude --continue --dangerously-skip-permissions` (context restored by the
 * orchestrator-autoload SessionStart hook; target <2 min). Guard rails:
 *   - 10-minute cooldown between recovery attempts (no respawn loop)
 *   - after 3 CONSECUTIVE failed recoveries: disable and surface unhealthy
 *   - a successful recovery (fresh beacon observed) resets the failure count
 *
 * Config: WEZBRIDGE_ORCH_CWD (default: this repo root), WEZBRIDGE_ORCH_REPO
 * (beacon repo name, default "wezbridge"), WEZBRIDGE_WATCHDOG=0 to disable.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHECK_MS = 30_000;
// Recovery timing (P1 gate: <2 min recovery): when the orchestrator pane is
// ABSENT, 90s of beacon silence is enough — two missed 30s observations.
// When a pane is PRESENT it is never recovered regardless of silence (busy or
// quiet is not dead); STALE_MS only marks the health surface as stale.
const ABSENT_STALE_MS = 90_000;
const STALE_MS = 15 * 60_000;      // health-surface staleness only
const COOLDOWN_MS = 10 * 60_000;   // min gap between recovery attempts
const MAX_FAILURES = 3;
const TAIL_BYTES = 128 * 1024;

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
}
function orchRepo() { return process.env.WEZBRIDGE_ORCH_REPO || 'wezbridge'; }
function orchCwd() { return process.env.WEZBRIDGE_ORCH_CWD || path.join(__dirname, '..'); }

const state = {
  running: false, timer: null,
  lastAttemptAt: 0, consecutiveFailures: 0, disabled: false,
  lastCheck: null, lastBeaconAt: null, recoveries: 0,
};

/** Timestamp (ms) of the newest beacon line for the orchestrator repo, or 0. */
function lastOrchBeaconMs({ now = Date.now() } = {}) {
  const p = path.join(intelDir(), 'pane-events.jsonl');
  let size;
  try { size = fs.statSync(p).size; } catch { return 0; }
  const start = Math.max(0, size - TAIL_BYTES);
  let text = '';
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } catch { return 0; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* noop */ } }
  const repo = orchRepo();
  let newest = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(`"repo":"${repo}"`)) continue;
    try {
      const t = Date.parse(JSON.parse(line).time);
      if (t > newest && t <= now + 60_000) newest = t;
    } catch { /* skip */ }
  }
  return newest;
}

/** True when a Claude pane whose project basename matches the orchestrator repo exists. */
async function orchestratorPaneExists() {
  try {
    const discovery = require('./pane-discovery.cjs');
    const panes = await discovery.discoverPanes();
    const repo = orchRepo().toLowerCase();
    return panes.some((p) => p.isClaude
      && String(p.project || '').toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean).pop() === repo);
  } catch { return true; } // discovery failure → assume alive (never respawn blind)
}

async function attemptRecovery(deps) {
  const wez = deps.wezterm || require('./wezterm.cjs');
  const pane = await wez.spawnPane({ cwd: orchCwd() });
  const paneId = typeof pane === 'object' ? pane.paneId ?? pane.pane_id ?? pane : pane;
  await deps.sleep(2500); // let the shell come up (crash-recover skill pacing)
  await wez.sendText(paneId, 'claude --continue --dangerously-skip-permissions\r');
  return paneId;
}

/**
 * One watchdog evaluation. Injectable deps for tests:
 *   {now, beaconMs, paneExists, recover, sleep}
 */
async function check(deps = {}) {
  const now = deps.now ?? Date.now();
  if (state.disabled || !state.running) return { action: 'disabled' };

  const beaconMs = deps.beaconMs ?? lastOrchBeaconMs({ now });
  state.lastBeaconAt = beaconMs ? new Date(beaconMs).toISOString() : null;
  state.lastCheck = new Date(now).toISOString();

  // Fresh heartbeat after an attempt = that recovery worked; reset strikes.
  if (beaconMs && beaconMs > state.lastAttemptAt && state.consecutiveFailures > 0) state.consecutiveFailures = 0;

  const paneUp = deps.paneExists !== undefined ? deps.paneExists : await orchestratorPaneExists();
  if (paneUp) {
    // A present pane is never recovered; report staleness on the health surface only.
    return { action: !beaconMs || now - beaconMs > STALE_MS ? 'stale-but-present' : 'healthy' };
  }
  // Pane ABSENT: recover after ABSENT_STALE_MS of beacon silence — the short
  // threshold is what makes <2 min recovery reachable (P1 gate).
  const silentFor = beaconMs ? now - beaconMs : Infinity;
  if (silentFor <= ABSENT_STALE_MS) return { action: 'absent-grace' }; // just closed/racing — wait out the grace window

  if (now - state.lastAttemptAt < COOLDOWN_MS) return { action: 'cooldown' };

  state.lastAttemptAt = now;
  try {
    const paneId = await (deps.recover || attemptRecovery)({ sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), wezterm: deps.wezterm });
    state.recoveries += 1;
    // Note: failure counting is beacon-based — if no fresh beacon arrives before
    // the next stale evaluation, the next attempt increments the strike below.
    state.consecutiveFailures += 1; // provisional strike; cleared by a fresh beacon
    if (state.consecutiveFailures >= MAX_FAILURES) {
      state.disabled = true;
      return { action: 'recovered-then-disabled', paneId };
    }
    return { action: 'recovered', paneId };
  } catch (e) {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= MAX_FAILURES) state.disabled = true;
    return { action: state.disabled ? 'failed-disabled' : 'failed', error: String(e && e.message).slice(0, 200) };
  }
}

function start() {
  if (process.env.WEZBRIDGE_WATCHDOG === '0') return false;
  if (state.running) return true;
  state.running = true;
  state.timer = setInterval(() => { check().catch(() => { /* fail-soft */ }); }, CHECK_MS);
  if (state.timer.unref) state.timer.unref();
  return true;
}

function stop() {
  state.running = false;
  clearInterval(state.timer);
}

function health() {
  return {
    running: state.running, disabled: state.disabled,
    unhealthy: state.disabled, consecutive_failures: state.consecutiveFailures,
    recoveries: state.recoveries, last_check: state.lastCheck,
    last_beacon: state.lastBeaconAt,
    last_attempt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
  };
}

/** Test-only: reset module state between cases. */
function _reset() {
  stop();
  Object.assign(state, {
    running: false, timer: null, lastAttemptAt: 0, consecutiveFailures: 0,
    disabled: false, lastCheck: null, lastBeaconAt: null, recoveries: 0,
  });
}

module.exports = { start, stop, check, health, lastOrchBeaconMs, orchestratorPaneExists, _reset, CHECK_MS, ABSENT_STALE_MS, STALE_MS, COOLDOWN_MS, MAX_FAILURES };
