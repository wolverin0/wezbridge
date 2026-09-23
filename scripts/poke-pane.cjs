#!/usr/bin/env node
/**
 * poke-pane — send text to a pane, resolved BY PROJECT, from a scheduled task.
 *
 * There is no model in this path. Finding the pane that owns a project and
 * typing into it is a deterministic transform, so it is plain code: no MCP, no
 * `claude -p`, no API call, nothing to rate-limit and nothing to hallucinate.
 *
 *   node scripts/poke-pane.cjs --project brlite --text "do the thing"
 *   node scripts/poke-pane.cjs --project brlite --file msg.txt
 *   node scripts/poke-pane.cjs --project brlite --text "..." --dry-run
 *   node scripts/poke-pane.cjs --project brlite --text "<long>" --allow-long
 *
 * WHY BY PROJECT AND NOT BY PANE ID: pane ids are reused and reassigned. A
 * scheduled job holding a stored id eventually poked a completely unrelated
 * project (2026-08-12: a whatsappbot job landed in the brlite lane). Resolution
 * happens at fire time, every time.
 *
 * AMBIGUITY IS A FAILURE, NOT A COIN FLIP: if two panes match the project, this
 * exits non-zero and names both rather than guessing. Guessing is how the wrong
 * agent gets a payment-adjacent task.
 *
 * Exit codes:  0 submitted · 2 bad usage · 3 wezterm unreachable · 4 no match ·
 *              5 ambiguous · 6 send failed · 7 submit remained stuck ·
 *              8 composer unreadable · 9 paste did not land as ONE prompt (Enter NOT sent) ·
 *              10 composer already held someone else's unsent text (nothing written) ·
 *              11 --role: no valid registry for that role (missing, pane dead, cwd changed, pid dead, ambiguous)
 *              12 attempt audit unavailable; no terminal write performed ·
 *              13 payload over the measured ceiling (src/poke-payload-ceiling.cjs) — refused before trying, use --allow-long
 *
 * T-0473 (2026-09-23): FAIL(9) used to leave its own residue "for the operator"
 * and claim a keystroke was needed to clear it — FALSE (measured: a single
 * Ctrl+C clears it, session intact). It now Ctrl+C's its OWN residue and
 * VERIFIES the composer is empty before exiting 9, but ONLY when what's
 * showing is provably a fragment of the payload THIS RUN just wrote
 * (composerStillHolds against `payload`) — text this run cannot prove it wrote
 * is left untouched (T-0242/T-0323: exit 10 still refuses without writing).
 * T-0469: attempted/failed/submitted metadata uses the existing actions.jsonl.
 * Full bodies are not logged; hash + corr + attempt UUID join retry observations.
 * A final audit failure is loud but does not turn a sent prompt into a replay request.
 *
 * --role <r> (T-0322): resolve by the per-session registry a SessionStart hook
 * writes (~/.local/share/wezterm/panes/<mux pane id>.json, src/pane-registry.cjs),
 * validated against the mux listing (pane exists, cwd matches, pid alive).
 * Fails closed with the cause; stale registries of dead panes are cleaned up.
 *
 * DELIVERY (T-0303, 2026-09-02): the payload goes in as a BRACKETED PASTE and the
 * Enter is a SEPARATE write. The previous `--no-paste` typed the payload as raw
 * keys, so every `\n` was a SUBMIT: a 3-line envelope arrived as 3 prompts plus
 * an empty one (reproduced against a TUI double), and the verifier still said
 * VERIFIED because it only compared the composer against the payload's HEAD
 * while fragmentation only ever leaves the TAIL. Now: integrity is checked
 * BEFORE Enter (composer must show the head, or a collapsed paste), the
 * verifier lives in composer-state.cjs and also sees tails/fragments/borders.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pokeCeilingWarning } = require('../src/poke-payload-ceiling.cjs');

const WEZTERM = process.env.WEZTERM_BIN || 'wezterm';
let auditState = null;

function auditPoke(outcome, code) {
  if (!auditState) return true;
  const { text: body, pane, project: destination, attempt } = auditState;
  const header = body.split(']')[0];
  const corr = header.match(/\bcorr=([A-Za-z0-9_.:-]+)/)?.[1] || null;
  const ok = require('../src/action-log.cjs').logAction('pane_poke', {
    target: pane === null ? '' : `pane-${pane}`, project: destination, corr,
    why: 'manual/scheduled poke transport; not work acceptance',
    extra: { attempt_id: attempt, message_hash: require('node:crypto').createHash('sha256').update(body).digest('hex'),
      outcome, exit_code: code, transport: 'poke-pane' },
  });
  if (!ok) console.log('poke-pane AUDIT_FAILED: transport outcome not persisted; do not infer delivery or replay automatically');
  return ok;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);

function die(code, msg) {
  // One line, always, on every path. A scheduled job that fails silently is
  // indistinguishable from one that ran and found nothing to do — that is the
  // failure mode this whole script exists to avoid.
  console.log(`${new Date().toISOString()} poke-pane FAIL(${code}): ${msg}`);
  auditPoke('failed', code);
  process.exit(code);
}

const project = arg('project');
// --tab-title is the BEST selector for a machine that must find one specific
// pane: the operator names the tab (LEADER-free, just rename it) and the name
// is his, stable, and survives pane renumbering. Six panes currently share the
// cwd basename "whatsappbot-final"; exactly one is named "wabot".
const tabTitle = arg('tab-title');
// --role is the selector for machines (T-0322): the SESSION declared it at start
// (pane-register-hook.cjs), it does not depend on cwd nor on tab titles.
const role = arg('role');
const text = arg('file') ? fs.readFileSync(arg('file'), 'utf8') : arg('text');
if (require.main === module && !has('dry-run')) {
  auditState = { text: text || '', pane: null, project, attempt: require('node:crypto').randomUUID() };
  if (!auditPoke('attempted', null)) die(12, 'cannot record attempt; nothing written to terminal');
}
if (require.main === module && ((!project && !tabTitle && !role) || !text)) {
  die(2, 'usage: (--role <r> | --project <name> | --tab-title <exact-name> | combinations) (--text "..." | --file <path>) [--dry-run] [--allow-long]');
}

// T-0260 (2026-09-02): UN solo espacio de pane_id, el del mux. Medido: el mismo
// pane era 11 en `sock` y 4 en un gui-sock, y la GUI se reemplazo 17+ veces en
// un dia; resolver contra la GUI viva del minuto produjo 4 misroutes reales.
// `--prefer-mux` solo no alcanza si WEZTERM_UNIX_SOCKET apunta a un gui-sock,
// asi que el env del mux fija el socket y borra WEZTERM_PANE. Las GUIs quedan
// como fallback SOLO para una pane que no exista en el mux (spawneada fuera del
// dominio), y la salida lo dice.
const CLI_BASE = ['cli', '--prefer-mux', '--no-auto-start'];
const SOCKET_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'share', 'wezterm');
function muxEnvironment() {
  const env = { ...process.env };
  delete env.WEZTERM_PANE;
  // `sock` es un AF_UNIX socket: fs.existsSync dice false en Windows; readdirSync lo lista.
  let hasMux = false;
  try { hasMux = fs.readdirSync(SOCKET_DIR).includes('sock'); } catch { hasMux = false; }
  if (hasMux) env.WEZTERM_UNIX_SOCKET = path.join(SOCKET_DIR, 'sock');
  env._space = 'mux';
  return env;
}
function guiSocketEnvironments() {
  if (process.platform !== 'win32') return [];
  try {
    const tasks = execFileSync('tasklist', ['/fi', 'imagename eq wezterm-gui.exe', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const socketNames = new Set(fs.readdirSync(SOCKET_DIR));
    return [...tasks.matchAll(/"wezterm-gui\.exe","(\d+)"/gi)]
      .map((match) => `gui-sock-${match[1]}`)
      .filter((name) => socketNames.has(name))
      .map((name) => ({ ...process.env, WEZTERM_UNIX_SOCKET: path.join(SOCKET_DIR, name), _space: 'gui' }));
  } catch { return []; }
}
function liveSocketEnvironments() {
  if (process.env.WEZBRIDGE_PREFER_MUX === '0') return [...guiSocketEnvironments(), muxEnvironment()];
  return [muxEnvironment(), ...guiSocketEnvironments()];
}

/**
 * Elige el pane destino entre las filas listadas. Pura, para testearla.
 *  - --project: basename del cwd, igualdad case-insensitive.
 *  - --tab-title: igualdad EXACTA case-insensitive (T-0260 item 3: antes era
 *    substring, y "infra" matcheaba "infra-old"; la ambiguedad tiene que ser
 *    error, nunca "el primero").
 *  - Espacio: si hay matches en el mux, las filas de GUI se ignoran (son la
 *    misma pane con otro id); las filas de GUI solo cuentan cuando NINGUNA del
 *    mux matchea (pane gui-only).
 * Devuelve { matches, space }.
 */
