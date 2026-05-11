'use strict';

function createPaneHandlers(ctx) {
  const {
    sendJson, sendError, parseBody, log, safetyPolicy, wez, execSync,
    worktreeRegistry, teamManifest, collectPanes, handoffRegistry,
    isoForFilename, sleep,
  } = ctx;

  async function handleGetPanes(req, res) {
    try { sendJson(res, 200, { panes: collectPanes() }); }
    catch (err) { log(`GET /api/panes error: ${err.message}`); sendError(res, err); }
  }

  async function handleGetSessions(req, res) {
    try {
      const sessions = collectPanes().map(p => ({
        ...p,
        confidence: Math.round((p.confidence || 0) * (p.confidence > 1 ? 1 : 100)),
      }));
      sendJson(res, 200, { sessions });
    } catch (err) { sendError(res, err); }
  }

  async function handlePostBroadcast(req, res) {
    try {
      const { text, panes: targets } = await parseBody(req);
      if (!text) return sendJson(res, 400, { error: 'missing text' });
      const all = collectPanes().filter(p => p.is_claude);
      const ids = Array.isArray(targets) && targets.length ? targets : all.map(p => p.pane_id);
      for (const id of ids) {
        try { wez.sendText(id, text); wez.sendTextNoEnter(id, '\r'); } catch (e) { log(`broadcast pane ${id}: ${e.message}`); }
      }
      sendJson(res, 200, { ok: true, sent: ids.length });
    } catch (err) { sendError(res, err); }
  }

  async function handleGetPaneOutput(res, paneId, lines) {
    try {
      const text = wez.getFullText(paneId, lines);
      sendJson(res, 200, { pane_id: paneId, output: text || '', lines: text || '' });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostPrompt(req, res, paneId) {
    try {
      const { text } = await parseBody(req);
      if (typeof text !== 'string' || !text.length) {
        return sendJson(res, 400, { error: 'missing `text` body field' });
      }
      const _safety = safetyPolicy.evaluate({ action: 'send_prompt', paneId, prompt: text });
      if (!_safety.allowed) {
        if (_safety.tripwire) {
          return sendJson(res, 200, { ok: false, tripwire: true, message: _safety.response, matched: _safety.matched });
        }
        return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
      }
      wez.sendText(paneId, text);
      wez.sendTextNoEnter(paneId, '\r');
      sendJson(res, 200, { ok: true, pane_id: paneId });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostKey(req, res, paneId) {
    try {
      const { key } = await parseBody(req);
      if (!key) return sendJson(res, 400, { error: 'missing `key` body field' });
      const _safety = safetyPolicy.evaluate({ action: 'send_key', paneId, key });
      if (!_safety.allowed) {
        return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
      }
      const mapping = {
        enter: '\r', y: 'y', n: 'n',
        'ctrl+c': '\x03',
        '1': '1', '2': '2', '3': '3',
      };
      const payload = mapping[key.toLowerCase()] ?? key;
      wez.sendTextNoEnter(paneId, payload);
      sendJson(res, 200, { ok: true, pane_id: paneId, key });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostKill(res, paneId) {
    try {
      const _safety = safetyPolicy.evaluate({ action: 'kill_session', paneId });
      if (!_safety.allowed) {
        return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
      }
      wez.killPane(paneId);
      const wt = worktreeRegistry.get(paneId);
      if (wt) {
        try {
          execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" worktree remove "${wt.worktreePath}" --force`, { timeout: 15000, encoding: 'utf8' });
        } catch (e) { log(`worktree auto-cleanup remove failed for pane ${paneId}: ${e.message}`); }
        try {
          execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" branch -d "${wt.branchName}"`, { timeout: 15000, encoding: 'utf8' });
        } catch { /* branch not merged - expected, not an error */ }
        worktreeRegistry.delete(paneId);
        teamManifest.record({ event: 'worktree_removed', pane_id: paneId }, { log });
      }
      sendJson(res, 200, { ok: true, pane_id: paneId, worktree_cleaned: !!wt });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostAutoHandoff(req, res, paneId) {
    try {
      const panes = collectPanes();
      const pane = panes.find(p => p.pane_id === paneId);
      if (!pane) return sendJson(res, 404, { error: 'pane not found' });

      if (pane.status === 'working') return sendJson(res, 409, { error: 'pane is working, retry when idle' });

      const body = await parseBody(req);
      const focus = body.focus || '';
      const force = !!body.force;
      let readinessResult = null;

      if (!force) {
        const ctxPct = pane.ctx || 'unknown';
        const checkPrompt = `[AUTO-HANDOFF READINESS CHECK] The dashboard is considering a session reset because Ctx is at ${ctxPct}%. Are you at a natural break point where a handoff WOULD NOT lose mid-task context?\n\nReply in exactly this format:\n  READY: <1-line reason>\n  — or —\n  NOT_READY: <what you'd need to finish first>\n\nNothing else.`;
        wez.sendText(paneId, checkPrompt);
        wez.sendTextNoEnter(paneId, '\r');

        const READINESS_POLL_ITERATIONS = 60;
        for (let i = 0; i < READINESS_POLL_ITERATIONS; i++) {
          await sleep(2000);
          try {
            const text = wez.getFullText(paneId, 20) || '';
            const match = text.match(/●\s*(READY|NOT_READY):\s*(.+?)(?:\n|$)/);
            if (match) { readinessResult = { status: match[1], reason: match[2].trim() }; break; }
          } catch { /* pane may be transitioning */ }
        }

        if (!readinessResult) {
          log(`[auto-handoff] pane-${paneId} readiness timed out after ${READINESS_POLL_ITERATIONS * 2}s`);
          return sendJson(res, 504, { error: `readiness check timed out after ${READINESS_POLL_ITERATIONS * 2}s — pane may be mid-thinking, retry or pass force:true` });
        }
        log(`[auto-handoff] pane-${paneId} responded ${readinessResult.status}: ${readinessResult.reason.slice(0, 80)}`);
        if (readinessResult.status === 'NOT_READY') {
          return sendJson(res, 409, {
            error: 'pane declined handoff',
            reason: readinessResult.reason,
            retry_hint: 'wait for pane to finish, or pass force:true',
          });
        }
      }

      const corrShort = Math.random().toString(36).slice(2, 8);
      const corr = 'handoff-' + corrShort;
      const filename = 'handoff-' + isoForFilename() + '-' + corrShort + '.md';

      const instruction = `Use the /handoff skill to write a comprehensive session handoff to handoffs/${filename}. Corr: ${corr}. Focus: ${focus || 'general checkpoint'}. Include sections: Context, Current State, Open Threads, Next Steps, Constraints & Gotchas, Relevant Files. Do NOT include credentials, API keys, tokens, or private paths. Write the file, then stop.`;
      log(`[auto-handoff] pane-${paneId} dispatching /handoff skill (corr=${corr})`);
      wez.sendText(paneId, instruction);
      wez.sendTextNoEnter(paneId, '\r');

      const paneCwd = (pane.project || '').replace(/^\//, '');
      const handoffsDir = ctx.path.join(paneCwd, 'handoffs');
      const filePath = ctx.path.join(handoffsDir, filename);
      let fileFound = false;
      for (let i = 0; i < 45; i++) {
        await sleep(2000);
        try {
          if (ctx.fs.existsSync(filePath) && ctx.fs.statSync(filePath).size > 200) {
            fileFound = true; break;
          }
        } catch { /* file not ready yet */ }
      }
      if (!fileFound) {
        log(`[auto-handoff] pane-${paneId} handoff file not written within 90s`);
        return sendJson(res, 504, { error: 'handoff generation timed out', partial: true });
      }
      log(`[auto-handoff] pane-${paneId} handoff file found: ${filename}`);

      const content = ctx.fs.readFileSync(filePath, 'utf8').slice(0, 4000);
      const sectionCount = ['## Current State', '## Next Steps', '## Open Threads', '## Context']
        .filter(h => content.includes(h)).length;
      if (sectionCount < 2) {
        log(`[auto-handoff] pane-${paneId} handoff file incomplete (only ${sectionCount}/4 sections)`);
        return sendJson(res, 500, { error: 'handoff file incomplete', file: 'handoffs/' + filename, sections_found: sectionCount });
      }

      let settledChecks = 0;
      const SETTLE_REQUIRED = 3;
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        try {
          const panesNow = collectPanes();
          const pNow = panesNow.find(x => x.pane_id === paneId);
          if (pNow && pNow.status === 'idle') {
            settledChecks++;
            if (settledChecks >= SETTLE_REQUIRED) break;
          } else {
            settledChecks = 0;
          }
        } catch { /* transient */ }
      }
      log(`[auto-handoff] pane-${paneId} settled (idle ${settledChecks}x consecutive), sending /clear`);

      try { wez.sendTextNoEnter(paneId, '\x03'); } catch {}
      await sleep(500);
      wez.sendText(paneId, '/clear');
      wez.sendTextNoEnter(paneId, '\r');
      await sleep(4000);
      wez.sendTextNoEnter(paneId, '\r');

      log(`[auto-handoff] pane-${paneId} injecting continuation prompt`);
      wez.sendText(paneId, `Continue your work from the handoff file at handoffs/${filename}. Read it FIRST, then proceed with your next step.`);
      wez.sendTextNoEnter(paneId, '\r');
      await sleep(500);
      wez.sendTextNoEnter(paneId, '\r');

      handoffRegistry.set(corr, {
        corr, paneId, file: 'handoffs/' + filename,
        createdAt: Date.now(), readinessReason: force ? 'forced' : (readinessResult?.reason || 'unknown'),
        status: 'completed',
      });

      sendJson(res, 200, {
        ok: true, corr, handoff_file: 'handoffs/' + filename,
        session_cleared: true,
        readiness_reason: force ? 'forced' : (readinessResult?.reason || 'unknown'),
      });
    } catch (err) {
      log(`POST /api/sessions/${paneId}/auto-handoff error: ${err.message}`);
      sendError(res, err);
    }
  }

  return {
    handleGetPanes,
    handleGetSessions,
    handlePostBroadcast,
    handleGetPaneOutput,
    handlePostPrompt,
    handlePostKey,
    handlePostKill,
    handlePostAutoHandoff,
  };
}

module.exports = { createPaneHandlers };
