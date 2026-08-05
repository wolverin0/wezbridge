'use strict';
/**
 * orchestrator-waker.cjs — daemon-side "poke pane-0 when a watched repo's pane
 * finishes a turn". The operator's design point, verbatim from the 2026-08-05
 * postmortem review: an in-session Monitor dies silently with the session, so
 * the watcher must live OUT HERE and wake the orchestrator the same way the
 * orchestrator wakes worker panes — by typing into its pane, verified.
 *
 * Composition of three proven patterns, gaps closed:
 *   - tail a durable JSONL from a byte cursor        (clawtrol-bridge readDelta)
 *   - intent queue, dedupe by id, atomic state,
 *     mark delivered ONLY after verified success     (clawtrol-bridge, + verification
 *                                                     it lacked — its blind send counted
 *                                                     a stuck composer as delivered)
 *   - idle gate with consecutive-tick settle         (pane-handlers SETTLE_REQUIRED)
 *   - attempt cap + cooldown + flag-and-stop         (pane0-watchdog discipline)
 *
 * Pilot scope: watches _intel/pane-events.jsonl (written by the live
 * pane-beacon.cjs Stop/Notification hook) for turn-end / permission-wait from
 * configured repos, coalesces pending intents per repo into ONE short poke,
 * and delivers it to the orchestrator pane only when that pane is idle.
 *
 * Armed by startBackgroundServices behind WEZBRIDGE_ORCH_WAKER=1 (default OFF).
 * Never spawns panes (pane0-watchdog owns absence), never touches worker panes.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  watchRepos: ['walksim'],
  targetProject: 'wezbridge',
  intervalMs: 60 * 1000,
  settleTicks: 2, // consecutive idle observations of the target before poking
  maxAttempts: 3, // per intent; cap reached -> flagged and dropped, never retried
  cooldownMs: 5 * 60 * 1000, // between poke attempts per repo
  deliveredKeep: 500, // delivered-id ring buffer size
};

function intentId(evt) {
  return crypto.createHash('sha1')
    .update(`${evt.repo}|${evt.session || ''}|${evt.time || ''}|${evt.event || ''}`)
    .digest('hex').slice(0, 16);
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function createWaker(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const {
    eventsPath, stateDir, discoverPanes, resolveTarget, send, log = () => {},
    now = () => Date.now(),
  } = cfg;
  if (!eventsPath || !stateDir || !discoverPanes || !send) {
    throw new Error('orchestrator-waker: eventsPath, stateDir, discoverPanes and send are required');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const FILES = {
    cursor: path.join(stateDir, 'cursor.json'),
    pending: path.join(stateDir, 'pending.json'),
    delivered: path.join(stateDir, 'delivered.json'),
    flags: path.join(stateDir, 'flags.json'),
  };

  // Durable state — sessions and daemon restarts are survivable because
  // everything below is re-read from disk at construction.
  // FRESH state (no cursor file) starts at END of the events file: the waker
  // signals new completions, it does not replay history. First armed live it
  // ingested 590 stale intents from the beacon backlog — this stops that.
  let savedCursor = readJson(FILES.cursor, null);
  if (!savedCursor) {
    let size = 0;
    try { size = fs.statSync(cfg.eventsPath).size; } catch { /* no file yet */ }
    savedCursor = { bytes: size, tail: null };
  }
  const state = {
    cursorBytes: savedCursor.bytes,
    // Fingerprint of the last consumed bytes: rotation/truncation to a file of
    // ANY size (even one >= the cursor) is detected by the tail no longer
    // matching, not just by the size shrinking.
    cursorTail: savedCursor.tail, // { len, hash } | null
    pending: readJson(FILES.pending, {}), // intent_id -> {repo, event, time, attempts}
    delivered: readJson(FILES.delivered, []), // ring of intent ids
    idleStreak: 0,
    lastAttemptAt: {}, // repo -> ms (in-memory: a restart re-attempting early is safe)
  };
  const deliveredSet = new Set(state.delivered);

  function persistPending() { atomicWriteJson(FILES.pending, state.pending); }
  function persistCursor() {
    atomicWriteJson(FILES.cursor, { bytes: state.cursorBytes, tail: state.cursorTail });
  }
  function persistDelivered() {
    state.delivered = state.delivered.slice(-cfg.deliveredKeep);
    atomicWriteJson(FILES.delivered, state.delivered);
  }
  function flagCapExhausted(id, intent) {
    const flags = readJson(FILES.flags, {});
    flags[id] = { ...intent, flagged_at: new Date(now()).toISOString(), reason: 'attempt cap reached — poke undeliverable, needs a human look' };
    atomicWriteJson(FILES.flags, flags);
  }

  // ── 1. ingest: new beacon lines since cursor -> pending intents ──────────
  function tailMatches(fd) {
    if (!state.cursorTail || state.cursorTail.len > state.cursorBytes) return true;
    const { len, hash } = state.cursorTail;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.cursorBytes - len);
    return crypto.createHash('sha1').update(buf).digest('hex') === hash;
  }

  function ingestEvents() {
    let stat;
    try { stat = fs.statSync(eventsPath); } catch { return; } // no beacon file yet
    if (stat.size < state.cursorBytes) { state.cursorBytes = 0; state.cursorTail = null; }
    const fd = fs.openSync(eventsPath, 'r');
    let chunk;
    try {
      // Truncate-and-rewrite to a size >= the cursor is invisible to a size
      // check alone — verify the bytes we already consumed are still there.
      if (state.cursorBytes > 0 && !tailMatches(fd)) {
        log('orch-waker: events file rotated (tail mismatch) — cursor reset');
        state.cursorBytes = 0;
        state.cursorTail = null;
      }
      if (stat.size === state.cursorBytes) return;
      const len = stat.size - state.cursorBytes;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, state.cursorBytes);
      chunk = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    // Only complete lines; an in-flight partial line stays for the next tick.
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return;
    const consumed = lastNewline + 1;
    let added = 0;
    for (const line of chunk.slice(0, consumed).split('\n')) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; } // corrupt line: skip, never crash
      if (!cfg.watchRepos.includes(evt.repo)) continue;
      if (!['turn-end', 'permission-wait'].includes(evt.event)) continue;
      const id = intentId(evt);
      if (deliveredSet.has(id) || state.pending[id]) continue;
      state.pending[id] = { repo: evt.repo, event: evt.event, time: evt.time, attempts: 0 };
      added += 1;
    }
    // Order matters: intents first, cursor second. A crash in between re-reads
    // the same lines next tick and the id-dedupe absorbs them — never loses one.
    if (added) persistPending();
    state.cursorBytes += consumed;
    const consumedBytes = Buffer.from(chunk.slice(0, consumed), 'utf8');
    const fpLen = Math.min(consumedBytes.length, 256);
    state.cursorTail = {
      len: fpLen,
      hash: crypto.createHash('sha1').update(consumedBytes.subarray(consumedBytes.length - fpLen)).digest('hex'),
    };
    persistCursor();
    if (added) log(`orch-waker: ${added} new intent(s), ${Object.keys(state.pending).length} pending`);
  }

  // ── 2. target: resolve orchestrator pane + idle settle ───────────────────
  function findTarget(panes) {
    if (resolveTarget) return resolveTarget(panes);
    // Default: pane-identity semantics over discoverPanes output.
    // Non-Claude panes are excluded FIRST: the daemon's own shell pane shares
    // the wezbridge cwd, and without this filter resolution is permanently
    // ambiguous (two hits) and the waker fails closed forever.
    const { resolve } = require('./pane-identity.cjs');
    const mapped = panes
      .filter((p) => p.isClaude !== false)
      .map((p) => ({
        pane_id: p.paneId ?? p.pane_id,
        cwd: p.project || p.cwd || null,
        tab_title: p.title || null,
      }));
    const hit = resolve(cfg.targetProject, mapped);
    if (hit.ambiguous.length) {
      log(`orch-waker: ${hit.warning} — not poking`);
      return null;
    }
    return hit.paneId;
  }

  // ── 3. deliver: one coalesced poke per repo, verified, capped ────────────
  async function deliverPending(panes) {
    const ids = Object.keys(state.pending);
    if (!ids.length) return;

    const targetId = findTarget(panes);
    if (targetId == null) { state.idleStreak = 0; return; }
    const target = panes.find((p) => (p.paneId ?? p.pane_id) === targetId);
    const status = target ? target.status : 'unknown';
    if (status !== 'idle') { state.idleStreak = 0; return; }
    state.idleStreak += 1;
    if (state.idleStreak < cfg.settleTicks) return;

    const byRepo = {};
    for (const id of ids) (byRepo[state.pending[id].repo] ||= []).push(id);

    for (const [repo, group] of Object.entries(byRepo)) {
      // undefined = never attempted — a first attempt is never cooldown-blocked
      const last = state.lastAttemptAt[repo];
      if (last !== undefined && now() - last < cfg.cooldownMs) continue;
      state.lastAttemptAt[repo] = now();
      const newest = group.map((id) => state.pending[id].time).sort().pop();
      const kinds = [...new Set(group.map((id) => state.pending[id].event))].join('+');
      // Payload-first single line: truncation eats the HEAD of long messages,
      // so the whole poke stays short and the command leads.
      const text = `[orch-waker] Harvest ${repo}/.orchestrator/results/ and advance the graph — ${group.length} ${kinds} event(s), latest ${newest}, intents ${group.map((g) => g.slice(0, 8)).join(',')}.`;
      let ok = false;
      try {
        const delivered = await send.sendPromptDeferredEnter(targetId, text);
        const submitted = await send.verifyPromptSubmission(targetId, text);
        ok = submitted !== 'stuck' && delivered !== 'truncated';
      } catch (err) {
        log(`orch-waker: poke send failed: ${err.message}`);
      }
      if (ok) {
        for (const id of group) {
          delete state.pending[id];
          deliveredSet.add(id);
          state.delivered.push(id);
        }
        persistPending(); persistDelivered();
        state.idleStreak = 0;
        log(`orch-waker: poked pane ${targetId} for ${repo} (${group.length} intent(s) delivered)`);
      } else {
        let capped = 0;
        for (const id of group) {
          const intent = state.pending[id];
          intent.attempts += 1;
          if (intent.attempts >= cfg.maxAttempts) {
            flagCapExhausted(id, intent);
            delete state.pending[id];
            capped += 1;
          }
        }
        persistPending();
        log(`orch-waker: poke NOT verified for ${repo}${capped ? ` — ${capped} intent(s) hit the cap and were FLAGGED` : ' — will retry after cooldown'}`);
      }
    }
  }

  async function tick() {
    ingestEvents();
    let panes = [];
    try { panes = discoverPanes() || []; } catch (err) {
      log(`orch-waker: discovery failed: ${err.message}`);
      return;
    }
    await deliverPending(panes);
  }

  // session-snapshot.cjs startWatcher shape: immediate first tick, unref'd
  // interval, per-tick try/catch so one bad tick never kills the loop.
  function startWatcher() {
    const safeTick = () => { tick().catch((err) => log(`orch-waker tick failed: ${err.message}`)); };
    const handle = setInterval(safeTick, cfg.intervalMs);
    if (handle && handle.unref) handle.unref();
    safeTick();
    return () => clearInterval(handle);
  }

  return { tick, startWatcher, _state: state, _files: FILES };
}

module.exports = { createWaker, intentId, DEFAULTS };