function selectPane(list, { project = null, tabTitle = null } = {}) {
  const wantedProject = project ? String(project).toLowerCase() : null;
  const wantedTab = tabTitle ? String(tabTitle).trim().toLowerCase() : null;
  const seen = new Set();
  const all = [];
  for (const p of list) {
    const space = (p._socketEnv && p._socketEnv._space) || 'mux';
    const socketKey = `${(p._socketEnv && p._socketEnv.WEZTERM_UNIX_SOCKET) || 'default'}:${p.pane_id}`;
    if (seen.has(socketKey)) continue;
    seen.add(socketKey);
    const cwd = decodeURIComponent(String(p.cwd || '')).replace(/^file:\/\/[^/]*/, '');
    const name = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    if (wantedProject && name.toLowerCase() !== wantedProject) continue;
    if (wantedTab && String(p.tab_title || '').trim().toLowerCase() !== wantedTab) continue;
    all.push({ ...p, cwd, name, _space: space });
  }
  const mux = all.filter((m) => m._space === 'mux');
  if (mux.length) return { matches: mux, space: 'mux' };
  return { matches: all, space: all.length ? 'gui-only' : 'none' };
}

module.exports = { selectPane, CLI_BASE };
if (require.main !== module) return;

// ---------- resolve, at fire time, never from a stored id ----------
// `wezterm cli list` goes through the mux and keeps working when a per-GUI
// socket is unhappy, so it is the reliable half. Retry anyway: it ETIMEDOUTs
// under load (16 panes running test suites is enough).
let list = [];
let lastErr = '';
for (const socketEnv of liveSocketEnvironments()) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const panes = JSON.parse(execFileSync(WEZTERM, [...CLI_BASE, 'list', '--format', 'json'], {
        encoding: 'utf8', timeout: 20000, env: socketEnv, windowsHide: true,
      }));
      list.push(...panes.map((pane) => ({ ...pane, _socketEnv: socketEnv })));
      break;
    } catch (e) { lastErr = String(e.message || e).split('\n')[0]; }
  }
}
if (!list.length) die(3, `wezterm unreachable after 3 attempts: ${lastErr}`);

