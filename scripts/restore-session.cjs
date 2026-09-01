#!/usr/bin/env node
'use strict';
/**
 * restore-session.cjs — Re-spawn AI panes from the most recent session snapshot.
 *
 * Usage:
 *   node scripts/restore-session.cjs [--dry-run] [--stagger-ms N] [--filter regex]
 *
 * Options:
 *   --dry-run        Print what would be spawned, don't actually spawn.
 *   --stagger-ms N   Wait N ms between spawns (default 2000) — keeps the
 *                    telegram channel-plugin race in check when restoring
 *                    multiple --channels panes.
 *   --filter REGEX   Only restore entries whose cwd OR cmdline matches REGEX.
 *
 * Read latest snapshot from vault/_wezbridge/session-snapshot.jsonl
 * (or path passed via WEZBRIDGE_SESSION_SNAPSHOT_LOG env var). For each
 * entry, run `wezterm cli spawn --cwd <cwd> -- <cmdline parts>`.
 *
 * Prerequisite: WezTerm must be running (mux alive). If wezterm crashed,
 * start a single new wezterm pane manually first, then run this script
 * from inside it — the new panes will be added as additional tabs.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const snap = require(path.resolve(__dirname, '..', 'src', 'session-snapshot.cjs'));

function parseArgs(argv) {
  const out = { dryRun: false, staggerMs: 2000, filter: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--stagger-ms') out.staggerMs = parseInt(argv[++i], 10) || 2000;
    else if (a === '--filter') out.filter = new RegExp(argv[++i]);
  }
  return out;
}

function splitCmdline(cmdline) {
  if (!cmdline) return [];
  // Naive splitter — handles quoted args. Good enough for claude/codex
  // launches which are space-separated with no shell metacharacters.
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmdline.length; i++) {
    const c = cmdline[i];
    if (q) {
      if (c === q) { q = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ' ' || c === '\t') {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function normalizeSnapshotCwd(value) {
  if (!value) return '';
  let cwd = value;
  if (/^file:/i.test(value)) {
    try { cwd = decodeURIComponent(new URL(value).pathname); }
    catch { cwd = decodeURIComponent(value.replace(/^file:\/\/[^/]*/i, '')); }
  }
  if (process.platform === 'win32' && /^\/[a-z]:\//i.test(cwd)) cwd = cwd.slice(1);
  return process.platform === 'win32' ? cwd.replaceAll('/', '\\') : cwd;
}

// The resume command per agent. Snapshots capture ai via title/discovery hint
// and usually have a null cmdline (headless pid unknown), so we reconstruct the
// launch from `ai` rather than replaying a captured process line.
//
// Codex: NEVER pin to an exact session id — codex resume <uuid> is fragile (a
// corrupt/oversized session kills the pane, e.g. pedrito 2026-07-15). Use
// `codex resume --yolo`: full-access (bypass approvals/sandbox) and codex picks
// the right session for the pane's cwd (its picker defaults to the Cwd filter).
function resumeCommandFor(ai) {
  if (ai === 'codex') return 'codex resume --yolo';
  return 'claude --continue --dangerously-skip-permissions';       // default: claude
}

/**
 * ¿El pane sigue vivo unos segundos despues de crearlo?
 *
 * MEDIDO EL 2026-08-30, y por eso existe: tras un crash real este script
 * reporto "9/9 spawned successfully" y los NUEVE murieron. `wezterm cli spawn`
 * devuelve un pane id apenas crea el pane, ANTES de que el programa de adentro
 * viva o muera — asi que tomar ese id como exito es contar la intencion, no el
 * resultado. Es exactamente la clase de defecto que este repo viene cazando:
 * un instrumento que reporta algo cierto (el pane se creo) y lo presenta como
 * otra cosa (el agente esta corriendo).
 *
 * Un pane muerto queda listado con titulo "wezterm" y sin CWD, mostrando
 * `Process "<x>" didn't exit cleanly`.
 */
