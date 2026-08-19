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
  // Repos live beside _intel (<root>/_intel/pane-events.jsonl -> <root>/<repo>).
  if (!cfg.reposRoot && cfg.eventsPath) {
    cfg.reposRoot = path.dirname(path.dirname(cfg.eventsPath));
  }
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
    resultsSeen: path.join(stateDir, 'results-seen.json'),
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
    resultsSeen: readJson(FILES.resultsSeen, {}), // repo -> true once its results dir has been seeded
    lastTickAt: null, // ISO — proves the loop is running, not merely constructed
    lastPokeAt: null, // ISO — proves delivery, not merely ticking
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

  // ── 1b. results-file trigger: a completion signal that needs NO hook ──────
  //
  // The beacon path requires the agent's harness to fire a Stop hook. Codex
  // panes do not reliably do that — confirmed on mutual 2026-08-06: the beacon
  // hook is registered for codex and works standalone (exit 0, correct repo),
  // yet no beacon has been emitted since 2026-07-31 while the pane worked all
  // day. That is the `codex-pane: DEFERRED — no completion signal` entry in the
  // registry, and it locked every non-Claude pane out of the loop.
  //
  // A results FILE is the contract already: harvest-by-file is how the
  // orchestrator reads outcomes, and no node is complete without one. So watch
  // for it directly. This is strictly better than the beacon for the thing we
  // actually care about — a beacon says "a turn ended", which is usually noise;
  // a new results file says "a NODE COMPLETED", which is always actionable.
  //
  // Mtime is deliberately NOT the key: clock skew and touch-like rewrites make
  // it unreliable. The key is (path + size + mtime) hashed into an intent id, so
  // a genuinely rewritten result re-fires and an unchanged one never does.
  function scanResults() {
    if (!cfg.reposRoot) return 0;
    let added = 0;
    for (const repo of cfg.watchRepos) {
      const dir = path.join(cfg.reposRoot, repo, '.orchestrator', 'results');
      let names;
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      } catch {
        // No results dir YET. Seed the repo as seen with an EMPTY history so the
        // first file it ever writes counts as NEW. Without this, a greenfield
        // repo's very first node completion is swallowed by the seeding branch
        // below as if it were pre-existing history — the silent-swallow class
        // this loop exists to prevent, and it would have eaten mutual's first
        // result (caught 2026-08-06, before it could bite).
        if (!state.resultsSeen[repo]) {
          state.resultsSeen[repo] = true;
          atomicWriteJson(FILES.resultsSeen, state.resultsSeen);
        }
        continue;
      }
      for (const name of names) {
        let st;
        try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
        const id = crypto.createHash('sha1')
          .update(`result|${repo}|${name}|${st.size}|${Math.floor(st.mtimeMs)}`)
          .digest('hex').slice(0, 16);
        if (deliveredSet.has(id) || state.pending[id]) continue;
        // First sight of a repo's results dir must not replay its whole history:
        // seed silently, exactly like the events cursor starts at end-of-file.
        if (!state.resultsSeen[repo]) continue;
        state.pending[id] = {
          repo, event: 'result-file', time: new Date(st.mtimeMs).toISOString(),
          node: name.replace(/\.json$/, ''), attempts: 0,
        };
        added += 1;
      }
      if (!state.resultsSeen[repo]) {
        state.resultsSeen[repo] = true;
        atomicWriteJson(FILES.resultsSeen, state.resultsSeen);
        for (const name of names) {
          try {
            const st = fs.statSync(path.join(dir, name));
            deliveredSet.add(crypto.createHash('sha1')
              .update(`result|${repo}|${name}|${st.size}|${Math.floor(st.mtimeMs)}`)
              .digest('hex').slice(0, 16));
          } catch { /* vanished mid-scan */ }
        }
        persistDelivered();
      }
    }
    if (added) {
      persistPending();
      log(`orch-waker: ${added} new RESULTS-FILE intent(s), ${Object.keys(state.pending).length} pending`);
    }
    return added;
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

  // A node that can still run keeps the graph open. A missing or fully
  // terminal graph means the pane's turn-ends are ordinary work, not node
  // completions — and the poke must not pretend otherwise. Absent `state` counts
  // as open: a freshly authored graph has run nothing yet.
  const TERMINAL_NODE_STATES = new Set(['done', 'failed', 'cancelled', 'skipped']);
  function openGraph(repo) {
    if (cfg.hasOpenGraph) return cfg.hasOpenGraph(repo);
    // EVERY graph file, not just graph.json. A repo accumulates them: brlite's
    // graph.json held the sealed graph-1 while the live milestone was authored
    // as graph-3.json, so reading one fixed name would have reported "no open
    // graph" about a graph dispatched minutes earlier — the same lie this check
    // exists to prevent, merely pointing the other way.
    const dir = path.join(cfg.reposRoot, repo, '.orchestrator');
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => /^graph.*\.json$/i.test(f));
    } catch {
      return false; // no .orchestrator dir -> not a graph-driven repo
    }
    for (const f of files) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (g.graph_state === 'closed') continue; // explicitly sealed
        const nodes = g.nodes;
        if (!Array.isArray(nodes) || !nodes.length) continue;
        if (nodes.some((n) => !TERMINAL_NODE_STATES.has(n && n.state))) return true;
      } catch { /* unreadable graph file is not an open graph */ }
    }
    return false;
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
      //
      // Say what HAPPENED, not what to do about it. The old text always claimed
      // a graph was running and ordered a results harvest; on 2026-08-06 it fired
      // for operator-directed work against a graph that had been closed for
      // hours, pointing at four stale result files (audit hole 5). Asserting a
      // mode you have not checked is how a notification manufactures a fiction.
      const facts = `${group.length} ${kinds} event(s), latest ${newest}`;
      // A results FILE outranks a turn-end: it names a node that actually
      // completed, where a turn-end is usually mid-work noise. Lead with it.
      const nodes = [...new Set(group.map((id) => state.pending[id].node).filter(Boolean))];
      const text = nodes.length
        ? `[orch-waker] ${repo} RESULT FILE(S) written: ${nodes.join(', ')}. Harvest ${repo}/.orchestrator/results/ and advance — ${facts}.`
        : openGraph(repo)
          ? `[orch-waker] Harvest ${repo}/.orchestrator/results/ and advance the graph — ${facts}.`
          : `[orch-waker] ${repo} finished work — ${facts}. No open graph, so no node completed: check what the pane actually did.`;
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
        state.lastPokeAt = new Date(now()).toISOString();
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
    state.lastTickAt = new Date(now()).toISOString();
    ingestEvents();
    try { scanResults(); } catch (err) { log(`orch-waker: results scan failed: ${err.message}`); }
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

  // Live runtime facts for the health surface. MEASURED, never inferred: the
  // caller must be able to answer "is the loop actually consuming events?"
  // without reading logs. cursorLagBytes > 0 and growing means beacons are
  // being written and NOT read — the exact silent failure of 2026-08-06.
  function status() {
    let eventsBytes = 0;
    try { eventsBytes = fs.statSync(cfg.eventsPath).size; } catch { /* no file yet */ }
    // Age of the OLDEST undelivered intent, in minutes. This is the number that
    // makes the waker's consumer able to FAIL: a poke that sits undelivered is
    // invisible in a count ("pending: 3" looks like normal churn) but loud as an
    // age ("oldest pending: 94 min" is a stuck loop). The 2026-08-13 disarm
    // happened precisely because 55 intents accumulated with nothing measuring
    // how long they had been there.
    let pendingOldestMinutes = 0;
    for (const it of Object.values(state.pending)) {
      const t = Date.parse(it.time || '');
      if (!Number.isNaN(t)) {
        pendingOldestMinutes = Math.max(pendingOldestMinutes, Math.round((now() - t) / 60000));
      }
    }
    let flagged = 0;
    try { flagged = Object.keys(readJson(FILES.flags, {})).length; } catch { /* none */ }
    return {
      armed: true,
      repos: cfg.watchRepos,
      pending: Object.keys(state.pending).length,
      pendingOldestMinutes,
      flagged,
      lastTickAt: state.lastTickAt || null,
      lastPokeAt: state.lastPokeAt || null,
      cursorBytes: state.cursorBytes,
      eventsBytes,
      cursorLagBytes: Math.max(0, eventsBytes - state.cursorBytes),
    };
  }

  return { tick, startWatcher, status, _state: state, _files: FILES, _openGraph: openGraph };
}