let { matches, space } = selectPane(list, { project, tabTitle });
if (role) {
  // Registry first, mux second: the role names a pane id; the mux confirms the
  // pane exists, its cwd matches and the session's pid is alive. Anything else
  // is a refusal with the cause — never a guess. --project / --tab-title, when
  // also given, stay as extra constraints on the resolved pane.
  const { resolveRole } = require('../src/pane-registry.cjs');
  const mux = list.filter((p) => ((p._socketEnv && p._socketEnv._space) || 'mux') === 'mux');
  const res = resolveRole(role, { list: mux.map((p) => ({ pane_id: p.pane_id, cwd: p.cwd })) });
  if (!res.ok) die(11, `--role ${role}: ${res.reason} — ${res.detail}`);
  matches = matches.filter((m) => Number(m.pane_id) === Number(res.paneId) && m._space === 'mux');
  if (!matches.length) die(11, `--role ${role}: registry says pane ${res.paneId} but it does not match ${project || tabTitle ? 'the extra --project/--tab-title constraint' : 'the mux listing'}`);
  space = 'mux';
}

const criteria = [project && `project "${project}"`, tabTitle && `tab-title "${tabTitle}" (exact)`].filter(Boolean).join(' + ');
if (!matches.length) die(4, `no pane matching ${criteria}`);
if (matches.length > 1) {
  die(5, `ambiguous — ${matches.length} panes match ${criteria} in space ${space}: ${
    matches.map((m) => `pane ${m.pane_id} (win${m.window_id}/tab${m.tab_id}, tab_title "${m.tab_title || ''}", "${(m.title || '').slice(0, 30)}")`).join(' | ')
  }. Refusing to guess.`);
}

