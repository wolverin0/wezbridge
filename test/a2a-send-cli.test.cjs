'use strict';
/**
 * a2a-send-cli.test.cjs — T-0596 paso 2: bin/a2a-send-cli.cjs is the ONE
 * wezbridge entry point Python callers (task_router.py, notify_orchestrator.py,
 * foreman.py) now use instead of shelling out to `orca terminal send` directly.
 * Proves it goes through the REAL a2a_send control plane (same mock harness
 * a2a-send-orca-transport.test.cjs uses): delivers via Orca, and the
 * self-send guard still refuses.
 */
const { guardCompanions, companionsRoot } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'a2a-send-cli.cjs');
const WEZ_MOCK = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
const ORCA_MOCK = path.join(__dirname, 'mocks', 'orca-mock.cjs');
const CURATION = path.join(companionsRoot(), '_docs-curation');
const REAL_KINDS = path.join(companionsRoot(), '_intel', 'kinds.json');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-cli-'));
  const intel = path.join(root, '_intel');
  const curation = path.join(root, '_docs-curation');
  const orcaState = path.join(root, 'orca-state');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  fs.mkdirSync(curation, { recursive: true });
  fs.mkdirSync(orcaState, { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(intel, 'kinds.json'));
  fs.copyFileSync(path.join(CURATION, 'ledger.cjs'), path.join(curation, 'ledger.cjs'));
  fs.copyFileSync(path.join(CURATION, 'sweeper-config.json'), path.join(curation, 'sweeper-config.json'));
  return { root, intel, orcaState };
}

function writeTerminals(root, terminals) {
  const f = path.join(root, 'orca-terminals.json');
  fs.writeFileSync(f, JSON.stringify(terminals));
  return f;
}

function writeRoster(intel, lanes) {
  fs.writeFileSync(path.join(intel, 'orchestrators.json'), JSON.stringify({ version: 1, lanes }));
}

function envFor(intel, orcaState, terminalsFile, extra = {}) {
  return {
    ...process.env,
    WEZBRIDGE_INTEL_DIR: intel,
    WEZBRIDGE_WEZTERM_BIN: WEZ_MOCK,
    WEZBRIDGE_SAFETY_OVERRIDE: '1',
    ORCA_CLI: ORCA_MOCK,
    ORCA_MOCK_STATE: orcaState,
    ORCA_MOCK_TERMINALS: terminalsFile,
    ...extra,
  };
}

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('a2a-send-cli delivers via Orca (same control plane as a2a_send) and exits 0', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_drill1', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_drill1', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const { code, stdout } = await runCli(
      ['--to-project', 'drillrepo', '--from-pane', '5', '--type', 'progress', '--corr', 'T-0596:cli:1', '--body', 'via cli'],
      envFor(intel, orcaState, terminalsFile),
    );
    const payload = JSON.parse(stdout.trim());
    assert.equal(payload.ok, true, stdout);
    assert.equal(payload.transport, 'orca');
    assert.equal(code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a2a-send-cli SELF-SEND GUARD: refuses and exits nonzero when destination is the caller\'s own terminal', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    writeRoster(intel, [{ lane: 'drillrepo', repos: ['drillrepo'], handle: 'term_self', state: 'live' }]);
    const terminalsFile = writeTerminals(root, [
      { handle: 'term_self', title: 'orchestrator', worktreePath: 'G:/Py Apps/drillrepo', connected: true, writable: true },
    ]);
    const { code, stdout } = await runCli(
      ['--to-project', 'drillrepo', '--from-pane', '5', '--type', 'progress', '--corr', 'T-0596:cli:self', '--body', 'no deberia salir'],
      envFor(intel, orcaState, terminalsFile, { ORCA_TERMINAL_HANDLE: 'term_self' }),
    );
    assert.match(stdout, /self-send: BLOCKED a2a_send/);
    assert.notEqual(code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a2a-send-cli requires --body', async () => {
  const { root, intel, orcaState } = sandbox();
  try {
    const terminalsFile = writeTerminals(root, []);
    const { code, stderr } = await runCli(['--to-project', 'drillrepo'], envFor(intel, orcaState, terminalsFile));
    assert.equal(code, 2);
    assert.match(stderr, /--body/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
