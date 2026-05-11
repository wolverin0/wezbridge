'use strict';

function createAgentHandlers(ctx) {
  const {
    sendJson, sendError, parseBody, log, safetyPolicy, fs, path, wez, execSync,
    teamManifest, collectPanes, worktreeRegistry, teamsRegistry, PRD_DIR,
    AGENTS_DIR, PERSONAS_CACHE_TTL, parsePersonaFrontmatter, resolvePersona,
    spawnAgentPane, parsePRD, sleep,
  } = ctx;

  async function handleGetPersonas(req, res) {
    try {
      const now = Date.now();
      if (ctx.personasCache && (now - ctx.personasCacheTs) < PERSONAS_CACHE_TTL) {
        return sendJson(res, 200, ctx.personasCache);
      }
      const personas = [];
      if (!fs.existsSync(AGENTS_DIR)) return sendJson(res, 200, []);
      const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.')) {
            walk(path.join(dir, e.name), prefix ? prefix + '/' + e.name : e.name);
          } else if (e.isFile() && e.name.endsWith('.md')) {
            const filePath = path.join(dir, e.name);
            const fm = parsePersonaFrontmatter(filePath);
            personas.push({
              name: fm.name || e.name.replace(/\.md$/, ''),
              file: e.name,
              category: prefix || null,
              path: (prefix ? prefix + '/' : '') + e.name,
              description: fm.description || null,
              type: fm.type || null,
              color: fm.color || null,
            });
          }
        }
      };
      walk(AGENTS_DIR, '');
      const seen = new Map();
      for (const p of personas) {
        const key = p.name;
        if (!seen.has(key) || p.path.split('/').length < seen.get(key).path.split('/').length) {
          seen.set(key, p);
        }
      }
      const result = Array.from(seen.values()).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
      ctx.personasCache = result;
      ctx.personasCacheTs = now;
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostSpawn(req, res) {
    try {
      const body = await parseBody(req);
      req.body = body;
      safetyPolicy.assertBypassPermissionsAllowed(req);
      const { cwd, program } = body;
      if (!cwd) return sendJson(res, 400, { error: 'missing `cwd` body field' });

      if (body.persona) {
        const personaPath = resolvePersona(body.persona);
        if (!personaPath) return sendJson(res, 400, { error: `persona "${body.persona}" not found in ${AGENTS_DIR}` });
      }

      if (body.persona || body.permission_mode || body.worktree) {
        try {
          const { paneId, worktreeInfo } = await spawnAgentPane({
            cwd,
            persona: body.persona || null,
            permission_mode: body.permission_mode || null,
            worktree: body.worktree || false,
          });
          const response = { ok: true, pane_id: paneId, persona: body.persona || null };
          if (worktreeInfo) response.worktree = { path: worktreeInfo.path, branch: worktreeInfo.branch };
          return sendJson(res, 200, response);
        } catch (err) {
          return sendError(res, err);
        }
      }

      const paneId = wez.spawnPane({ cwd, program, args: undefined });
      sendJson(res, 200, { ok: true, pane_id: paneId, persona: null });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleGetWorktrees(req, res) {
    try {
      const worktrees = Array.from(worktreeRegistry.entries()).map(([paneId, wt]) => ({
        paneId,
        persona: wt.persona,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        baseCwd: wt.baseCwd,
      }));
      sendJson(res, 200, { worktrees });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostWorktreeCleanup(req, res, paneId) {
    try {
      const wt = worktreeRegistry.get(paneId);
      if (!wt) return sendJson(res, 404, { error: `pane ${paneId} has no registered worktree` });
      const _safety = safetyPolicy.evaluate({
        action: 'worktree_remove',
        baseCwd: wt.baseCwd,
        worktreePath: wt.worktreePath,
      });
      if (!_safety.allowed) {
        return sendJson(res, 403, { error: `safety-policy blocked: ${_safety.reason}`, matched: _safety.matched });
      }
      try {
        execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" worktree remove "${wt.worktreePath}" --force`, { timeout: 15000, encoding: 'utf8' });
      } catch (e) {
        return sendJson(res, 500, { error: `worktree remove failed: ${e.message}` });
      }
      try {
        execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" branch -d "${wt.branchName}"`, { timeout: 15000, encoding: 'utf8' });
      } catch { /* branch not merged - soft delete fails, that is OK */ }
      const removed = wt.worktreePath;
      const branch = wt.branchName;
      worktreeRegistry.delete(paneId);
      teamManifest.record({ event: 'worktree_removed', pane_id: paneId }, { log });
      sendJson(res, 200, { ok: true, removed, branch });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostWorktreeMerge(req, res, paneId) {
    try {
      const wt = worktreeRegistry.get(paneId);
      if (!wt) return sendJson(res, 404, { error: `pane ${paneId} has no registered worktree` });
      try {
        const stdout = execSync(`git -C "${wt.baseCwd.replace(/\\/g, '/')}" merge "${wt.branchName}" --no-edit`, { timeout: 15000, encoding: 'utf8' });
        sendJson(res, 200, { ok: true, merged: wt.branchName, stats: stdout.trim() });
      } catch (mergeErr) {
        const output = String(mergeErr.stdout || '') + String(mergeErr.stderr || '');
        if (output.includes('CONFLICT') || output.includes('Merge conflict')) {
          const conflictLines = output.split('\n').filter(l => l.includes('CONFLICT'));
          const files = conflictLines.map(l => {
            const m = l.match(/CONFLICT.*?:\s*(?:Merge conflict in\s+)?(.+)/);
            return m ? m[1].trim() : l.trim();
          });
          return sendJson(res, 200, { ok: false, conflicts: true, files });
        }
        return sendJson(res, 500, { error: `merge failed: ${mergeErr.message}` });
      }
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleGetPRDs(req, res) {
    try {
      if (!fs.existsSync(PRD_DIR)) return sendJson(res, 200, { prds: [] });
      const files = fs.readdirSync(PRD_DIR).filter(f => f.endsWith('.md'));
      const prds = [];
      for (const f of files) {
        const parsed = parsePRD(path.join(PRD_DIR, f));
        if (!parsed) continue;
        prds.push({
          file: f,
          slug: f.replace(/\.md$/, ''),
          name: parsed.name,
          roles_count: parsed.roles.length,
          scope: parsed.scope,
          deadline: parsed.deadline,
        });
      }
      sendJson(res, 200, { prds });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleGetTeams(req, res) {
    try {
      const livePanes = collectPanes();
      const paneStatusMap = new Map();
      for (const p of livePanes) {
        paneStatusMap.set(p.pane_id, p.status || 'unknown');
      }

      const teams = [];
      for (const [name, team] of teamsRegistry) {
        const roles = team.roles.map(r => ({
          pane_id: r.paneId,
          persona: r.persona,
          worktree: r.worktree || false,
          branch: r.branch || null,
          task: r.task,
          status: paneStatusMap.get(r.paneId) || r.status || 'unknown',
        }));
        teams.push({
          name,
          prd: team.prd,
          createdAt: team.createdAt,
          cwd: team.cwd,
          roles,
        });
      }
      sendJson(res, 200, { teams });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostBootstrap(req, res) {
    try {
      const body = await parseBody(req, { timeoutMs: 30_000, maxBytes: 2_097_152 });
      const prdSlug = typeof body.prd === 'string' ? body.prd.trim() : '';
      if (!prdSlug) return sendJson(res, 400, { error: 'missing `prd` field' });

      const prdFile = path.join(PRD_DIR, prdSlug + '.md');
      if (!fs.existsSync(prdFile)) {
        return sendJson(res, 404, { error: `PRD file not found: docs/prd/${prdSlug}.md` });
      }

      const prd = parsePRD(prdFile);
      if (!prd) {
        return sendJson(res, 400, { error: `failed to parse PRD frontmatter in docs/prd/${prdSlug}.md` });
      }

      const cwd = (body.cwd && typeof body.cwd === 'string') ? body.cwd : process.cwd();

      const agents = [];
      const teamRoles = [];

      for (let i = 0; i < prd.roles.length; i++) {
        const role = prd.roles[i];

        if (i > 0) await sleep(3000);

        let paneId = null;
        let wtInfo = null;
        safetyPolicy.assertBypassPermissionsAllowed({ body: { permission_mode: role.permission_mode || null } });
        try {
          const result = await spawnAgentPane({
            cwd,
            persona: role.persona,
            permission_mode: role.permission_mode || null,
            worktree: role.worktree || false,
          });
          paneId = result.paneId;
          wtInfo = result.worktreeInfo;
        } catch (spawnErr) {
          log(`bootstrap spawn failed for role ${role.persona}: ${spawnErr.message}`);
          agents.push({ persona: role.persona, error: spawnErr.message });
          teamRoles.push({
            paneId: null, persona: role.persona, worktree: role.worktree || false,
            branch: null, task: role.task, status: 'spawn_failed',
          });
          continue;
        }

        await sleep(8000);

        const corrId = `prd-${prdSlug}-${i}`;
        const handoffPrompt = [
          `[A2A from dashboard to pane-${paneId} | corr=${corrId} | type=request]`,
          `You are the ${role.persona} on team "${prd.name}".`,
          `Your task: ${role.task}`,
          `Scope: ${prd.scope || 'full project'}`,
          '',
          'Start working. When done, report completion via A2A result envelope.',
        ].join('\n');

        try {
          wez.sendText(paneId, handoffPrompt);
          wez.sendTextNoEnter(paneId, '\r');
        } catch (sendErr) {
          log(`bootstrap handoff failed for pane ${paneId}: ${sendErr.message}`);
        }

        agents.push({
          pane_id: paneId,
          persona: role.persona,
          worktree: role.worktree || false,
          branch: wtInfo ? wtInfo.branch : null,
          task: role.task,
        });

        teamRoles.push({
          paneId,
          persona: role.persona,
          worktree: role.worktree || false,
          branch: wtInfo ? wtInfo.branch : null,
          task: role.task,
          status: 'dispatched',
        });
      }

      teamsRegistry.set(prd.name, {
        prd: prdSlug,
        createdAt: Date.now(),
        cwd,
        roles: teamRoles,
      });
      teamManifest.record({
        event: 'team_added',
        team_name: prd.name,
        prd: prdSlug,
        cwd,
        roles: teamRoles,
      }, { log });

      sendJson(res, 200, { ok: true, team: prd.name, agents });
    } catch (err) {
      log(`POST /api/agency/bootstrap error: ${err.message}`);
      sendError(res, err);
    }
  }

  return {
    handleGetPersonas,
    handlePostSpawn,
    handleGetWorktrees,
    handlePostWorktreeCleanup,
    handlePostWorktreeMerge,
    handleGetPRDs,
    handleGetTeams,
    handlePostBootstrap,
  };
}

module.exports = { createAgentHandlers };
