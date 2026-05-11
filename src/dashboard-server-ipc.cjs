'use strict';

const path = require('path');
const { execSync } = require('child_process');
const wez = require('./wezterm.cjs');
const { discoverPanes } = require('./pane-discovery.cjs');

function collectPanes() {
  const raw = discoverPanes ? discoverPanes() : wez.listPanes().map(p => ({ paneId: p.pane_id }));
  return (raw || []).map(p => ({
    pane_id: p.paneId ?? p.pane_id,
    is_claude: p.isClaude ?? false,
    status: p.status ?? 'unknown',
    project: p.project ?? null,
    project_name: p.projectName ?? null,
    title: p.title ?? '',
    workspace: p.workspace ?? 'default',
    confidence: p.confidence ?? 0,
    last_line: p.lastLines ?? '',
    persona: p.persona ?? null,
    ctx: typeof p.ctx === 'number' ? p.ctx : null,
    session_pct: typeof p.sessionPct === 'number' ? p.sessionPct : null,
    weekly_pct: typeof p.weeklyPct === 'number' ? p.weeklyPct : null,
    model: p.model ?? null,
  }));
}

async function spawnAgentPane({ cwd, persona, permission_mode, worktree }, { resolvePersona, worktreeRegistry, teamManifest, log }) {
  const spawnCwd = String(cwd);
  let worktreeInfo = null;
  let effectiveCwd = spawnCwd;

  if (worktree === true) {
    try {
      execSync(`git -C "${spawnCwd.replace(/\\/g, '/')}" rev-parse --git-dir`, { timeout: 15000, encoding: 'utf8' });
    } catch {
      throw new Error('not a git repo -- cannot create worktree');
    }
    const shortId = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
    const agentSlug = persona || 'agent';
    const branchName = `claude/agency-${agentSlug}-${shortId}`;
    const worktreePath = path.join(spawnCwd, '.worktrees', `${agentSlug}-${shortId}`).replace(/\\/g, '/');
    execSync(`git -C "${spawnCwd.replace(/\\/g, '/')}" worktree add "${worktreePath}" -b "${branchName}"`, { timeout: 15000, encoding: 'utf8' });
    effectiveCwd = worktreePath;
    worktreeInfo = { path: worktreePath, branch: branchName, baseCwd: spawnCwd };
  }

  const paneId = wez.spawnPane({ cwd: effectiveCwd });
  await new Promise(r => setTimeout(r, 2000));

  const validModes = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
  let claudeCmd = 'claude';
  if (persona) {
    const personaPath = resolvePersona(persona);
    if (personaPath) {
      claudeCmd += ' --append-system-prompt-file "' + personaPath.replace(/\\/g, '/') + '"';
    }
  } else {
    claudeCmd += ' --continue';
  }
  if (process.env.WEZBRIDGE_ALLOW_SKIP_PERMISSIONS === 'true') {
    claudeCmd += ' --dangerously-skip-permissions';
  }
  // AXIS-4: honour permission_mode only when the env gate is explicitly on.
  // If the gate is off and the caller sent bypassPermissions, the spawn handler
  // must have already rejected with 403 — this is a belt-and-suspenders guard.
  if (process.env.WEZBRIDGE_ALLOW_SKIP_PERMISSIONS === 'true' &&
      permission_mode && validModes.includes(permission_mode)) {
    claudeCmd += ' --permission-mode ' + permission_mode;
  }
  wez.sendText(paneId, claudeCmd);

  if (persona) {
    try { wez.setTabTitle(paneId, `[${persona}]`); } catch { /* best effort */ }
  }

  if (worktreeInfo) {
    worktreeRegistry.set(paneId, {
      persona: persona || 'agent',
      worktreePath: worktreeInfo.path,
      branchName: worktreeInfo.branch,
      baseCwd: worktreeInfo.baseCwd,
    });
    teamManifest.record({
      event: 'worktree_added',
      pane_id: paneId,
      persona: persona || 'agent',
      worktree_path: worktreeInfo.path,
      branch_name: worktreeInfo.branch,
      base_cwd: worktreeInfo.baseCwd,
    }, { log });
  }

  return { paneId, worktreeInfo };
}

module.exports = { collectPanes, spawnAgentPane, wez, discoverPanes };
