#!/usr/bin/env node
'use strict';
/**
 * orch-ctx-check.cjs — the enforcement chain that retired pane-40 now applies
 * to the orchestrator itself (W3 of the 2026-08-16 workflow-hardening retro).
 *
 * The previous orchestrator ran ~40 hours to >84% context while enforcing
 * rotation discipline on every other pane. Nothing deterministic could say so.
 * This check reads the orch pane's Ctx% via pane-discovery on every
 * orchestrator-turn tick and reports through the EXISTING routine-audit
 * contract — a run record + findings artifact — so the steward-gate nags until
 * a rotation ruling appears. No new enforcement chain to rot separately.
 *
 * Verdicts, per the routine contract's honesty rules:
 *   - no orch pane found (or wezterm has no panes) -> clean. Vacuous but true:
 *     the subject is a LONG-RUNNING orchestrator session, which necessarily
 *     has a pane. No pane, no over-stay. Reporting void here would fire every
 *     2h all night with WezTerm closed — the wolf this repo keeps shooting.
 *   - discovery itself threw -> void. WezTerm may be wedged with a live,
 *     over-stayed pane invisible behind it; blindness must not read as calm.
 *   - orch pane found but Ctx% unparseable -> void, same reason.
 *   - Ctx% > threshold -> findings (`orchestrator-rotation-due`).
 */
const fs = require('node:fs');
const path = require('node:path');

const THRESHOLD = Number(process.env.WEZBRIDGE_ORCH_CTX_LIMIT) || 70;
const ORCH_TAB = process.env.WEZBRIDGE_ORCH_TAB || 'orch';
/** Matches the orchestrator-turn schedule; silence past 2h+grace = the tick died. */
const CADENCE_HOURS = 2;

const RUN_RECORD = 'run-orchestrator-rotation-wezbridge.json';
const FINDINGS_FILE = 'orchestrator-rotation-findings.json';

// ---------------------------------------------------------------------------
// PURE — testable without wezterm
// ---------------------------------------------------------------------------

/**
 * Judge the discovered panes. `panes` may be null to signal discovery failure.
 * Multiple orch-tabbed panes: the highest Ctx% wins — the check exists to catch
 * the worst over-stayer, and two panes answering to `orch` is itself a config
 * smell poke-pane already refuses to guess about.
 */
function evaluateCtx({ panes, threshold = THRESHOLD, tab = ORCH_TAB }) {
  if (!Array.isArray(panes)) {
    return { verdict: 'void', void_reason: 'pane discovery failed — wezterm unreachable or wedged; an over-stayed orch pane could be invisible behind this' };
  }
  const orch = panes.filter((p) => p && p.tabTitle === tab && p.isClaude);
  if (!orch.length) return { verdict: 'clean', note: 'no orch pane running' };
  const ctxs = orch.map((p) => p.ctx).filter(Number.isFinite);
  if (!ctxs.length) {
    return { verdict: 'void', void_reason: 'orch pane present but Ctx% not parseable from its status bar' };
  }
  const pct = Math.max(...ctxs);
  if (pct > threshold) {
    return {
      verdict: 'findings',
      pct,
      survived: [{
        title: `orchestrator-rotation-due: orch pane at ${pct}% context (threshold ${threshold}%) — write the handoff and rotate per _intel/ORCHESTRATOR.md`,
      }],
    };
  }
  return { verdict: 'clean', pct };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
}

/** Write the routine-contract pair. Stable names: each tick overwrites the last. */
function writeRecord(result, dir = path.join(intelDir(), 'routine-findings')) {
  fs.mkdirSync(dir, { recursive: true });
  const findings = { verdict: result.verdict };
  if (result.void_reason) findings.void_reason = result.void_reason;
  if (result.survived) findings.survived = result.survived;
  fs.writeFileSync(path.join(dir, FINDINGS_FILE), JSON.stringify(findings, null, 2));
  fs.writeFileSync(path.join(dir, RUN_RECORD), JSON.stringify({
    routine: 'orchestrator-rotation',
    repo: 'wezbridge',
    exit_status: 0,
    cadence_hours: CADENCE_HOURS,
    findings_file: FINDINGS_FILE,
  }, null, 2));
}

/** The whole check. Discovery errors become a void verdict, never a throw. */
function runCtxCheck({ discover } = {}) {
  let panes = null;
  try {
    const discoverPanes = discover || require('../src/pane-discovery.cjs').discoverPanes;
    panes = discoverPanes();
  } catch { panes = null; }
  const result = evaluateCtx({ panes });
  writeRecord(result);
  return result;
}

module.exports = { evaluateCtx, runCtxCheck, writeRecord, THRESHOLD, CADENCE_HOURS, RUN_RECORD, FINDINGS_FILE };

if (require.main === module) {
  const r = runCtxCheck({});
  console.log(`orch-ctx-check: ${r.verdict}${Number.isFinite(r.pct) ? ` (${r.pct}%)` : ''}${r.void_reason ? ` — ${r.void_reason}` : ''}`);
}
