#!/usr/bin/env node
'use strict';
/**
 * dispatch-scheduled-prompt.cjs — durable, OS-scheduled prompt dispatcher.
 *
 * Why this exists: ScheduleWakeup is SESSION-BOUND (dies with the session, max
 * ~1h delay) and CronCreate is session-scoped too, so neither can fire a task
 * a day out. Windows Task Scheduler can. This script is what the OS task runs:
 * it re-discovers a live target pane AT TRIGGER TIME (pane ids are unstable —
 * they renumber when panes close), falls back to spawning a fresh session, and
 * sends a stored prompt payload.
 *
 * Usage:
 *   node dispatch-scheduled-prompt.cjs --spec <path-to-spec.json>
 *
 * Spec shape:
 *   {
 *     "name": "pedrito-stock-canary-20260729",
 *     "agent": "codex",                       // codex | claude
 *     "project": "pedrito",                   // matched against pane cwd basename
 *     "preferPaneId": 13,                     // optional hint, verified before use
 *     "cwdCandidates": ["G:\\tmp\\pedrito-branch-bridge", "G:\\...\\pedrito"],
 *     "promptFile": "<path>.txt",             // exact payload, verbatim
 *     "oneShot": true                         // log + refuse a second run
 *   }
 *
 * Every run appends a JSON line to <intel>/scheduled-dispatch.jsonl. One-shot
 * enforcement is by that log: if a completed run for this spec name exists,
 * the script exits without dispatching (idempotent against double-triggers).
 */
const fs = require('node:fs');
const path = require('node:path');

const wez = require(path.join(__dirname, '..', 'src', 'wezterm.cjs'));
const discovery = require(path.join(__dirname, '..', 'src', 'pane-discovery.cjs'));

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
}
const LOG = () => path.join(intelDir(), 'scheduled-dispatch.jsonl');

function logLine(obj) {
  try {
    fs.mkdirSync(intelDir(), { recursive: true });
    fs.appendFileSync(LOG(), JSON.stringify({ time: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* fail-soft: never let logging block the dispatch */ }
}

/**
 * The occurrence a run belongs to — local calendar date, YYYY-MM-DD.
 *
 * v1 keyed one-shot purely on "has this spec EVER dispatched", which cannot tell
 * a rehearsal from the real firing. On 2026-07-28 a manual test consumed the
 * single allowed dispatch and the genuine 2026-07-29 11:45 run would have logged
 * `skipped` and sent nothing — a test silently cancelling the thing it tested.
 * Keying on the OCCURRENCE means a rehearsal today cannot suppress tomorrow.
 */
function occurrenceOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function alreadyDispatched(name, occurrence) {
  try {
    for (const line of fs.readFileSync(LOG(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.spec !== name || r.status !== 'dispatched') continue;
      // Legacy lines carry no occurrence. Treat them as belonging to the day
      // they were written, so old entries stay honest instead of matching
      // every future run.
      const ran = r.occurrence || (r.time ? occurrenceOf(new Date(r.time)) : null);
      if (ran === occurrence) return r;
    }
  } catch { /* no log yet */ }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const basename = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';

/** Find a live pane for the project, preferring the hinted id if it still matches. */
async function findTargetPane(spec) {
  let panes = [];
  try { panes = await discovery.discoverPanes(); } catch (e) { return { pane: null, why: `discovery failed: ${e.message}` }; }
  const wanted = String(spec.project).toLowerCase();
  const matches = panes.filter((p) => basename(p.project).toLowerCase() === wanted
    && (!spec.agent || p.agent === spec.agent || p.agent === null));
  if (spec.preferPaneId !== undefined) {
    const hinted = matches.find((p) => p.paneId === spec.preferPaneId);
    if (hinted) return { pane: hinted, why: `hinted pane ${spec.preferPaneId} still matches project+agent` };
  }
  if (matches.length) return { pane: matches[0], why: `hint stale/absent; using live match pane ${matches[0].paneId}` };
  return { pane: null, why: 'no live pane for project' };
}

/** Spawn a fresh session in the first cwd candidate that exists. */
async function spawnFallback(spec) {
  const cwd = (spec.cwdCandidates || []).find((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } });
  if (!cwd) throw new Error(`no cwdCandidates exist: ${JSON.stringify(spec.cwdCandidates)}`);
  const program = spec.agent === 'claude' ? 'claude' : 'codex';
  const spawned = wez.spawnPane({ cwd });
  const paneId = typeof spawned === 'object' ? (spawned.paneId ?? spawned.pane_id) : spawned;
  await sleep(3000);                       // let the shell come up
  wez.sendText(paneId, `${program}\r`);
  await sleep(12000);                      // agent boot (codex is slow to accept input)
  return { paneId, cwd, program };
}

async function main() {
  const specPath = process.argv[process.argv.indexOf('--spec') + 1];
  if (!specPath) throw new Error('usage: --spec <path>');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const prompt = fs.readFileSync(spec.promptFile, 'utf8').replace(/\s+$/, '');

  if (spec.oneShot) {
    const prior = alreadyDispatched(spec.name, occurrenceOf());
    if (prior) { logLine({ spec: spec.name, status: 'skipped', reason: `one-shot already dispatched at ${prior.time}` }); return; }
  }

  let target = await findTargetPane(spec);
  let spawnedInfo = null;
  if (!target.pane) {
    spawnedInfo = await spawnFallback(spec);
    target = { pane: { paneId: spawnedInfo.paneId }, why: `spawned fresh ${spawnedInfo.program} in ${spawnedInfo.cwd}` };
  }

  // Bracketed paste keeps multi-line prompts intact; Enter is sent separately
  // (documented wezterm splice bug on combined send).
  wez.sendTextBracketed(target.pane.paneId, prompt);
  await sleep(600);
  wez.sendTextNoEnter(target.pane.paneId, '\r');

  logLine({
    spec: spec.name, status: 'dispatched', occurrence: occurrenceOf(), pane_id: target.pane.paneId,
    resolution: target.why, spawned: Boolean(spawnedInfo), prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
  });
  process.stdout.write(`dispatched ${spec.name} -> pane ${target.pane.paneId} (${target.why})\n`);
}

main().catch((e) => {
  logLine({ spec: 'unknown', status: 'error', error: String(e && e.message).slice(0, 300) });
  process.stderr.write(`dispatch failed: ${e && e.message}\n`);
  process.exit(1);
});
