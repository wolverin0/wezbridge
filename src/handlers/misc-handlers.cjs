'use strict';

function createMiscHandlers(ctx) {
  const {
    sendJson, sendError, parseBody, corsHeaders, log, fs, path, https,
    scanProjects, gradesRegistry, outcomeGrader, routinesConfig,
  } = ctx;

  async function handleGetProjects(req, res) {
    try {
      const list = scanProjects({ includeCodex: true, limit: null }) || [];
      const projects = list.map(p => ({
        name: p.name || (p.realPath || '').split(/[/\\]/).pop() || 'project',
        path: p.realPath || p.cwd || '',
        cwd: p.realPath || p.cwd || '',
        type: p.agent || 'claude',
        last_activity: p.latestActivityMs ? new Date(p.latestActivityMs).toISOString() : null,
        session_count: p.sessionCount || 0,
      }));
      sendJson(res, 200, projects);
    } catch (err) { sendError(res, err); }
  }

  async function handleGetBrowse(req, res, queryPath) {
    try {
      const dir = queryPath || process.env.HOME || process.env.USERPROFILE || '/';
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return sendJson(res, 200, { cwd: dir, dirs: [], error: 'not a directory' });
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
        .slice(0, 200);
      sendJson(res, 200, { cwd: dir, dirs: entries });
    } catch (err) { sendError(res, err); }
  }

  async function handleGetGrades(req, res) {
    try {
      sendJson(res, 200, { grades: gradesRegistry.list(), count: gradesRegistry.size() });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostGrade(req, res) {
    try {
      const body = await parseBody(req);
      const key = body.key || body.corr || body.pane_id;
      if (!key) return sendJson(res, 400, { error: 'missing `key` (or `corr` / `pane_id`)' });
      if (typeof body.work !== 'string') return sendJson(res, 400, { error: 'missing `work` (string)' });
      const grade = outcomeGrader.grade({
        work: body.work,
        rubric: body.rubric || '',
        taskDesc: body.taskDesc || body.task_desc || '',
        backend: body.backend,
        model: body.model,
      });
      const entry = gradesRegistry.record(String(key), grade);
      sendJson(res, 200, { ok: true, ...entry });
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handlePostRoutinesFire(req, res) {
    try {
      const body = await parseBody(req);
      const routineId = typeof body.routine_id === 'string' ? body.routine_id.trim() : '';
      if (!routineId) {
        return sendJson(res, 400, { error: 'routine_id is required' });
      }
      const routine = routinesConfig.getRoutine(routineId);
      if (!routine) {
        return sendJson(res, 400, {
          error: `routine_id "${routineId}" not found in vault/_routines-config.md. ` +
                 'Add a YAML block for it, or copy _routines-config.md.template to activate.',
        });
      }
      const envVar = (typeof body.token_env_var === 'string' && body.token_env_var.trim())
        ? body.token_env_var.trim()
        : routine.token_env || routinesConfig.defaultTokenEnv(routineId);
      const token = process.env[envVar];
      if (!token) {
        return sendJson(res, 400, {
          error: `Bearer token env var "${envVar}" is not set. Generate a token on the routine's Edit page and export ${envVar}=<token> before starting the dashboard.`,
        });
      }

      const text = typeof body.text === 'string' ? body.text : '';
      const payload = text.trim() ? JSON.stringify({ text }) : '';

      const headers = {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

      const upstream = https.request({
        hostname: 'api.anthropic.com',
        port: 443,
        path: `/v1/claude_code/routines/${encodeURIComponent(routineId)}/fire`,
        method: 'POST',
        headers,
        timeout: 15 * 1000,
      }, (up) => {
        let buf = '';
        up.on('data', chunk => { buf += chunk.toString('utf8'); });
        up.on('end', () => {
          const status = up.statusCode || 502;
          let parsed = null;
          try { parsed = JSON.parse(buf); } catch { /* non-JSON upstream */ }
          if (parsed) {
            sendJson(res, status, parsed);
          } else {
            res.writeHead(status, {
              'Content-Type': up.headers['content-type'] || 'text/plain',
              ...corsHeaders(res),
            });
            res.end(buf);
          }
        });
      });
      upstream.on('error', err => {
        log(`routines fire upstream error: ${err.message}`);
        sendJson(res, 502, { error: `upstream error: ${err.message}` });
      });
      upstream.on('timeout', () => {
        upstream.destroy(new Error('upstream timeout'));
        sendJson(res, 504, { error: 'upstream timeout (15s)' });
      });
      if (payload) upstream.write(payload);
      upstream.end();
    } catch (err) {
      log(`POST /api/routines/fire error: ${err.message}`);
      sendError(res, err);
    }
  }

  return {
    handleGetProjects,
    handleGetBrowse,
    handleGetGrades,
    handlePostGrade,
    handlePostRoutinesFire,
  };
}

module.exports = { createMiscHandlers };
