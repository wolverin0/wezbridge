'use strict';
/**
 * lifecycle.cjs — pane lifecycle enforcement (B2, frente 3). Three concerns:
 * CAP: evaluateSpawnCap — WEZBRIDGE_MAX_PANES (default 5, '0'/'off' disables);
 *   enforced at the src/wezterm.cjs spawn chokepoints (spawnPane + splits).
 * AFFINITY: resolveAffinity — project→{agent,model} from _intel/affinity.json
 *   (env WEZBRIDGE_AFFINITY_JSON > file > none; WEZBRIDGE_AFFINITY=0 disables).
 * AUTO-CLOSE: decideAutoClose is PURE and SHADOW-ONLY — callers log
 *   auto_close_shadow and NEVER kill. WEZBRIDGE_AUTOCLOSE=live is a documented
 *   FUTURE flag: nothing reads it yet; going live is an operator decision.
 *
 * Exclusions for auto-close (operator-approved design): the orchestrator pane
 * (project == WEZBRIDGE_ORCH_REPO, default "wezbridge") and any pane holding an
 * active ledger lease (_intel/tasks/T-*.json, state=running + unexpired lease).
 * Unknown project fails SAFE (no close): when we cannot tell who a pane is,
 * we do not propose killing it, even in shadow — the shadow log must rehearse
 * exactly what live mode would be allowed to do.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_PANES = 5;

function defaultIntelDir(env = process.env) {
  return env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
}

/**
 * Resolve the pane cap. Returns a positive integer, or Infinity when the cap
 * is explicitly disabled (WEZBRIDGE_MAX_PANES=0 or 'off'). Garbage values fall
 * back to the default — a typo must never silently disable enforcement.
 */
function resolveMaxPanes(env = process.env) {
  const raw = env.WEZBRIDGE_MAX_PANES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_PANES;
  const s = String(raw).trim().toLowerCase();
  if (s === '0' || s === 'off') return Infinity;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PANES;
}

/**
 * safetyPolicy-shaped verdict for a spawn attempt: { allowed, reason, max }.
 * Pure — the caller supplies the live pane count.
 */
function evaluateSpawnCap({ paneCount, env = process.env } = {}) {
  const max = resolveMaxPanes(env);
  if (!Number.isFinite(max)) {
    return { allowed: true, max: null, reason: 'pane cap disabled (WEZBRIDGE_MAX_PANES=0/off)' };
  }
  const count = Number.isInteger(paneCount) ? paneCount : 0;
  if (count < max) return { allowed: true, max, reason: null };
  return {
    allowed: false,
    max,
    reason: `pane cap reached: ${count} live panes >= max ${max} `
      + `(WEZBRIDGE_MAX_PANES, default ${DEFAULT_MAX_PANES}). Close an idle pane or raise the cap explicitly.`,
  };
}

const VALID_AFFINITY_AGENTS = new Set(['claude', 'codex', 'shell']);

/**
 * Resolve project→{agent,model} affinity. Precedence: env WEZBRIDGE_AFFINITY=0
 * (disabled) > WEZBRIDGE_AFFINITY_JSON (inline map) > <intelDir>/affinity.json
 * > none. Keys starting with '_' are documentation, never projects. An agent
 * value outside claude|codex|shell is reported but flagged invalid so the
 * consumer falls back to its own default instead of failing the spawn.
 */