const target = matches[0];
if (auditState) auditState = { ...auditState, pane: target.pane_id, project: target.name };
if (space === 'gui-only') {
  console.log(`${new Date().toISOString()} poke-pane NOTE: pane ${target.pane_id} exists only on a GUI socket (not in the mux): id is NOT in the canonical space`);
}
if (has('dry-run')) {
  console.log(`${new Date().toISOString()} poke-pane DRY-RUN: would send ${text.length} chars to pane ${target.pane_id} [${space}] (win${target.window_id}/tab${target.tab_id}, ${target.cwd})`);
  process.exit(0);
}

function sendViaStdin(paneId, payload, socketEnv, { noPaste = true } = {}) {
  const args = [...CLI_BASE, 'send-text', '--pane-id', String(paneId)];
  if (noPaste) args.push('--no-paste');
  execFileSync(WEZTERM, args, {
    input: payload,
    encoding: 'utf8',
    timeout: 20000,
    env: socketEnv,
    windowsHide: true,
  });
}

// ONE verifier, shared: composer-state.cjs (T-0303 — this file had a private copy).
const { composerStillHolds, pasteLandedIntact, composerContent } = require('./composer-state.cjs');
const { composerHoldsForeignText, operatorQuestionVisible } = require('../src/verified-send.cjs');
const readTail = () => execFileSync(
  WEZTERM,
  [...CLI_BASE, 'get-text', '--pane-id', String(target.pane_id), '--start-line', '-40'],
  { encoding: 'utf8', timeout: 20000, env: target._socketEnv, windowsHide: true },
);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- refuse to type over someone else's unsent text (T-0323 rule) ----------
// Fail-open if the pane cannot be read: a guard that cannot look cannot stop.
try {
  const before = readTail();
  if (operatorQuestionVisible(before)) {
    die(10, `pane ${target.pane_id} operator-question requires an operator response; nothing written`);
  }
  if (composerHoldsForeignText(before)) {
    die(10, `pane ${target.pane_id} composer already holds unsent text ${JSON.stringify(composerContent(before).slice(0, 80))} — nothing written; not this run's own text (T-0242/T-0323), so it is left alone rather than cleared`);
  }
} catch (e) {
  if (e && typeof e === 'object' && e.status === 10) process.exit(10);
}

// ---------- send: bracketed paste, then a SEPARATE Enter ----------
// The payload is a bracketed paste (no --no-paste): the composer takes it as ONE
// unit and its internal newlines stay soft. The CR is a separate --no-paste stdin
// write (a control char in argv can be swallowed on Windows before wezterm sees
// it), and it is only sent once the paste is seen to have landed intact.
// A single trailing newline (every --file ends with one) is dropped.
//
// ONE LINE ON THE WIRE (measured 2026-09-02 against a TUI double, Windows 10 /
// ConPTY): wezterm does not wrap the paste in bracketed-paste markers here even
// when the app enabled DECSET 2004, and the bytes arrive IDENTICAL with or
// without --no-paste — one chunk, newlines included. Whether that lands as one
// prompt then depends on the TUI's own burst heuristic (Ink/Claude Code has one;
// a crossterm TUI without bracketed paste treats every newline as Enter). So
// the only delivery that is one prompt on EVERY composer is a payload with no
// newline in it: internal newlines are flattened to " ⏎ " and the log SAYS so.
// Nothing is dropped; the reader sees where the lines were.
const trimmed = text.replace(/\r?\n$/, '');
const lineCount = trimmed.split(/\r?\n/).length;
const payload = trimmed.replace(/\s*\r?\n\s*/g, ' ⏎ ');
if (lineCount > 1) {
  console.log(`${new Date().toISOString()} poke-pane FLATTENED: ${lineCount} lines -> 1 line (${payload.length} chars) with " ⏎ " between them, so the composer takes it as ONE prompt on any TUI`);
}

