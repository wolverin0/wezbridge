'use strict';
// T-0339 P2-P5: gmail-recordatorios as a headless `claude -p`. A fake `claude` double stands in for
// the real CLI: no Gmail, no Super Productivity, no real _intel. It speaks stream-json and closes
// the run with the real `gmail-recordatorios-run.cjs complete` command, relative to the repo cwd.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runGmailRoutine, resolveVia, EXIT_OVERLAP, EXIT_COMPLETION_UNVERIFIED } = require('../scripts/gmail-recordatorios-run.cjs');
const headless = require('../src/gmail-routine-headless.cjs');
const { runHeadless } = require('../src/headless-run.cjs');

const SENTINEL = 'SENTINEL-MAIL-BODY-T0339-Pagar-Personal-Flow-81230';
const REPO = path.resolve(__dirname, '..');

const FAKE = `'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  const mode = process.env.FAKE_MODE;
  if (process.env.FAKE_OUT) fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
    env: { WEZ_LANE: process.env.WEZ_LANE ?? null, WEZTERM_PANE: process.env.WEZTERM_PANE ?? null,
      WEZBRIDGE_ACTOR: process.env.WEZBRIDGE_ACTOR ?? null, MEMORYMASTER_DREAM_ENABLED: process.env.MEMORYMASTER_DREAM_ENABLED ?? null,
      WEZBRIDGE_INTEL_DIR: process.env.WEZBRIDGE_INTEL_DIR ?? null }, prompt: input }));
  const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
  const tool = (name, id) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { query: 'newer_than:2d' } }] } });
  out({ type: 'system', subtype: 'init' });
  if (mode === 'fail1') { process.stderr.write('${SENTINEL}\\n'); process.exit(1); }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode !== 'complete-nosearch') {
    tool('mcp__claude_ai_Gmail__search_threads', 't1');
    tool('mcp__claude_ai_Gmail__search_threads', 't2');
    tool('mcp__claude_ai_Gmail__get_thread', 't3');
  }
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: '${SENTINEL}' }] } });
  process.stderr.write('${SENTINEL}\\n');
  const run = /--run (\\S+)/.exec(input)[1];
  execFileSync(process.execPath, ['scripts/gmail-recordatorios-run.cjs', 'complete', '--run', run,
    '--seen', '5', '--created', '1', '--existing', '1', '--doubtful', '0'], { stdio: 'ignore' });
  out({ type: 'result', subtype: 'success', result: '${SENTINEL}', permission_denials: [{ tool_name: 'Write', tool_use_id: 'x' }] });
  if (mode === 'complete-hang') { setInterval(() => {}, 1000); return; }
  process.exit(0);
});
`;

function fixture(t, mode, extra = {}) {
  const intelDir = fs.mkdtempSync(path.join(os.tmpdir(), 't0339-headless-'));
  t.after(() => { assert.equal(path.dirname(intelDir), os.tmpdir()); fs.rmSync(intelDir, { recursive: true, force: true }); });
  const promptFile = path.join(intelDir, 'prompt.txt');
  fs.writeFileSync(promptFile, '[rutina gmail-recordatorios] fixture: fake claude, no email access');
  const fake = path.join(intelDir, 'fake-claude.cjs');
  fs.writeFileSync(fake, FAKE);
  const fakeOut = path.join(intelDir, 'fake-out.json');
  const runId = 'fixture-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const record = path.join(intelDir, 'routine-findings', `run-gmail-recordatorios-${runId}.json`);
  const spawns = [];
  const deps = {
    claude: { command: process.execPath, prefix: [fake] },
    env: { ...process.env, WEZ_LANE: 'fixture-lane', WEZTERM_PANE: '42', FAKE_MODE: mode, FAKE_OUT: fakeOut },
    timeoutMs: 20000, graceMs: 1500, pollMs: 100,
    runHeadless: o => { spawns.push(o); return runHeadless(o); },
    ...extra,
  };
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { intelDir, promptFile, runId, via: 'headless', deps, spawns, fake, fakeOut, record,
    readRecord: () => read(record),
    readFindings: () => read(path.join(path.dirname(record), `gmail-recordatorios-${runId}.json`)) };
}

test('T-0339 P4a: fake claude completes and exits 0 -> completed/clean over headless', async t => {
  const f = fixture(t, 'complete');
  const result = await runGmailRoutine(f, f.deps);
  const record = f.readRecord();
  assert.equal(record.phase, 'completed');
  assert.equal(record.exit_status, 0);
  assert.equal(record.dispatch_exit_status, 0);
  assert.equal(record.transport, 'headless');
  assert.equal(record.headless_outcome, 'exited');
  assert.deepEqual(record.counts, { seen: 5, created: 1, existing: 1, doubtful: 0 });
  assert.deepEqual(record.gmail_tool_calls, { mcp__claude_ai_Gmail__search_threads: 2, mcp__claude_ai_Gmail__get_thread: 1 });
  assert.deepEqual(record.permission_denials, { Write: 1 });
  assert.equal(record.headless_result, 'success');
  assert.equal(f.readFindings().verdict, 'clean');
  assert.equal(result.exit_status, 0);
});

