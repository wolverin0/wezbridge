'use strict';

const daemonStatus = require('../daemon-status.cjs');

function createEventHandlers(ctx) {
  const {
    sendJson, sendError, parseBody, log, corsHeaders, path, fs, spawn, ipc,
    wez, discoverPanes, NOISE_EVENTS, a2aState, a2aEvict, a2aTouch,
    recordA2AFromRawEvent, sseClients, collectPanes, broadcastSSE,
    slugify, isoForFilename, SRC_DIR, a2aHeartbeat, sessionSnapshot,
    teamManifest, teamsRegistry, worktreeRegistry, safetyPolicy,
  } = ctx;

  async function handleGetA2APending(req, res) {
    try {
      a2aEvict();
      const corrs = Array.from(a2aState.values())
        .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      sendJson(res, 200, { corrs });
    } catch (err) { sendError(res, err); }
  }

  async function handlePostA2AHandoff(req, res) {
    try {
      const body = await parseBody(req);
      const source_pane = parseInt(body.source_pane, 10);
      const target_pane = parseInt(body.target_pane, 10);
      const instruction = typeof body.instruction === 'string' ? body.instruction : '';
      const context = typeof body.context === 'string' ? body.context
        : typeof body.summary === 'string' ? body.summary : '';
      if (!Number.isFinite(source_pane) || !Number.isFinite(target_pane)) {
        return sendJson(res, 400, { error: 'source_pane and target_pane must be integers' });
      }
      if (!instruction.trim()) {
        return sendJson(res, 400, { error: 'instruction is required' });
      }

      const panes = discoverPanes ? discoverPanes() : [];
      const srcPane = panes.find(p => (p.paneId ?? p.pane_id) === source_pane);
      const tgtPane = panes.find(p => (p.paneId ?? p.pane_id) === target_pane);
      if (!srcPane || !srcPane.isClaude) {
        return sendJson(res, 400, { error: `source pane ${source_pane} not found or not claude` });
      }
      if (!tgtPane || !tgtPane.isClaude) {
        return sendJson(res, 400, { error: `target pane ${target_pane} not found or not claude` });
      }

      const srcProjectName = srcPane.projectName
        || (srcPane.project ? srcPane.project.split(/[\\/]/).filter(Boolean).pop() : null)
        || 'unknown';
      const tgtProjectName = tgtPane.projectName
        || (tgtPane.project ? tgtPane.project.split(/[\\/]/).filter(Boolean).pop() : null)
        || 'unknown';

      const corrShort = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
      const corr = `handoff-${corrShort}`;
      const tsFile = isoForFilename();
      const suggestedFilename = `handoff-to-${slugify(tgtProjectName)}-${tsFile}-${corrShort}.md`;
      const suggestedPath = `handoffs/${suggestedFilename}`;

      const prompt = [
        `[Dashboard A2A Handoff Request]`,
        ``,
        `You are pane-${source_pane} (${srcProjectName}). A handoff has been requested FROM you TO pane-${target_pane} (${tgtProjectName}, cwd: ${tgtPane.project || 'unknown'}).`,
        ``,
        `Instruction for target: ${instruction}`,
        ...(context.trim() ? [``, `Additional context from the dashboard user:`, context.trim()] : []),
        ``,
        `## Do these steps in order`,
        ``,
        `1. **Author a handoff file** at \`${suggestedPath}\` (relative to YOUR current cwd). Include:`,
        `   - What you have been doing recently`,
        `   - Current state / work-in-progress`,
        `   - What the target needs to know to pick up or contribute`,
        `   - Any files / commits / context relevant to the instruction above`,
        `   - Use a fresh unique filename — NEVER overwrite an existing handoff file.`,
        ``,
        `2. **Contact pane-${target_pane} via wezbridge MCP** using this exact envelope (the A2A hard-rule is: send_prompt followed by send_key 'enter'):`,
        `   \`\`\``,
        `   [A2A from pane-${source_pane} to pane-${target_pane} | corr=${corr} | type=request]`,
        `   ${instruction}`,
        `   Full handoff context is in: ${srcProjectName}/${suggestedPath}`,
        `   \`\`\``,
        `   Call: \`mcp__wezbridge__send_prompt(pane_id=${target_pane}, text=<envelope above>)\` then \`mcp__wezbridge__send_key(pane_id=${target_pane}, key='enter')\`.`,
        ``,
        `3. **Briefly acknowledge here** that the file was written + the target was contacted, with the filename and corr id.`,
        ``,
        `Do not do the target's work yourself. Your job is only to author the handoff file and delegate via MCP.`,
      ].join('\n');

      try {
        wez.sendText(source_pane, prompt);
        wez.sendTextNoEnter(source_pane, '\r');
      } catch (e) {
        return sendJson(res, 500, { error: `failed to send prompt to source pane: ${e.message}` });
      }

      const now = Date.now();
      a2aTouch(corr, { from: source_pane, to: target_pane, status: 'active', firstSeen: now, lastSeen: now });

      sendJson(res, 200, {
        ok: true,
        corr,
        source_pane,
        target_pane,
        suggested_file: suggestedPath,
        note: 'Instruction prompt sent to source pane. Source pane will author handoff file + contact target via wezbridge MCP.',
      });
    } catch (err) {
      log(`POST /api/a2a/handoff error: ${err.message}`);
      sendError(res, err);
    }
  }

  function translateWatcherEvent(raw) {
    if (!raw || !raw.event || NOISE_EVENTS.has(raw.event)) return null;
    const typeMap = {
      session_started: 'started',
      session_started_working: 'started',
      session_completed: 'completed',
      session_permission: 'permission',
      session_stuck: 'status_change',
      session_dead: 'removed',
      session_removed: 'removed',
      peer_orphaned: 'permission',
    };
    const type = typeMap[raw.event] || raw.event;
    const out = {
      ...raw,
      type,
      timestamp: raw.ts || new Date().toISOString(),
      pane_id: raw.pane ?? raw.pane_id ?? null,
      project: raw.project || null,
    };
    if (['started', 'completed', 'permission'].includes(type) && out.pane_id != null) {
      try {
        const full = wez.getFullText(out.pane_id, 40) || '';
        const clean = full.split('\n').filter(l => l.trim()).slice(-15).join('\n');
        if (clean) out.output = clean;
      } catch { /* pane may have disappeared */ }
    }
    if (!out.output && raw.details) out.output = String(raw.details);
    if (type === 'status_change') {
      out.from = raw.from || 'working';
      out.to = raw.to || (raw.event === 'session_stuck' ? 'stuck' : 'unknown');
    }
    return out;
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(res),
    });
    const helloTs = new Date().toISOString();
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: helloTs, timestamp: helloTs })}\n\n`);
    sseClients.add(res);

    // omni-watcher.cjs was removed in the v3.x rollback but these call sites survived it.
    // Spawning a missing module made EVERY SSE connection fail instantly: the child exited
    // with MODULE_NOT_FOUND, the exit handler below closed the stream, and each subscriber
    // got only `hello` + `watcher_exit` before being disconnected — so a2a_silent and every
    // other pushed event was undeliverable, while each poll leaked a doomed process.
    // Found 2026-08-03 after the daemon died and a 60s liveness poll had been spawning one
    // failing child per connection for ~12h. Absent watcher now degrades to a plain SSE
    // stream instead of taking the connection (and eventually the daemon) down with it.
    const watcherPath = path.join(SRC_DIR, 'omni-watcher.cjs');
    if (!fs.existsSync(watcherPath)) {
      if (!handleEvents._warnedMissingWatcher) {
        handleEvents._warnedMissingWatcher = true;
        log(`omni-watcher.cjs absent at ${watcherPath} — serving SSE without the watcher child`);
      }
      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    const child = spawn(process.execPath, [watcherPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WATCHER_POLL_MS: process.env.WATCHER_POLL_MS || '30000' },
    });

    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { continue; }
        try { recordA2AFromRawEvent(raw); } catch (e) { log(`a2a record error: ${e.message}`); }
        const translated = translateWatcherEvent(raw);
        if (!translated) continue;
        res.write(`data: ${JSON.stringify(translated)}\n\n`);
      }
    });
    child.stderr.on('data', chunk => log(`watcher stderr: ${chunk.toString('utf8').trim()}`));
    child.on('exit', code => {
      res.write(`event: watcher_exit\ndata: ${JSON.stringify({ code, timestamp: new Date().toISOString() })}\n\n`);
      sseClients.delete(res);
      res.end();
    });

    req.on('close', () => {
      sseClients.delete(res);
      child.kill();
    });
  }

  const HANDOFF_HEADER_RE_SOURCE = /#\s*Handoff\s+from\s+([^(]+?)\s*\(pane-(\d+)\)/i;
  const HANDOFF_HEADER_RE_TARGET = /→\s*([^(]+?)\s*\(pane-(\d+)\)/;
  const HANDOFF_SENT_RE = /\*\*Sent\*\*\s*:\s*(\S+)/i;
  const HANDOFF_CORR_RE = /\*\*Corr\*\*\s*:\s*(\S+)/i;

  function parseHandoffHeader(text) {
    const head = String(text || '').split(/\r?\n/).slice(0, 25).join('\n');
    const src = head.match(HANDOFF_HEADER_RE_SOURCE);
    const tgt = head.match(HANDOFF_HEADER_RE_TARGET);
    const sent = head.match(HANDOFF_SENT_RE);
    const corr = head.match(HANDOFF_CORR_RE);
    return {
      source_project: src ? src[1].trim() : null,
      source_pane: src ? parseInt(src[2], 10) : null,
      target_project: tgt ? tgt[1].trim() : null,
      target_pane: tgt ? parseInt(tgt[2], 10) : null,
      timestamp: sent ? sent[1].trim() : null,
      corr: corr ? corr[1].trim() : null,
    };
  }

  async function handleGetHandoffs(req, res, paneIdRaw) {
    try {
      const paneId = parseInt(paneIdRaw, 10);
      if (!Number.isFinite(paneId)) {
        return sendJson(res, 400, { error: 'pane query param required (integer)' });
      }
      const panes = discoverPanes ? discoverPanes() : [];
      const pane = panes.find(p => (p.paneId ?? p.pane_id) === paneId);
      if (!pane || !pane.project) {
        return sendJson(res, 200, { handoffs: [], note: `pane ${paneId} has no known cwd` });
      }
      const handoffsDir = path.join(pane.project, 'handoffs');
      if (!fs.existsSync(handoffsDir) || !fs.statSync(handoffsDir).isDirectory()) {
        return sendJson(res, 200, { handoffs: [], note: `no handoffs/ dir at ${handoffsDir}` });
      }
      const entries = fs.readdirSync(handoffsDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'));

      const handoffs = [];
      for (const e of entries) {
        const filepath = path.join(handoffsDir, e.name);
        let head = '';
        try {
          const fd = fs.openSync(filepath, 'r');
          try {
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.slice(0, n).toString('utf8');
          } finally { fs.closeSync(fd); }
        } catch { continue; }

        const meta = parseHandoffHeader(head);
        let mtime = null;
        try { mtime = fs.statSync(filepath).mtime.toISOString(); } catch { /* ignore */ }
        handoffs.push({
          filename: e.name,
          filepath,
          source_pane: meta.source_pane,
          source_project: meta.source_project,
          target_pane: meta.target_pane,
          target_project: meta.target_project,
          timestamp: meta.timestamp || mtime,
          corr: meta.corr,
        });
      }
      handoffs.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      sendJson(res, 200, { handoffs });
    } catch (err) {
      log(`GET /api/handoffs error: ${err.message}`);
      sendError(res, err);
    }
  }

  const AUTO_HANDOFF_SUGGEST = parseInt(process.env.AUTO_HANDOFF_SUGGEST_THRESHOLD || '30', 10);
  const AUTO_HANDOFF_URGENT = parseInt(process.env.AUTO_HANDOFF_URGENT_THRESHOLD || '50', 10);
  const AUTO_HANDOFF_COOLDOWN = parseInt(process.env.AUTO_HANDOFF_COOLDOWN_MS || String(15 * 60 * 1000), 10);
  const autoHandoffSuggested = new Map();
  const pendingAutoHandoffEvents = [];

  function startAutoHandoffMonitor() {
    setInterval(() => {
    try {
      if (sseClients.size === 0) return;
      const panes = collectPanes();
      for (const p of panes) {
        if (!p.is_claude) continue;
        if (p.ctx == null || p.ctx < AUTO_HANDOFF_SUGGEST) continue;
        if (p.status === 'working') continue;

        const lastSuggested = autoHandoffSuggested.get(p.pane_id) || 0;
        if (Date.now() - lastSuggested < AUTO_HANDOFF_COOLDOWN) continue;

        const eventType = p.ctx >= AUTO_HANDOFF_URGENT ? 'autoHandoffUrgent' : 'autoHandoffSuggest';
        const cancelToken = Math.random().toString(36).slice(2, 10);
        const event = {
          type: eventType,
          event: eventType,
          timestamp: new Date().toISOString(),
          pane_id: p.pane_id,
          project: p.project_name,
          ctx: p.ctx,
          cancel_token: cancelToken,
        };

        log(`[auto-handoff] ${eventType}: pane-${p.pane_id} (${p.project_name}) at ${p.ctx}% Ctx`);

        pendingAutoHandoffEvents.push(event);
        if (pendingAutoHandoffEvents.length > 20) pendingAutoHandoffEvents.shift();

        broadcastSSE(event);

        autoHandoffSuggested.set(p.pane_id, Date.now());
      }
    } catch (e) { log(`[auto-handoff] monitor error: ${e.message}`); }
    }, 10000);
  }

  async function handleGetAutoHandoffPending(req, res) {
    sendJson(res, 200, { events: pendingAutoHandoffEvents });
  }

  async function handlePostAutoHandoffSuppress(req, res) {
    try {
      const body = await parseBody(req);
      const paneId = parseInt(body.pane_id, 10);
      if (!Number.isFinite(paneId)) return sendJson(res, 400, { error: 'pane_id must be an integer' });
      const durationMs = parseInt(body.duration_ms, 10) || AUTO_HANDOFF_COOLDOWN;
      autoHandoffSuggested.set(paneId, Date.now() - AUTO_HANDOFF_COOLDOWN + durationMs);
      sendJson(res, 200, { ok: true, pane_id: paneId, suppressed_until: new Date(Date.now() + durationMs).toISOString() });
    } catch (err) {
      sendError(res, err);
    }
  }

  function startBackgroundServices() {
    a2aHeartbeat.startWatcher({
      a2aState,
      broadcastSSE,
      intervalMs: 60 * 1000,
      thresholdMs: 5 * 60 * 1000,
      log,
    });
    log('a2a-heartbeat watcher armed (5min silent threshold, 60s scan)');
    const snapEnv = process.env.WEZBRIDGE_SESSION_SNAPSHOT;
    if (snapEnv !== '0') {
      const intervalMs = (snapEnv && Number(snapEnv) > 1 ? Number(snapEnv) : 60) * 1000;
      sessionSnapshot.startWatcher({
        // Enrich raw panes with pane-discovery's AI detection: Claude Code
        // sets topic titles with no "claude" in them, so the title-regex
        // classifier alone captures nothing (snapshot gap found 2026-07-02).
        listPanes: () => {
          const raw = ipc.wez.listPanes() || [];
          // Claude Code AND Codex set topic/model titles with no "claude"/"codex"
          // in them, so title-regex classification misses both. Enrich each pane
          // with pane-discovery's agent detection (codex support added 2026-07-15).
          const agentOf = new Map();
          try {
            for (const d of ipc.discoverPanes()) {
              if (d.agent) agentOf.set(d.paneId, d.agent); // 'claude' | 'codex'
            }
          } catch (err) {
            log(`snapshot discovery enrichment failed (falling back to titles): ${err.message}`);
          }
          return raw.map((p) => agentOf.has(p.pane_id) ? { ...p, cmdline_hint: agentOf.get(p.pane_id) } : p);
        },
        intervalMs,
        log,
      });
      log(`session-snapshot watcher armed (${intervalMs / 1000}s tick)`);
      daemonStatus.set('session_snapshot', { armed: true, reason: `armed (${intervalMs / 1000}s tick)` });
    } else {
      // Previously invisible: bridge_health inferred this from the MCP server's
      // OWN env, which cannot see the daemon's. Report it from the daemon.
      daemonStatus.set('session_snapshot', { armed: false, reason: 'WEZBRIDGE_SESSION_SNAPSHOT=0 (explicit off)' });
      log('session-snapshot watcher NOT armed: WEZBRIDGE_SESSION_SNAPSHOT=0');
    }
    try {
      const restored = teamManifest.replay();
      for (const [name, t] of restored.teams) teamsRegistry.set(name, t);
      for (const [paneId, wt] of restored.worktrees) worktreeRegistry.set(paneId, wt);
      if (restored.teams.size || restored.worktrees.size) {
        log(`team-manifest replay: ${restored.teams.size} teams, ${restored.worktrees.size} worktrees restored`);
      }
    } catch (e) {
      log(`team-manifest replay failed: ${e.message}`);
    }
    // ClawTrol control-plane v1 (2026-07-27): outbound-only cockpit bridge +
    // orchestrator watchdog. Both fail-soft: bridge no-ops without
    // CLAWTROL_URL/TOKEN; watchdog disabled via WEZBRIDGE_WATCHDOG=0.
    try {
      const bridge = require('../clawtrol-bridge.cjs');
      const notifyOperatorMessage = (message) => {
        const candidates = (discoverPanes ? discoverPanes() : []).filter((pane) => {
          const projectName = pane.projectName
            || (pane.project ? path.basename(String(pane.project)) : null);
          return pane.isClaude && projectName === 'wezbridge';
        });
        if (candidates.length !== 1) {
          log(`clawtrol operator message ${message.intent_id} pending: expected one wezbridge reasoner, found ${candidates.length}`);
          return false;
        }
        const paneId = candidates[0].paneId ?? candidates[0].pane_id;
        const prompt = [
          `[ClawTrol operator message | provenance=operator | intent=${message.intent_id} | task=${message.task_id}]`,
          String(message.content || ''),
          '',
          `Reply in the same ClawTrol thread with clawtrol_task_reply(task_id="${message.task_id}", message_type="reply", content=<your reply>).`,
          'Do not answer only in this terminal; the operator is using the cockpit.',
        ].join('\n');
        const verdict = safetyPolicy.evaluate({ action: 'send_prompt', paneId, prompt });
        if (!verdict.allowed) {
          log(`clawtrol operator message ${message.intent_id} pending: blocked by ${verdict.rule}`);
          return false;
        }
        wez.sendTextBracketed(paneId, prompt);
        wez.sendTextNoEnter(paneId, '\r');
        log(`clawtrol operator message ${message.intent_id} delivered to wezbridge reasoner`);
        return true;
      };
      log(bridge.start({ notifyOperatorMessage }) ? 'clawtrol-bridge armed (outbound sync loop)' : 'clawtrol-bridge disabled (CLAWTROL_URL/TOKEN unset)');
    } catch (e) {
      log(`clawtrol-bridge failed to start: ${e.message}`);
    }
    try {
      const watchdog = require('../pane0-watchdog.cjs');
      log(watchdog.start() ? 'pane0-watchdog armed (30s check, 90s absent-recovery, 10min cooldown, 3-strike disable)' : 'pane0-watchdog disabled (WEZBRIDGE_WATCHDOG=0)');
    } catch (e) {
      log(`pane0-watchdog failed to start: ${e.message}`);
    }
    // Orchestrator waker (walksim pilot, 2026-08-05): poke pane-0 when a
    // watched repo's pane finishes a turn.
    //
    // Arming is resolved from _intel/orch-waker.json with an env override, NOT
    // from the env alone: on 2026-08-06 a daemon restart via the documented
    // `npm run dashboard` dropped WEZBRIDGE_ORCH_WAKER=1 with the old shell and
    // the loop went dark for 2h45m. Both branches register with daemon-status
    // and both LOG — a silent fall-through is what made that outage invisible.
    try {
      const { createWaker, resolveWakerConfig } = require('../orchestrator-waker.cjs');
      const verifiedSend = require('../verified-send.cjs');
      const intelDir = process.env.WEZBRIDGE_INTEL_DIR
        || path.join(SRC_DIR, '..', '..', '_intel');
      const wakerCfg = resolveWakerConfig({ env: process.env, intelDir });
      if (!wakerCfg.enabled) {
        daemonStatus.set('orchestrator_waker', { armed: false, reason: wakerCfg.reason });
        log(`orchestrator-waker NOT armed: ${wakerCfg.reason}`);
      } else {
        const waker = createWaker({
          eventsPath: path.join(intelDir, 'pane-events.jsonl'),
          stateDir: path.join(intelDir, '.orch-waker-state'),
          watchRepos: wakerCfg.repos,
          discoverPanes: () => (discoverPanes ? discoverPanes() : []),
          send: verifiedSend,
          log,
        });
        waker.startWatcher();
        daemonStatus.set('orchestrator_waker', {
          armed: true, reason: wakerCfg.reason, probe: () => waker.status(),
        });
        log(`orchestrator-waker armed (60s tick, idle-gated verified pokes, cap 3 + 5min cooldown) — ${wakerCfg.reason}`);
      }
    } catch (e) {
      daemonStatus.set('orchestrator_waker', { armed: false, reason: `failed to start: ${e.message}` });
      log(`orchestrator-waker failed to start: ${e.message}`);
    }

    // Liveness heartbeat (audit hole 3, 2026-08-06). Nothing watched the daemon
    // before this; the file OUTLIVES the process, so its staleness is positive
    // evidence of death — knowable precisely when the daemon cannot speak.
    //
    // Started LAST, deliberately. The first beat is immediate and carries the
    // service snapshot, so beating before the watchers register would publish a
    // snapshot missing the waker — and a reader in that window would be told
    // "WAKER MISSING" about a perfectly healthy daemon. An alert that fires on
    // a correct system is worse than no alert.
    try {
      const intelDir = process.env.WEZBRIDGE_INTEL_DIR
        || path.join(SRC_DIR, '..', '..', '_intel');
      fs.mkdirSync(intelDir, { recursive: true });
      daemonStatus.startHeartbeat({ file: path.join(intelDir, '.daemon-heartbeat.json') });
      log(`daemon heartbeat armed (${daemonStatus.HEARTBEAT_INTERVAL_MS / 1000}s beat -> _intel/.daemon-heartbeat.json)`);
    } catch (e) {
      log(`daemon heartbeat failed to start: ${e.message}`);
    }
  }

  return {
    handleGetA2APending,
    handlePostA2AHandoff,
    handleEvents,
    handleGetHandoffs,
    handleGetAutoHandoffPending,
    handlePostAutoHandoffSuppress,
    startAutoHandoffMonitor,
    startBackgroundServices,
  };
}

module.exports = { createEventHandlers };
