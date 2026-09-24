#!/usr/bin/env node
'use strict';
/**
 * automation-router.cjs — T-0598 Fase A. The ONE place a scheduled automation's
 * finding (see `src/automation-finding-schema.cjs`) turns into fleet work: at
 * most one ledger card per actionable finding (deduped by fingerprint, using
 * `_docs-curation/ledger.cjs create --origin <fingerprint>`, which is already
 * idempotent) plus one `a2a_send` to the owning lane (via `bin/a2a-send-cli.cjs`).
 * Non-actionable findings are logged only — never a card, never a send.
 * Key terms: runRouter, processFinding, loadState, saveState, quarantine.
 * Read when: wiring a new automation to the contract, or debugging why a
 * finding did/didn't produce a card.
 *
 * Usage:
 *   node scripts/automation-router.cjs [--dir <findings-dir>] [--file <path>]
 *     [--ledger-cli <path>] [--a2a-cli <path>] [--state-file <path>]
 *
 * Safe to run every 15 min (Task Scheduler, Fase B) or once at the end of a
 * single automation's run (`--file <path>`). Never deletes a finding: a fully
 * delivered finding moves to `<dir>/processed/`; a bad one moves to
 * `<dir>/quarantine/`; an actionable finding whose a2a send failed stays in
 * place so the NEXT run retries the send (state file remembers the card id,
 * so retrying never creates a second card).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateFinding, computeFingerprint } = require('../src/automation-finding-schema.cjs');

const DEFAULT_LEDGER_CLI = path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const DEFAULT_A2A_CLI = path.join(__dirname, '..', 'bin', 'a2a-send-cli.cjs');
const DEFAULT_INTEL_DIR = process.env.WEZBRIDGE_INTEL_DIR || path.join(__dirname, '..', '..', '_intel');
const DEFAULT_FINDINGS_DIR = path.join(DEFAULT_INTEL_DIR, 'automation-findings');

/** Maps a finding's optional `kind` (or a default) to a ledger `--kind`. Closed
 * to the fleet-wide kind vocabulary (`_intel/kinds.json`); anything not listed
 * here falls back to `general`, the safe default the ledger itself resolves
 * unknown kinds to. Documented in docs/operations.md next to the contract. */
const KIND_MAP = {
  bug: 'test-repair',
  incident: 'general',
  observability: 'observability',
  docs: 'docs',
};

function resolveKind(finding) {
  if (finding.kind && KIND_MAP[finding.kind]) return KIND_MAP[finding.kind];
  if (finding.kind) return finding.kind; // caller-provided, ledger's own vocabulary gate applies
  return 'general';
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function appendLog(dir, file, record) {
  ensureDir(dir);
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
}

function loadState(stateFile) {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return { fingerprints: {} }; }
}

function saveState(stateFile, state) {
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function moveTo(file, destDir) {
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(file));
  fs.renameSync(file, dest);
  return dest;
}

function runLedgerCreate({ ledgerCli, finding, fingerprint, env }) {
  const args = [
    ledgerCli, 'create',
    '--title', `[automation] ${finding.task}: ${finding.summary}`.slice(0, 200),
    '--goal', finding.summary,
    '--criterion', finding.evidence,
    '--repo', finding.repo_owner,
    '--kind', resolveKind(finding),
    '--state', 'ready',
    '--blocked-by', 'agent',
    '--origin', fingerprint,
    '--corr', fingerprint,
  ];
  const stdout = execFileSync(process.execPath, args, { env, encoding: 'utf8' });
  const task = JSON.parse(stdout);
  return task.id;
}

function runA2ASend({
  a2aCli, finding, cardId, env, fromPane,
}) {
  const args = [
    a2aCli,
    '--to-project', finding.repo_owner,
    '--type', 'request',
    '--corr', cardId,
    '--body', `Automation finding [${cardId}] ${finding.task}: ${finding.summary} (severity=${finding.severity})`,
  ];
  // A scheduled router run has no live WezTerm pane of its own, so a2a_send
  // cannot prove identity via the census — an explicit --from-pane is
  // required. WEZBRIDGE_AUTOMATION_FROM_PANE lets Fase B's Task Scheduler
  // registration pin the automation's own dedicated pane/handle identity;
  // tests inject one via `fromPane`.
  const resolvedFromPane = fromPane ?? (env && env.WEZBRIDGE_AUTOMATION_FROM_PANE);
  if (resolvedFromPane !== undefined && resolvedFromPane !== null && resolvedFromPane !== '') {
    args.push('--from-pane', String(resolvedFromPane));
  }
  let stdout = '';
  let ok = false;
  try {
    stdout = execFileSync(process.execPath, args, { env, encoding: 'utf8' });
    // a2a-send-cli prints ONE JSON value (pretty-printed, so it can span many
    // lines) followed by a trailing newline — parse the whole trimmed output,
    // not just its last line.
    const payload = JSON.parse(stdout.trim());
    ok = Boolean(payload.ok || payload.queued);
  } catch (err) {
    stdout = (err.stdout ? err.stdout.toString() : '') || err.message;
    ok = false;
  }
  return { ok, stdout };
}

