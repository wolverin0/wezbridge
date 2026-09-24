'use strict';
/**
 * automation-router.test.cjs — T-0598 Fase A. Proves the 6 cases the brief
 * requires for `scripts/automation-router.cjs`: actionable -> 1 card + 1
 * delivered send; same finding twice -> still 1 card; non-actionable -> 0
 * cards/0 sends + log; invalid file -> quarantine; missing repo_owner ->
 * quarantine; a2a failure -> card kept, retried next run, no duplicate card.
 * NEVER touches the real fleet ledger or sends a real a2a message: ledger
 * calls go through test/mocks/fake-ledger-cli.cjs, a2a calls go through the
 * REAL bin/a2a-send-cli.cjs pointed at the wezterm/orca mocks already used by
 * test/a2a-send-cli.test.cjs (sandboxed WEZBRIDGE_INTEL_DIR, no live pane).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runRouter } = require('../scripts/automation-router.cjs');

const FAKE_LEDGER = path.join(__dirname, 'mocks', 'fake-ledger-cli.cjs');
const A2A_CLI = path.join(__dirname, '..', 'bin', 'a2a-send-cli.cjs');
const WEZ_MOCK = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
const ORCA_MOCK = path.join(__dirname, 'mocks', 'orca-mock.cjs');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-router-'));
  const findingsDir = path.join(root, 'automation-findings');
  fs.mkdirSync(findingsDir, { recursive: true });
  const intel = path.join(root, '_intel');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  const orcaState = path.join(root, 'orca-state');
  fs.mkdirSync(orcaState, { recursive: true });
  return {
    root, findingsDir, intel, orcaState,
    stateFile: path.join(findingsDir, '.router-state.json'),
    ledgerDb: path.join(root, 'fake-ledger-db.json'),
    ledgerCallLog: path.join(root, 'fake-ledger-calls.jsonl'),
  };
}

function writeFinding(findingsDir, name, obj) {
  const file = path.join(findingsDir, `${name}.json`);
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return file;
}

function writeTerminals(root, terminals) {
  const f = path.join(root, 'orca-terminals.json');
  fs.writeFileSync(f, JSON.stringify(terminals));
  return f;
}

function writeRoster(intel, lanes) {
  fs.writeFileSync(path.join(intel, 'orchestrators.json'), JSON.stringify({ version: 1, lanes }));
}

function baseEnv({
  intel, orcaState, terminalsFile, ledgerDb, ledgerCallLog, extra = {},
}) {
  return {
    ...process.env,
    WEZBRIDGE_INTEL_DIR: intel,
    WEZBRIDGE_WEZTERM_BIN: WEZ_MOCK,
    WEZBRIDGE_SAFETY_OVERRIDE: '1',
    ORCA_CLI: ORCA_MOCK,
    ORCA_MOCK_STATE: orcaState,
    ORCA_MOCK_TERMINALS: terminalsFile,
    FAKE_LEDGER_DB: ledgerDb,
    FAKE_LEDGER_CALL_LOG: ledgerCallLog,
    ...extra,
  };
}

function actionableFinding(overrides = {}) {
  return {
    task: 'wisp-nocturnal-sweep',
    repo_owner: 'drillrepo',
    actionable: true,
    summary: 'RF drift detected on sector 12',
    evidence: 'kuma check #124 flapped 3x between 02:00-03:00 ART',
    severity: 'high',
    ...overrides,
  };
}

function ledgerCalls(ledgerCallLog) {
  if (!fs.existsSync(ledgerCallLog)) return [];
  return fs.readFileSync(ledgerCallLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('actionable finding -> exactly one ready card + one delivered a2a send', () => {
  const s = sandbox();
  try {
    writeRoster(s.intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }]);
    const terminalsFile = writeTerminals(s.root, [
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    writeFinding(s.findingsDir, 'wisp-sweep-1', actionableFinding());

    const { counts } = runRouter({
      findingsDir: s.findingsDir, ledgerCli: FAKE_LEDGER, a2aCli: A2A_CLI, stateFile: s.stateFile, fromPane: 9,
      env: baseEnv({
        intel: s.intel, orcaState: s.orcaState, terminalsFile, ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
      }),
    });

    assert.equal(counts.delivered, 1, JSON.stringify(counts));
    assert.equal(ledgerCalls(s.ledgerCallLog).length, 1, 'exactly one ledger create call');
    const state = JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));
    const entry = Object.values(state.fingerprints)[0];
    assert.equal(entry.delivered, true);
    assert.ok(fs.existsSync(path.join(s.findingsDir, 'processed', 'wisp-sweep-1.json')), 'finding moved to processed/');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('same finding processed twice (2 router runs) -> still exactly 1 card', () => {
  const s = sandbox();
  try {
    writeRoster(s.intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }]);
    const terminalsFile = writeTerminals(s.root, [
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const env = baseEnv({
      intel: s.intel, orcaState: s.orcaState, terminalsFile, ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
    });

    writeFinding(s.findingsDir, 'wisp-sweep-run1', actionableFinding());
    runRouter({
      findingsDir: s.findingsDir, ledgerCli: FAKE_LEDGER, a2aCli: A2A_CLI, stateFile: s.stateFile, env, fromPane: 9,
    });
    assert.equal(ledgerCalls(s.ledgerCallLog).length, 1);

    // A SECOND automation run re-emits the SAME finding (same task+summary -> same fingerprint).
    writeFinding(s.findingsDir, 'wisp-sweep-run2', actionableFinding());
    const { counts } = runRouter({
      findingsDir: s.findingsDir, ledgerCli: FAKE_LEDGER, a2aCli: A2A_CLI, stateFile: s.stateFile, env, fromPane: 9,
    });

    assert.equal(ledgerCalls(s.ledgerCallLog).length, 1, 'ledger create was NOT called a second time');
    // The fingerprint was already delivered in run 1, so run 2 recognizes the
    // re-emitted finding as already handled (no second send) rather than
    // sending again — either way, no duplicate card.
    assert.equal(counts['already-delivered'], 1, JSON.stringify(counts));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('non-actionable finding -> 0 cards, 0 sends, 1 log line', () => {
  const s = sandbox();
  try {
    writeFinding(s.findingsDir, 'routine-ok', actionableFinding({ actionable: false, summary: 'nothing to do' }));
    const { counts } = runRouter({
      findingsDir: s.findingsDir,
      ledgerCli: FAKE_LEDGER,
      a2aCli: A2A_CLI,
      stateFile: s.stateFile,
      env: baseEnv({
        intel: s.intel, orcaState: s.orcaState, terminalsFile: writeTerminals(s.root, []), ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
      }),
    });
    assert.equal(counts['non-actionable'], 1);
    assert.equal(ledgerCalls(s.ledgerCallLog).length, 0, 'no ledger card for a non-actionable finding');
    const log = fs.readFileSync(path.join(s.findingsDir, 'non-actionable.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.ok(fs.existsSync(path.join(s.findingsDir, 'processed', 'routine-ok.json')));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('invalid JSON finding -> quarantined, router keeps going', () => {
  const s = sandbox();
  try {
    writeFinding(s.findingsDir, 'broken', '{ not json');
    const { counts } = runRouter({
      findingsDir: s.findingsDir,
      ledgerCli: FAKE_LEDGER,
      a2aCli: A2A_CLI,
      stateFile: s.stateFile,
      env: baseEnv({
        intel: s.intel, orcaState: s.orcaState, terminalsFile: writeTerminals(s.root, []), ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
      }),
    });
    assert.equal(counts.quarantined, 1);
    assert.ok(fs.existsSync(path.join(s.findingsDir, 'quarantine', 'broken.json')));
    const log = fs.readFileSync(path.join(s.findingsDir, 'router-log.jsonl'), 'utf8');
    assert.match(log, /invalid JSON/);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('finding missing repo_owner -> quarantined', () => {
  const s = sandbox();
  try {
    const finding = actionableFinding();
    delete finding.repo_owner;
    writeFinding(s.findingsDir, 'no-owner', finding);
    const { counts } = runRouter({
      findingsDir: s.findingsDir,
      ledgerCli: FAKE_LEDGER,
      a2aCli: A2A_CLI,
      stateFile: s.stateFile,
      env: baseEnv({
        intel: s.intel, orcaState: s.orcaState, terminalsFile: writeTerminals(s.root, []), ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
      }),
    });
    assert.equal(counts.quarantined, 1);
    assert.ok(fs.existsSync(path.join(s.findingsDir, 'quarantine', 'no-owner.json')));
    assert.equal(ledgerCalls(s.ledgerCallLog).length, 0);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('a2a send failure -> card still created; retried next run without a duplicate card', () => {
  const s = sandbox();
  try {
    // Roster points the destination at the SAME handle the sender claims to be
    // (ORCA_TERMINAL_HANDLE) -> a2a_send's self-send guard refuses (isError, exit != 0).
    writeRoster(s.intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_self', state: 'live' }]);
    const terminalsFile = writeTerminals(s.root, [
      { handle: 'term_self', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    writeFinding(s.findingsDir, 'flaky-send', actionableFinding());

    const failingEnv = baseEnv({
      intel: s.intel, orcaState: s.orcaState, terminalsFile, ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
      extra: { ORCA_TERMINAL_HANDLE: 'term_self' },
    });
    const run1 = runRouter({
      findingsDir: s.findingsDir, ledgerCli: FAKE_LEDGER, a2aCli: A2A_CLI, stateFile: s.stateFile, env: failingEnv, fromPane: 9,
    });
    assert.equal(run1.counts['send-failed'], 1, JSON.stringify(run1.counts));
    assert.equal(ledgerCalls(s.ledgerCallLog).length, 1, 'card WAS created despite the send failure');
    assert.ok(fs.existsSync(path.join(s.findingsDir, 'flaky-send.json')), 'finding stays in place for retry (not moved on failure)');
    const state1 = JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));
    const entry1 = Object.values(state1.fingerprints)[0];
    assert.equal(entry1.delivered, false);

    // Next run (no self-send collision this time) retries the SAME finding file.
    const okEnv = baseEnv({
      intel: s.intel, orcaState: s.orcaState, terminalsFile, ledgerDb: s.ledgerDb, ledgerCallLog: s.ledgerCallLog,
    });
    const run2 = runRouter({
      findingsDir: s.findingsDir, ledgerCli: FAKE_LEDGER, a2aCli: A2A_CLI, stateFile: s.stateFile, env: okEnv, fromPane: 9,
    });
    assert.equal(run2.counts.delivered, 1, JSON.stringify(run2.counts));
    assert.equal(ledgerCalls(s.ledgerCallLog).length, 1, 'still exactly one ledger create call across both runs');
    assert.ok(fs.existsSync(path.join(s.findingsDir, 'processed', 'flaky-send.json')), 'moved to processed after successful retry');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});