// ---------- T-0473 AC5: measured ceiling, refuse before trying blind ----------
const ceilingWarning = pokeCeilingWarning(payload.length, has('allow-long'));
if (ceilingWarning) die(13, ceilingWarning);

try {
  sendViaStdin(target.pane_id, payload, target._socketEnv, { noPaste: false });
} catch (e) {
  die(6, `send to pane ${target.pane_id} failed: ${String(e.message || e).split('\n')[0]}`);
}

// ---------- integrity BEFORE Enter: did the paste land as one prompt? ----------
let landed = 'empty';
try {
  pause(700);
  landed = pasteLandedIntact(readTail(), payload);
} catch (e) {
  die(8, `composer verification unavailable for pane ${target.pane_id}: ${String(e.message || e).split('\n')[0]}`);
}
if (landed === 'fragmented') {
  // Enter here is exactly what fragments/hybridises the prompt.
  let shown = '';
  let afterTail = '';
  try { afterTail = readTail(); shown = composerContent(afterTail).slice(0, 80); } catch { /* best effort */ }
  // T-0473: self-clean OWN residue instead of leaving it "for the operator" — that
  // claim was FALSE (measured 15/09: a single Ctrl+C clears it, session intact,
  // Ctrl+U 0x15 is NOT bound). "Proof it wrote it": composerStillHolds is the same
  // predicate used above to detect the fragmentation itself — the composer was
  // confirmed clear of foreign text right before THIS run's own paste (the T-0323
  // guard above), so if what's showing now is a fragment of `payload`, only this
  // run's own bytes can have put it there and only this run may erase it. Anything
  // that fails that check is left untouched (T-0242/T-0323).
  let cleanupNote = ' — text left in composer, ownership unclear (no readable tail): needs a look';
  try {
    if (afterTail && composerStillHolds(afterTail, payload)) {
      sendViaStdin(target.pane_id, '\x03', target._socketEnv); // Ctrl+C: clears, never submits
      pause(500);
      cleanupNote = composerContent(readTail()) === ''
        ? ' — residue self-cleared (Ctrl+C) and verified empty; no operator action needed'
        : ' — residue self-clean attempted (Ctrl+C) but could not be verified empty; needs a look';
    } else if (afterTail) {
      cleanupNote = ' — residue left untouched: not provably this run\'s own payload (T-0242/T-0323)';
    }
  } catch (e) {
    cleanupNote = ` — residue self-clean failed: ${String(e.message || e).split('\n')[0]}`;
  }
  die(9, `paste did not land as ONE prompt in pane ${target.pane_id}: composer shows ${JSON.stringify(shown)} instead of the payload head — Enter NOT sent${cleanupNote}`);
}
if (landed === 'empty') {
  console.log(`${new Date().toISOString()} poke-pane NOTE: pane ${target.pane_id} has no readable composer line (shell or non-TUI): paste integrity unverified, submitting anyway`);
}
try {
  sendViaStdin(target.pane_id, '\r', target._socketEnv);
} catch (e) {
  die(6, `enter to pane ${target.pane_id} failed: ${String(e.message || e).split('\n')[0]}`);
}

// ---------- verify actual submission, not mere echo ----------
const verified = `VERIFIED (paste ${landed}, composer cleared)`;
try {
  pause(700);
  let tail = readTail();
  if (composerStillHolds(tail, payload)) {
    sendViaStdin(target.pane_id, '\r', target._socketEnv);
    pause(900);
    tail = readTail();
  }
  if (composerStillHolds(tail, payload)) {
    die(7, `prompt remained in pane ${target.pane_id} composer after two Enter writes`);
  }
} catch (e) {
  if (e && typeof e === 'object' && e.status === 7) process.exit(7);
  die(8, `composer verification unavailable for pane ${target.pane_id}: ${String(e.message || e).split('\n')[0]}`);
}

console.log(`${new Date().toISOString()} poke-pane OK: ${text.length} chars -> pane ${target.pane_id} (${target.name}, win${target.window_id}/tab${target.tab_id}) — ${verified}`);
auditPoke(landed === 'empty' ? 'unverified' : 'submitted', 0);
