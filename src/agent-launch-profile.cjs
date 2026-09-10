'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Passive launch-profile reader: no timer, process launch or pane messaging.
// The operator selects the durable session; recovery never guesses --last or
// accepts a shell command from configuration. Missing config preserves legacy
// installations; invalid config must fail before a replacement pane is spawned.
function orchestratorResumeCommand(intelRoot = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel')) {
  const file = path.join(intelRoot, 'orchestrator-session.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const profile = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (profile.version !== 1 || profile.agent !== 'codex'
      || typeof profile.sessionId !== 'string' || profile.sessionId.length !== 36
      || typeof profile.model !== 'string' || /\s/.test(profile.model)
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(profile.sessionId || '')
      || !/^gpt-[a-z0-9.-]+$/i.test(profile.model || '')) {
    throw new Error('Invalid orchestrator-session.json: expected a Codex session UUID and model');
  }
  return `codex resume ${profile.sessionId} -C . -m ${profile.model} "Continue the authorized orchestration work from this conversation; verify current state before acting."`;
}

function isOrchestratorCwd(cwd) {
  const normalize = value => {
    const raw = String(value || '');
    const decoded = /^file:\/\//i.test(raw) ? decodeURIComponent(raw) : raw;
    return decoded.replace(/^file:\/\/[^/]*/i, '').replace(/\\/g, '/')
      .replace(/^\/([a-z]:\/)/i, '$1').replace(/\/+$/, '').toLowerCase();
  };
  return normalize(cwd) === normalize(process.env.WEZBRIDGE_ORCH_CWD || path.join(__dirname, '..'));
}

module.exports = { orchestratorResumeCommand, isOrchestratorCwd };