function paneStillAlive(paneId) {
  const res = spawnSync('wezterm', ['cli', '--no-auto-start', 'list'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null; // no se pudo medir: no afirmar nada
  const line = (res.stdout || '').split('\n').find((l) => new RegExp(`\\s${paneId}\\s`).test(l));
  if (!line) return false;                       // el pane desaparecio
  return !/\swezterm\s*$/.test(line.trimEnd());  // titulo "wezterm" pelado = el programa murio
}

function spawnPane(entry, opts = {}) {
  const cwd = normalizeSnapshotCwd(entry.cwd);
  const parts = splitCmdline(entry.cmdline);

  // WINDOWS: `claude` y `codex` son shims .cmd/.ps1, no ejecutables. Pasarlos
  // como programa del pane (`spawn -- claude`) los hace salir con codigo 1 al
  // instante. El camino que SI funciona es spawnear el shell por defecto y
  // TIPEAR el comando, que es lo que hace el Path B. Medido el 2026-08-30
  // restaurando 13 panes tras un crash: Path A murio 9 de 9, Path B anduvo.
  const forceShellPath = process.platform === 'win32';

  // Path A: a real captured cmdline → replay it verbatim (legacy snapshots).
  if (parts.length > 0 && !forceShellPath) {
    const args = ['cli', '--no-auto-start', 'spawn'];
    if (cwd) args.push('--cwd', cwd);
    args.push('--', ...parts);
    if (opts.dryRun) { console.log(`[dry-run] wezterm ${args.join(' ')}`); return true; }
    const res = spawnSync('wezterm', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      console.error(`[restore] failed pane ${entry.pane_id}: ${res.error ? res.error.message : 'exit ' + res.status + ' ' + (res.stderr || '').trim()}`);
      return false;
    }
    console.log(`[restore] spawned ${entry.ai} pane (was ${entry.pane_id}, now ${(res.stdout || '').trim()}) cwd=${cwd}`);
    return true;
  }

  // Path B: no cmdline → spawn a shell, then type the agent's resume command.
  const cmd = resumeCommandFor(entry.ai);
  if (opts.dryRun) { console.log(`[dry-run] spawn shell @ ${cwd} → "${cmd}"`); return true; }
  const spawnArgs = ['cli', '--no-auto-start', 'spawn'];
  if (cwd) spawnArgs.push('--cwd', cwd);
  const res = spawnSync('wezterm', spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    console.error(`[restore] failed pane ${entry.pane_id}: ${res.error ? res.error.message : 'exit ' + res.status}`);
    return false;
  }
  const newPaneId = (res.stdout || '').trim();

  // El pane necesita que su shell arranque antes de poder recibir texto. Sin
  // esta espera el send-text llega a un pane que todavia no lee stdin y se
  // pierde en silencio — el pane queda vivo pero vacio, que se ve igual que un
  // exito hasta que alguien lo mira.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)'], { stdio: 'ignore' });

  spawnSync('wezterm', ['cli', '--no-auto-start', 'send-text', '--pane-id', newPaneId, '--no-paste'], { input: cmd + '\r', encoding: 'utf8' });

  // VERIFICAR, no afirmar. Ver el comentario de paneStillAlive.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { stdio: 'ignore' });
  const alive = paneStillAlive(newPaneId);
  if (alive === false) {
    console.error(`[restore] MURIO pane ${newPaneId} (era ${entry.pane_id}) cwd=${cwd} — el proceso salio al arrancar; NO cuenta como restaurado`);
    return false;
  }
  const nota = alive === null ? ' (no se pudo verificar: wezterm cli list fallo)' : '';
  console.log(`[restore] spawned ${entry.ai || 'shell'} pane (was ${entry.pane_id}, now ${newPaneId}) cwd=${cwd} → ${cmd}${nota}`);
  return true;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * T-0234 (half 2): never restore a cwd whose agent is ALREADY live — spawning
 * `claude --continue` into the cwd of a running session creates a SECOND
 * process on the same conversation file (the corruption class of mm-99c4;
 * happened twice on 2026-08-24, panes 6 and 8 duplicating the orchestrator).
 * Pure: takes the snapshot entries and the live census, returns {keep, skipped}.
 */
function excludeAlreadyLive(entries, livePanes) {
  const identity = require(path.resolve(__dirname, '..', 'src', 'pane-identity.cjs'));
  const liveKeys = new Set();
  for (const p of livePanes || []) {
    const proj = identity.projectFromCwd(p.cwd || p.project || '');
    const agent = p.agent || p.ai || null;
    if (proj && agent) liveKeys.add(`${agent}:${proj.toLowerCase()}`);
  }
  const keep = [];
  const skipped = [];
  for (const e of entries) {
    const proj = identity.projectFromCwd(e.cwd || '');
    const key = proj && e.ai ? `${e.ai}:${proj.toLowerCase()}` : null;
    if (key && liveKeys.has(key)) skipped.push(e);
    else keep.push(e);
  }
  return { keep, skipped };
}

function discoverLivePanes() {
  try {
    const discovery = require(path.resolve(__dirname, '..', 'src', 'pane-discovery.cjs'));
    return discovery.discoverPanes()
      .filter((p) => p.agent)
      .map((p) => ({ cwd: p.project, agent: p.agent }));
  } catch {
    // Census down (mux busy) → no exclusions. Restoring a duplicate is worse
    // than restoring nothing, but blocking ALL restore on a flaky census is
    // worse still — the operator sees each spawn line and can kill extras.
    return [];
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logPath = process.env.WEZBRIDGE_SESSION_SNAPSHOT_LOG || undefined;
  // T-0234: richest recent group, NOT the latest — the first post-crash tick
  // holds only the pane the operator already revived, and restoring that group
  // both skips the fleet and duplicates the live session.
  const entries = snap.readRichestRecentSnapshot({ logPath });
  if (entries.length === 0) {
    console.error('[restore] no snapshot found. Has the session-snapshot daemon ever run?');
    console.error(`[restore]   expected: ${logPath || snap.DEFAULT_LOG}`);
    process.exit(1);
  }
  const { keep, skipped } = excludeAlreadyLive(entries, discoverLivePanes());
  for (const s of skipped) {
    console.log(`[restore] SKIP ${s.ai} @ ${s.cwd} — that agent is already live in this cwd (duplicate --continue is the mm-99c4 corruption class)`);
  }
  const filtered = opts.filter
    ? keep.filter((e) => opts.filter.test(e.cwd || '') || opts.filter.test(e.cmdline || ''))
    : keep;

  console.log(`[restore] richest recent snapshot ts=${entries[0].snapshot_ts} (${entries.length} panes), ${filtered.length} to restore, ${skipped.length} already live`);
  if (opts.dryRun) console.log('[restore] DRY RUN — no panes will be spawned');

  let ok = 0;
  for (let i = 0; i < filtered.length; i++) {
    const e = filtered[i];
    if (spawnPane(e, opts)) ok++;
    if (i < filtered.length - 1 && opts.staggerMs > 0 && !opts.dryRun) {
      await sleep(opts.staggerMs);
    }
  }
  console.log(`[restore] done. ${ok}/${filtered.length} spawned successfully.`);
  process.exit(ok === filtered.length ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[restore] fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, splitCmdline, normalizeSnapshotCwd, excludeAlreadyLive };