/**
 * Processes ONE finding file. Returns a result object describing what
 * happened, for tests and for the summary the CLI prints.
 */
function processFinding(filePath, opts) {
  const {
    findingsDir, ledgerCli, a2aCli, stateFile, env, fromPane,
  } = opts;
  const quarantineDir = path.join(findingsDir, 'quarantine');
  const processedDir = path.join(findingsDir, 'processed');

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    appendLog(findingsDir, 'router-log.jsonl', {
      file: path.basename(filePath), outcome: 'quarantined', reason: `invalid JSON: ${err.message}`,
    });
    moveTo(filePath, quarantineDir);
    return { outcome: 'quarantined', file: filePath };
  }

  const validated = validateFinding(raw);
  if (!validated.ok) {
    appendLog(findingsDir, 'router-log.jsonl', {
      file: path.basename(filePath), outcome: 'quarantined', reason: validated.errors.join('; '),
    });
    moveTo(filePath, quarantineDir);
    return { outcome: 'quarantined', file: filePath, errors: validated.errors };
  }
  const finding = validated.finding;

  if (finding.actionable === false) {
    appendLog(findingsDir, 'non-actionable.jsonl', {
      task: finding.task, repo_owner: finding.repo_owner, summary: finding.summary,
    });
    moveTo(filePath, processedDir);
    return { outcome: 'non-actionable', file: filePath };
  }

  const fingerprint = computeFingerprint(finding);
  const state = loadState(stateFile);
  state.fingerprints = state.fingerprints || {};
  let entry = state.fingerprints[fingerprint];

  if (!entry) {
    const cardId = runLedgerCreate({ ledgerCli, finding, fingerprint, env });
    entry = { cardId, delivered: false, task: finding.task, repo_owner: finding.repo_owner };
    state.fingerprints[fingerprint] = entry;
    saveState(stateFile, state);
    appendLog(findingsDir, 'router-log.jsonl', {
      file: path.basename(filePath), outcome: 'card-created', card_id: cardId, fingerprint,
    });
  }

  if (!entry.delivered) {
    const { ok, stdout } = runA2ASend({
      a2aCli, finding, cardId: entry.cardId, env, fromPane,
    });
    if (ok) {
      entry.delivered = true;
      state.fingerprints[fingerprint] = entry;
      saveState(stateFile, state);
      appendLog(findingsDir, 'router-log.jsonl', {
        file: path.basename(filePath), outcome: 'delivered', card_id: entry.cardId, fingerprint,
      });
      moveTo(filePath, processedDir);
      return { outcome: 'delivered', file: filePath, cardId: entry.cardId, fingerprint };
    }
    appendLog(findingsDir, 'router-log.jsonl', {
      file: path.basename(filePath), outcome: 'send-failed', card_id: entry.cardId, fingerprint, detail: stdout,
    });
    return {
      outcome: 'send-failed', file: filePath, cardId: entry.cardId, fingerprint,
    };
  }

  // Already delivered in a prior run but file wasn't moved (shouldn't normally
  // happen — delivered findings are moved immediately) — move it now.
  moveTo(filePath, processedDir);
  return { outcome: 'already-delivered', file: filePath, cardId: entry.cardId, fingerprint };
}

function listFindingFiles(findingsDir) {
  if (!fs.existsSync(findingsDir)) return [];
  return fs.readdirSync(findingsDir)
    .filter((name) => name.endsWith('.json') && name !== '.router-state.json')
    .map((name) => path.join(findingsDir, name))
    .filter((p) => fs.statSync(p).isFile());
}

function runRouter(opts = {}) {
  const findingsDir = opts.findingsDir || DEFAULT_FINDINGS_DIR;
  const ledgerCli = opts.ledgerCli || DEFAULT_LEDGER_CLI;
  const a2aCli = opts.a2aCli || DEFAULT_A2A_CLI;
  const stateFile = opts.stateFile || path.join(findingsDir, '.router-state.json');
  const env = opts.env || process.env;

  const files = opts.file ? [opts.file] : listFindingFiles(findingsDir);
  const results = files.map((f) => processFinding(f, {
    findingsDir, ledgerCli, a2aCli, stateFile, env, fromPane: opts.fromPane,
  }));
  return {
    results,
    counts: results.reduce((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] || 0) + 1;
      return acc;
    }, {}),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--dir': out.findingsDir = next(); break;
      case '--file': out.file = next(); break;
      case '--ledger-cli': out.ledgerCli = next(); break;
      case '--a2a-cli': out.a2aCli = next(); break;
      case '--state-file': out.stateFile = next(); break;
      case '--from-pane': out.fromPane = next(); break;
      default:
        process.stderr.write(`automation-router: unknown argument ${a}\n`);
        process.exit(2);
    }
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const { counts } = runRouter(opts);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

module.exports = {
  runRouter, processFinding, resolveKind, KIND_MAP, DEFAULT_FINDINGS_DIR, DEFAULT_LEDGER_CLI, DEFAULT_A2A_CLI,
};