test('T-0339 P4a control: completing and then hanging is completed-no-exit, still clean', async t => {
  const f = fixture(t, 'complete-hang');
  await runGmailRoutine(f, f.deps);
  const record = f.readRecord();
  assert.equal(record.phase, 'completed');
  assert.equal(record.headless_outcome, 'completed-no-exit');
  assert.equal(record.killed, true);
  assert.equal(record.dispatch_exit_status, 0);
  assert.equal(f.readFindings().verdict, 'clean');
});

test('T-0339 P4b: fake claude exits 1 without completing -> dispatch_failed, nonzero, void, record present', async t => {
  const f = fixture(t, 'fail1');
  const result = await runGmailRoutine(f, f.deps);
  assert.ok(fs.existsSync(f.record));
  const record = f.readRecord();
  assert.equal(record.phase, 'dispatch_failed');
  assert.equal(record.exit_status, 4);
  assert.equal(record.headless_status, 1);
  assert.notEqual(result.exit_status, 0);
  assert.equal(f.readFindings().verdict, 'void');
});

test('T-0339 P4c: fake claude hangs -> timeout, exit 8, record written', async t => {
  const f = fixture(t, 'hang');
  f.deps.timeoutMs = 1500;
  const started = Date.now();
  const result = await runGmailRoutine(f, f.deps);
  assert.ok(Date.now() - started < 15000, 'the hard timeout is finite');
  const record = f.readRecord();
  assert.equal(record.exit_status, 8);
  assert.equal(record.headless_outcome, 'timeout-no-output');
  assert.equal(record.killed, true);
  assert.equal(record.phase, 'dispatch_failed');
  assert.equal(result.exit_status, 8);
  assert.equal(f.readFindings().verdict, 'void');
});

test('T-0339 P4d: least privilege args, no shell, no bypass, sanitized env', async t => {
  const f = fixture(t, 'complete');
  await runGmailRoutine(f, f.deps);
  assert.equal(f.spawns.length, 1);
  const spawned = f.spawns[0];
  assert.equal(spawned.spawnOpts.shell, false, 'claude is spawned without a shell');
  assert.equal(spawned.timeoutMs, 20000);
  assert.equal(spawned.summaryFile, f.record, 'the run record is the done signal');
  const seen = JSON.parse(fs.readFileSync(f.fakeOut, 'utf8'));
  const argv = seen.argv;
  for (const banned of ['--dangerously-skip-permissions', '--bare']) assert.ok(!argv.includes(banned), banned);
  assert.ok(argv.includes('-p') && argv.includes('--no-session-persistence') && argv.includes('--verbose'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '40');
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1]), { disableAllHooks: true });
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  const disallowed = argv.slice(argv.indexOf('--disallowedTools') + 1).filter(a => !a.startsWith('--'));
  assert.deepEqual(allowed.filter(a => a.startsWith('mcp__')).sort(),
    ['mcp__claude_ai_Gmail__get_message', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__search_threads']);
  for (const tool of allowed) assert.ok(!/(trash|label|draft|delete|send|reply|forward|spam|modify|update)/i.test(tool), tool);
  for (const tool of ['Edit', 'Write', 'Agent', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Gmail__send_message',
    'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__label_message', 'mcp__claude_ai_Gmail__update_message_labels']) {
    assert.ok(disallowed.includes(tool), `${tool} must be denied`);
  }
  assert.deepEqual(allowed.filter(a => a.startsWith('Bash(')), ['Bash(node scripts/sp-bridge.cjs remind:*)',
    'Bash(node scripts/gmail-recordatorios-run.cjs complete:*)', 'Bash(node scripts/gmail-recordatorios-run.cjs fail:*)']);
  assert.ok(!allowed.includes('Bash'), 'no unrestricted Bash');
  assert.equal(seen.env.WEZ_LANE, null);
  assert.equal(seen.env.WEZTERM_PANE, null);
  assert.equal(seen.env.WEZBRIDGE_ACTOR, 'gmail-recordatorios-headless');
  assert.equal(seen.env.MEMORYMASTER_DREAM_ENABLED, '0');
  assert.equal(seen.env.WEZBRIDGE_INTEL_DIR, f.intelDir, 'complete/fail close this run, not the real _intel');
  assert.equal(path.resolve(seen.cwd), REPO);
  assert.match(seen.prompt, new RegExp(`complete --run ${f.runId}`));
  assert.match(seen.prompt, /node scripts\/sp-bridge\.cjs remind/);
});

