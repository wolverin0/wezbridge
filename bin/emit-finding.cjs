#!/usr/bin/env node
'use strict';
/**
 * emit-finding.cjs — T-0598 Fase A. One-liner for any automation to write a
 * valid finding JSON that `scripts/automation-router.cjs` will pick up on its
 * next 15-min pass. Exists so migrating an automation to the contract (Fase B:
 * curador WISP, DaemonSentinel, gmail-recordatorios) is one call at the end of
 * the automation's run instead of hand-rolled JSON.
 * Key terms: main, buildFinding.
 * Read when: wiring a new automation, or a PowerShell/Python caller that
 * needs the exact flag names.
 *
 * Usage:
 *   node bin/emit-finding.cjs --task <name> --repo <owner> --actionable true|false
 *     --summary "<text>" --evidence "<text>" [--severity low|medium|high|critical]
 *     [--kind <kind>] [--fingerprint <id>] [--out-dir <dir>]
 *
 * Writes <out-dir>/<task>-<YYYYMMDD-HHMMSS>.json and prints the path to stdout.
 * Default out-dir: WEZBRIDGE_INTEL_DIR/automation-findings (or ../../_intel/automation-findings).
 */
const fs = require('node:fs');
const path = require('node:path');
const { validateFinding } = require('../src/automation-finding-schema.cjs');

function parseArgs(argv) {
  const out = { severity: 'low' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--task': out.task = next(); break;
      case '--repo': out.repo_owner = next(); break;
      case '--actionable': out.actionable = next() === 'true'; break;
      case '--summary': out.summary = next(); break;
      case '--evidence': out.evidence = next(); break;
      case '--severity': out.severity = next(); break;
      case '--kind': out.kind = next(); break;
      case '--fingerprint': out.fingerprint = next(); break;
      case '--out-dir': out.outDir = next(); break;
      default:
        process.stderr.write(`emit-finding: unknown argument ${a}\n`);
        process.exit(2);
    }
  }
  return out;
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function buildFinding(args) {
  const finding = {
    task: args.task,
    repo_owner: args.repo_owner,
    actionable: args.actionable,
    summary: args.summary,
    evidence: args.evidence,
    severity: args.severity,
  };
  if (args.kind) finding.kind = args.kind;
  if (args.fingerprint) finding.fingerprint = args.fingerprint;
  return finding;
}

function main(argv = process.argv.slice(2), { outDirDefault } = {}) {
  const args = parseArgs(argv);
  const finding = buildFinding(args);
  const validated = validateFinding(finding);
  if (!validated.ok) {
    process.stderr.write(`emit-finding: invalid finding: ${validated.errors.join('; ')}\n`);
    return 2;
  }
  const outDir = args.outDir
    || outDirDefault
    || path.join(process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel'), 'automation-findings');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${finding.task}-${timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(finding, null, 2));
  process.stdout.write(`${file}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, buildFinding, parseArgs, timestamp };