/**
 * Where arming lives. Precedence: env override > durable config file > OFF.
 *
 * The env var alone was the whole bug on 2026-08-06: the waker ran fine for
 * hours, the daemon was restarted with the documented `npm run dashboard`, and
 * the arming vanished with the old shell — silently, because the old code just
 * fell through a bare `if`. A restart must not be able to disarm the loop, and
 * when it IS off the caller must be handed a reason to log.
 *
 * Returns { enabled, repos, source, reason } — reason is always populated.
 */
function resolveWakerConfig({ env = process.env, intelDir, readFile } = {}) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const parseRepos = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

  const envFlag = env.WEZBRIDGE_ORCH_WAKER;
  if (envFlag === '0') {
    return { enabled: false, repos: [], source: 'env', reason: 'WEZBRIDGE_ORCH_WAKER=0 (explicit off)' };
  }

  let file = null;
  if (intelDir) {
    try {
      file = JSON.parse(read(path.join(intelDir, 'orch-waker.json')));
    } catch { /* absent or unparseable -> treated as no config */ }
  }

  if (envFlag === '1') {
    const repos = parseRepos(env.WEZBRIDGE_ORCH_WAKER_REPOS)
      || [];
    const fromFile = Array.isArray(file && file.repos) ? file.repos : [];
    const chosen = repos.length ? repos : fromFile;
    if (!chosen.length) {
      return { enabled: false, repos: [], source: 'env', reason: 'WEZBRIDGE_ORCH_WAKER=1 but no repos configured (set WEZBRIDGE_ORCH_WAKER_REPOS or _intel/orch-waker.json)' };
    }
    return { enabled: true, repos: chosen, source: 'env', reason: `armed by WEZBRIDGE_ORCH_WAKER=1 (repos: ${chosen.join(',')})` };
  }

  if (file && file.enabled === true) {
    const repos = Array.isArray(file.repos) ? file.repos.filter(Boolean) : [];
    if (!repos.length) {
      return { enabled: false, repos: [], source: 'file', reason: '_intel/orch-waker.json has enabled:true but an empty repos list' };
    }
    return { enabled: true, repos, source: 'file', reason: `armed by _intel/orch-waker.json (repos: ${repos.join(',')})` };
  }

  // A DELIBERATE disarm is not a fault, and conflating the two is expensive in
  // one specific direction: bridge_health raises an alert and pins ok:false
  // forever over a decision someone made on purpose, which trains every reader
  // to ignore its alerts. The config carries its own decision record — a
  // `_disarmed_*` key holding why it was turned off and what would justify
  // re-arming — so read it instead of inferring a problem from `enabled:false`.
  const disarmKey = file
    ? Object.keys(file).find((k) => k.startsWith('_disarmed'))
    : null;
  if (disarmKey) {
    return {
      enabled: false,
      repos: Array.isArray(file.repos) ? file.repos.filter(Boolean) : [],
      source: 'file',
      deliberate: true,
      decidedAt: disarmKey.replace(/^_disarmed_?/, '').replace(/_/g, '-') || null,
      decision: String(file[disarmKey]),
      reason: 'disarmed ON PURPOSE — see the decision record in _intel/orch-waker.json',
    };
  }

  return {
    enabled: false,
    repos: [],
    source: 'default',
    deliberate: false,
    reason: file
      ? '_intel/orch-waker.json present but enabled is not true, and it carries NO decision record explaining why'
      : 'not armed — no WEZBRIDGE_ORCH_WAKER=1 and no _intel/orch-waker.json',
  };
}

module.exports = { createWaker, intentId, DEFAULTS, resolveWakerConfig };