test('T-0339 P4d: the default claude resolution never goes through a .cmd shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0339-bin-'));
  try {
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
    assert.deepEqual(headless.resolveClaude({ PATH: dir }, 'win32'), { command: exe, prefix: [] });
    assert.deepEqual(headless.resolveClaude({ PATH: '' }, 'linux'), { command: 'claude', prefix: [] });
    assert.ok(!/\.cmd$/i.test(headless.resolveClaude({ PATH: '' }, 'win32').command));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T-0339 P4e: mail text printed by claude never reaches the run record or findings', async t => {
  for (const mode of ['complete', 'fail1']) {
    const f = fixture(t, mode);
    await runGmailRoutine(f, f.deps);
    const dir = path.dirname(f.record);
    for (const name of fs.readdirSync(dir)) {
      assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes(SENTINEL), `${mode}: ${name} leaked mail text`);
    }
    const record = f.readRecord();
    assert.ok(record.stdout_bytes > 0, 'only byte lengths are kept');
    assert.equal(record.stdout, undefined);
    assert.equal(record.stderr, undefined);
  }
});

test('T-0339 P4f/P3: completion with 0 Gmail searches is void, not clean', async t => {
  const f = fixture(t, 'complete-nosearch');
  const result = await runGmailRoutine(f, f.deps);
  const record = f.readRecord();
  assert.equal(record.phase, 'completed');
  assert.equal(record.exit_status, EXIT_COMPLETION_UNVERIFIED);
  assert.equal(record.completion_verified, false);
  assert.deepEqual(record.gmail_tool_calls, {});
  const findings = f.readFindings();
  assert.equal(findings.verdict, 'void');
  assert.equal(findings.void_reason, 'completion sin consulta a Gmail');
  assert.equal(result.exit_status, EXIT_COMPLETION_UNVERIFIED);
});

test('T-0339 P3: CLI run defaults to headless; --via pane / GMAIL_ROUTINE_VIA=pane select the legacy path', () => {
  assert.equal(resolveVia(['run'], {}), 'headless');
  assert.equal(resolveVia(['run', '--via', 'pane'], {}), 'pane');
  assert.equal(resolveVia(['run'], { GMAIL_ROUTINE_VIA: 'pane' }), 'pane');
  assert.equal(resolveVia(['run', '--via', 'headless'], { GMAIL_ROUTINE_VIA: 'pane' }), 'headless');
  assert.throws(() => resolveVia(['run', '--via', 'shell'], {}), /pane\|headless/);
});

test('T-0339 P3: the unchanged schtask command line (`run`) reaches the headless transport', async t => {
  const f = fixture(t, 'complete');
  const env = { ...f.deps.env, GMAIL_ROUTINE_CLAUDE_BIN: f.fake };
  delete env.GMAIL_ROUTINE_VIA;
  const child = spawnSync(process.execPath, ['scripts/gmail-recordatorios-run.cjs', 'run', '--intel-dir', f.intelDir,
    '--run', f.runId, '--file', f.promptFile], { cwd: REPO, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const record = f.readRecord();
  assert.equal(record.via, 'headless');
  assert.equal(record.transport, 'headless');
  assert.equal(record.phase, 'completed');
  assert.ok(!child.stdout.includes(SENTINEL), 'the CLI echo is metadata only');
});

test('T-0339 P5: a second run while one is still dispatching writes its own record and spawns nothing', async t => {
  const f = fixture(t, 'complete');
  const dir = path.join(f.intelDir, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  const live = { routine: 'gmail-recordatorios', repo: 'wezbridge', run_id: 'live-run', phase: 'dispatching',
    started_at: new Date(Date.now() - 60000).toISOString() };
  fs.writeFileSync(path.join(dir, 'run-gmail-recordatorios-live-run.json'), JSON.stringify(live));
  const result = await runGmailRoutine(f, f.deps);
  assert.equal(f.spawns.length, 0, 'no second claude child');
  assert.equal(result.exit_status, EXIT_OVERLAP);
  const record = f.readRecord();
  assert.equal(record.phase, 'skipped_overlap');
  assert.equal(record.exit_status, EXIT_OVERLAP);
  assert.equal(record.overlapping_run, 'live-run');
  assert.equal(f.readFindings().verdict, 'void');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run-gmail-recordatorios-live-run.json'), 'utf8')).phase,
    'dispatching', 'the live run is left alone');
});

test('T-0339 P5 control: a stale dispatching record (older than the timeout) does not block the run', async t => {
  const f = fixture(t, 'complete');
  const dir = path.join(f.intelDir, 'routine-findings');
  fs.mkdirSync(dir, { recursive: true });
  const stale = { routine: 'gmail-recordatorios', run_id: 'crashed-run', phase: 'dispatching',
    started_at: new Date(Date.now() - (headless.HEADLESS_TIMEOUT_MS + headless.HEADLESS_GRACE_MS + 60000)).toISOString() };
  fs.writeFileSync(path.join(dir, 'run-gmail-recordatorios-crashed-run.json'), JSON.stringify(stale));
  const result = await runGmailRoutine(f, f.deps);
  assert.equal(f.spawns.length, 1);
  assert.equal(result.phase, 'completed');
});