function resolveAffinity({ project, env = process.env, intelDir, readFile } = {}) {
  const none = (reason, source = 'none') => ({ agent: null, model: null, source, reason });
  if (!project) return none('no project name');
  if (env.WEZBRIDGE_AFFINITY === '0') return none('WEZBRIDGE_AFFINITY=0 (disabled)', 'env');

  let map = null;
  let source = null;
  if (env.WEZBRIDGE_AFFINITY_JSON) {
    try { map = JSON.parse(env.WEZBRIDGE_AFFINITY_JSON); source = 'env'; } catch { map = null; }
  }
  if (!map || typeof map !== 'object') {
    const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const file = path.join(intelDir || defaultIntelDir(env), 'affinity.json');
    try { map = JSON.parse(read(file)); source = 'file'; } catch { return none('no affinity config readable'); }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return none('affinity config is not an object', source);

  const wanted = String(project).trim().toLowerCase();
  let entry = null;
  for (const key of Object.keys(map)) {
    if (key.startsWith('_')) continue; // doc keys
    if (String(key).trim().toLowerCase() === wanted) { entry = map[key]; break; }
  }
  if (!entry || typeof entry !== 'object') return none(`no affinity for "${project}"`, source);

  const agentRaw = entry.agent ? String(entry.agent).trim().toLowerCase() : null;
  const agentValid = agentRaw !== null && VALID_AFFINITY_AGENTS.has(agentRaw);
  return {
    agent: agentValid ? agentRaw : null,
    model: entry.model ? String(entry.model).trim() : null,
    source,
    reason: agentRaw && !agentValid
      ? `affinity for "${project}" has invalid agent "${entry.agent}" (claude|codex|shell) — ignored`
      : `affinity for "${project}" (${source})`,
  };
}

/** lease = { owner, expires_at? }. Missing expires_at counts as active (held). */
function leaseActive(lease, now = Date.now()) {
  if (!lease || !lease.owner) return false;
  if (!lease.expires_at) return true;
  const t = new Date(lease.expires_at).getTime();
  return !Number.isFinite(t) || t > now;
}

/**
 * Scan <intelDir>/tasks/T-*.json for a state=running task whose lease is held
 * by `owner` (e.g. "pane-12") and not expired. Fail-soft: unreadable dir or
 * files → null (shadow logging accuracy only, never blocks anything).
 */
function findActiveLease({ owner, intelDir, env = process.env, now = Date.now() } = {}) {
  if (!owner) return null;
  const dir = path.join(intelDir || defaultIntelDir(env), 'tasks');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  for (const f of files) {
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!t || t.state !== 'running') continue;
    if (t.lease && String(t.lease.owner) === String(owner) && leaseActive(t.lease, now)) {
      return { task: t.id || f.replace(/\.json$/, ''), owner: t.lease.owner, expires_at: t.lease.expires_at || null };
    }
  }
  return null;
}

/**
 * PURE shadow decision: after a verified type=result delivery, would live
 * auto-close be allowed to close the sender's pane? Callers must treat
 * `close:true` as a LOG LINE ONLY — this module never kills and neither may
 * the caller from this verdict (WEZBRIDGE_AUTOCLOSE=live is future, unread).
 */
function decideAutoClose({ paneId, project, orchRepo = 'wezbridge', lease = null, verified = true, now = Date.now() } = {}) {
  if (!verified) {
    return { close: false, reason: 'result delivery not verified — an unconfirmed result must not retire its worker' };
  }
  if (project === null || project === undefined || String(project).trim() === '') {
    return { close: false, reason: `pane-${paneId} project unknown — fail-safe, no close proposed` };
  }
  if (String(project).trim().toLowerCase() === String(orchRepo).trim().toLowerCase()) {
    return { close: false, reason: `pane-${paneId} is the orchestrator pane (${orchRepo}) — excluded` };
  }
  if (leaseActive(lease, now)) {
    return { close: false, reason: `pane-${paneId} holds an active lease on ${lease.task || 'a running task'} (expires ${lease.expires_at || 'never'}) — excluded` };
  }
  return { close: true, reason: `worker pane-${paneId} (${project}) delivered a verified type=result and holds no lease — eligible for auto-close` };
}

module.exports = {
  DEFAULT_MAX_PANES,
  resolveMaxPanes,
  evaluateSpawnCap,
  resolveAffinity,
  leaseActive,
  findActiveLease,
  decideAutoClose,
};
