'use strict';
/**
 * mcp-reconnect-broadcast.test.cjs — T-0569: `/mcp reconnect <server>` must reach only
 * IDLE Claude panes with an EMPTY composer. Covers the provider filter, the idle/working
 * gate, the composer-not-empty gate, self-busy skip + manual command, dry-run (sends
 * nothing), and sendReconnect's ok/fail/unknown classification. All orca calls go through
 * a fake runOrca (list/read/send), no real CLI or timers involved (fake sleep).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyStatus, classifyTarget, planBroadcast, sendReconnect, runBroadcast,
  printTable, projectName, manualCommand, SUCCESS_RE, FAIL_RE,
} = require('../scripts/mcp-reconnect-broadcast.cjs');

// ── fixtures ────────────────────────────────────────────────────────────────

const IDLE_TAIL = [
  '● Ran 1 shell command',
  '✻ Baked for 2m 19s · done 9:51 PM · 1 shell still running',
  '───',
  '❯',
  '───',
  '   Model: Opus 5.5  Thinking: xhigh  ⎇ main ',
];

const IDLE_WITH_TEXT_TAIL = [
  '● Ran 1 shell command',
  '✻ Baked for 2m 19s · done 9:51 PM',
  '───',
  '❯ pending message not sent yet',
  '───',
  '   Model: Opus 5.5',
];

const WORKING_TAIL = [
  '● Thinking…',
  '  (esc to interrupt)',
  '   Model: Opus 5.5  Ctx Used: 40%',
];

function terminalListJson(terms) {
  return JSON.stringify({ id: 'x', ok: true, result: { terminals: terms } });
}

function baseTerms() {
  return [
    { handle: 'term_claude_idle1', worktreePath: 'G:/Py Apps/memorymaster', title: 'idle1', tabId: 't1', connected: true, writable: true, agentIdentity: 'claude' },
    { handle: 'term_claude_idle2', worktreePath: 'G:/Py Apps/wezbridge', title: 'idle2', tabId: 't2', connected: true, writable: true, agentIdentity: 'claude' },
    { handle: 'term_codex1', worktreePath: 'G:/Py Apps/infra', title: 'codex', tabId: 't3', connected: true, writable: true, agentIdentity: 'codex' },
    { handle: 'term_claude_working', worktreePath: 'G:/Py Apps/pedrito', title: 'working', tabId: 't4', connected: true, writable: true, agentIdentity: 'claude' },
    { handle: 'term_claude_textcomposer', worktreePath: 'G:/Py Apps/rifas', title: 'has-text', tabId: 't5', connected: true, writable: true, agentIdentity: 'claude' },
  ];
}

const SCREENS = {
  term_claude_idle1: IDLE_TAIL,
  term_claude_idle2: IDLE_TAIL,
  term_codex1: ['› Ask Codex to do anything'],
  term_claude_working: WORKING_TAIL,
  term_claude_textcomposer: IDLE_WITH_TEXT_TAIL,
};

/** Fake runOrca covering list/read/send, mutable per test via overrides. */
function fakeRunOrca({ terms = baseTerms(), screens = SCREENS, sendResults = {}, fail = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (fail) throw new Error(fail);
    if (args[0] === 'terminal' && args[1] === 'list') return terminalListJson(terms);
    if (args[0] === 'terminal' && args[1] === 'read') {
      const h = args[args.indexOf('--terminal') + 1];
      const seq = sendResults[h];
      if (Array.isArray(seq) && seq.length) {
        const tail = seq.shift();
        return JSON.stringify({ ok: true, result: { terminal: { handle: h, status: 'running', tail } } });
      }
      const tail = screens[h];
      if (!tail) throw new Error(`unknown terminal ${h}`);
      return JSON.stringify({ ok: true, result: { terminal: { handle: h, status: 'running', tail } } });
    }
    if (args[0] === 'terminal' && args[1] === 'send') {
      return JSON.stringify({ ok: true, result: { accepted: true } });
    }
    throw new Error(`unexpected orca call: ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

// ── AC1: provider filter + idle/composer gate ───────────────────────────────

test('plan: 2 idle claude are targets; codex excluded; working and composer-text claude panes skipped', async () => {
  const runOrca = fakeRunOrca();
  const plan = await planBroadcast({ runOrca });
  assert.equal(plan.ok, true);
  const targetHandles = plan.targets.map((t) => t.handle).sort();
  assert.deepEqual(targetHandles, ['term_claude_idle1', 'term_claude_idle2']);
  assert.equal(plan.targets.some((t) => t.handle === 'term_codex1'), false, 'codex never becomes a target');
  const skipByHandle = Object.fromEntries(plan.skips.map((s) => [s.handle, s.reason]));
  assert.equal(skipByHandle.term_claude_working, 'status-working');
  assert.equal(skipByHandle.term_claude_textcomposer, 'composer-not-empty');
});

test('runBroadcast: only the 2 idle claude panes receive a send; codex, working and composer-text panes are never sent to', async () => {
  // First queued tail per handle is consumed by planBroadcast's own idle/composer
  // classification read; the second is what sendReconnect's poll sees afterward.
  const runOrca = fakeRunOrca({
    sendResults: {
      term_claude_idle1: [IDLE_TAIL, ['❯ ', '✔ Successfully reconnected to memorymaster.', '❯']],
      term_claude_idle2: [IDLE_TAIL, ['❯ ', '✔ Successfully reconnected to memorymaster.', '❯']],
    },
  });
  const result = await runBroadcast({ server: 'memorymaster', runOrca, sleep: noSleep, selfHandle: null });
  assert.equal(result.ok, true);
  const sendCalls = runOrca.calls.filter((c) => c[1] === 'send');
  const sentTo = sendCalls.map((c) => c[c.indexOf('--terminal') + 1]).sort();
  assert.deepEqual(sentTo, ['term_claude_idle1', 'term_claude_idle2']);
  for (const c of sendCalls) assert.ok(c.includes('/mcp reconnect memorymaster'), 'exact text payload sent');
  const okRows = result.rows.filter((r) => r.result === 'ok');
  assert.equal(okRows.length, 2);
  assert.equal(result.exitCode, 0);
});

// Mutation guard 1: classifyTarget without the provider check would treat a codex pane
// as eligible for the idle/composer gate and could report it a target.
test('mutation guard — provider filter: a codex pane with an idle-shaped, empty-looking screen is still never a target', () => {
  const term = { handle: 'term_codex1', provider: 'codex', title: 'codex' };
  const verdict = classifyTarget({ term, tailLines: ['❯'], selfHandle: null, includeBusySelf: false });
  assert.equal(verdict.target, false);
  assert.equal(verdict.reason, 'provider-not-claude');
});

// Mutation guard 2: classifyTarget without the idle gate would treat a working/permission
// pane as a target as long as the composer line looked empty.
test('mutation guard — idle gate: a claude pane mid-turn (esc to interrupt, empty-looking composer) is never a target', () => {
  const term = { handle: 'term_claude_working', provider: 'claude', title: 'working' };
  const verdict = classifyTarget({ term, tailLines: WORKING_TAIL, selfHandle: null, includeBusySelf: false });
  assert.equal(verdict.target, false);
  assert.equal(verdict.reason, 'status-working');
});

test('classifyTarget: composer holding unsent text is skipped even though the pane reads idle', () => {
  const term = { handle: 'term_claude_textcomposer', provider: 'claude', title: 'has-text' };
  const verdict = classifyTarget({ term, tailLines: IDLE_WITH_TEXT_TAIL, selfHandle: null, includeBusySelf: false });
  assert.equal(verdict.target, false);
  assert.equal(verdict.reason, 'composer-not-empty');
});

test('classifyStatus: idle/working/unknown classification matches pane-discovery semantics', () => {
  assert.equal(classifyStatus(IDLE_TAIL), 'idle');
  assert.equal(classifyStatus(WORKING_TAIL), 'working');
  assert.equal(classifyStatus(['just some scrollback, no prompt, no spinner']), 'unknown');
});

// ── self-pane safety ─────────────────────────────────────────────────────────

test('self pane: skipped as self-busy by default (never typed into) and the manual command is printed', async () => {
  const runOrca = fakeRunOrca();
  const plan = await planBroadcast({ runOrca, selfHandle: 'term_claude_idle1', includeBusySelf: false });
  const self = plan.skips.find((s) => s.handle === 'term_claude_idle1');
  assert.ok(self, 'self pane appears in skips, not targets');
  assert.equal(self.reason, 'self-busy');
  assert.equal(plan.targets.some((t) => t.handle === 'term_claude_idle1'), false);

  const result = await runBroadcast({ server: 'memorymaster', runOrca, sleep: noSleep, selfHandle: 'term_claude_idle1' });
  const row = result.rows.find((r) => r.handle === 'term_claude_idle1');
  assert.equal(row.result, 'skip:self-busy');
  assert.match(row.excerpt, /manual: orca terminal send --terminal term_claude_idle1/);
  assert.match(row.excerpt, /\/mcp reconnect memorymaster/);
  const sendCalls = runOrca.calls.filter((c) => c[1] === 'send');
  assert.equal(sendCalls.some((c) => c.includes('term_claude_idle1')), false, 'self pane is never sent to');
});

test('self pane: --include-busy-self lets it through the normal idle/composer gate like any other pane', async () => {
  const runOrca = fakeRunOrca();
  const plan = await planBroadcast({ runOrca, selfHandle: 'term_claude_idle1', includeBusySelf: true });
  assert.ok(plan.targets.some((t) => t.handle === 'term_claude_idle1'));
});

test('manualCommand: exact orca CLI invocation for the operator to run by hand', () => {
  assert.equal(manualCommand('term_abc', 'memorymaster'),
    'orca terminal send --terminal term_abc --text "/mcp reconnect memorymaster" --enter --json');
});

// ── dry-run ───────────────────────────────────────────────────────────────────

test('dry-run: lists targets and skips, sends nothing', async () => {
  const runOrca = fakeRunOrca();
  const result = await runBroadcast({ server: 'memorymaster', dryRun: true, runOrca, sleep: noSleep, selfHandle: null });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  const sendCalls = runOrca.calls.filter((c) => c[1] === 'send');
  assert.equal(sendCalls.length, 0, 'dry-run never calls terminal send');
  const dryRunRows = result.rows.filter((r) => r.result === 'dry-run:target');
  assert.deepEqual(dryRunRows.map((r) => r.handle).sort(), ['term_claude_idle1', 'term_claude_idle2']);
  const skipRows = result.rows.filter((r) => String(r.result).startsWith('skip:'));
  assert.ok(skipRows.length >= 2, 'working and composer-text panes reported as skips');
});

// ── sendReconnect classification ─────────────────────────────────────────────

test('sendReconnect: classifies ok on "Successfully reconnected"', async () => {
  const runOrca = fakeRunOrca({
    sendResults: { term_claude_idle1: [['some scrollback'], ['❯ ', 'Successfully reconnected to memorymaster.']] },
  });
  const r = await sendReconnect({ runOrca, handle: 'term_claude_idle1', server: 'memorymaster', sleep: noSleep, pollMs: 1, timeoutMs: 2 });
  assert.equal(r.result, 'ok');
  assert.match(r.excerpt, /Successfully reconnected/);
});

test('sendReconnect: classifies fail on error text', async () => {
  const runOrca = fakeRunOrca({
    sendResults: { term_claude_idle1: [['❯ ', 'Failed to reconnect: server unreachable']] },
  });
  const r = await sendReconnect({ runOrca, handle: 'term_claude_idle1', server: 'memorymaster', sleep: noSleep, pollMs: 1, timeoutMs: 1 });
  assert.equal(r.result, 'fail');
});

test('sendReconnect: catches a success line buried by busy-pane chatter (not just the last 10 lines)', async () => {
  // Regression for a live T-0569 run: a background-agent pane kept appending output
  // after the reconnect result printed, pushing "Successfully reconnected" outside a
  // narrow last-N-lines window and reporting a real success as 'unknown'.
  const busyTail = [
    '❯ /mcp reconnect memorymaster',
    '  ⎿  Successfully reconnected to memorymaster',
    ...Array.from({ length: 15 }, (_, i) => `● background agent chatter line ${i}`),
    '❯',
  ];
  const runOrca = fakeRunOrca({ sendResults: { term_claude_idle1: [busyTail] } });
  const r = await sendReconnect({ runOrca, handle: 'term_claude_idle1', server: 'memorymaster', sleep: noSleep, pollMs: 1, timeoutMs: 1 });
  assert.equal(r.result, 'ok');
  assert.match(r.excerpt, /Successfully reconnected/);
});

test('sendReconnect: classifies unknown on timeout (neither success nor failure text ever appears)', async () => {
  const runOrca = fakeRunOrca({
    sendResults: { term_claude_idle1: [['❯ '], ['❯ '], ['❯ ']] },
  });
  const r = await sendReconnect({ runOrca, handle: 'term_claude_idle1', server: 'memorymaster', sleep: noSleep, pollMs: 1, timeoutMs: 3 });
  assert.equal(r.result, 'unknown');
});

test('sendReconnect: a stale "Successfully reconnected" from an earlier run (still visible above the new command echo) must not count — real fail after the new echo wins', async () => {
  // Regression for T-0569: an operator ran `/mcp reconnect memorymaster` by hand earlier
  // today; that success block is still in the visible screen/scrollback when this run's
  // command echo appears, followed later by a real failure. Only text after the LAST
  // (newest) command echo may be classified.
  const staleThenFailTail = [
    '❯ /mcp reconnect memorymaster',
    '  ⎿  Successfully reconnected to memorymaster',
    '● unrelated chatter',
    '❯ /mcp reconnect memorymaster',
    '● Thinking…',
    '  ⎿  Failed to reconnect: server unreachable',
    '❯',
  ];
  const runOrca = fakeRunOrca({ sendResults: { term_claude_idle1: [staleThenFailTail] } });
  const r = await sendReconnect({ runOrca, handle: 'term_claude_idle1', server: 'memorymaster', sleep: noSleep, pollMs: 1, timeoutMs: 1 });
  assert.equal(r.result, 'fail');
});

test('sendReconnect: stale success + new echo with nothing after yet is unknown, not ok', async () => {
  const staleThenNothingTail = [
    '❯ /mcp reconnect memorymaster',
    '  ⎿  Successfully reconnected to memorymaster',
    '● unrelated chatter',
    '❯ /mcp reconnect memorymaster',
  ];
  const runOrca = fakeRunOrca({
    sendResults: { term_claude_idle1: [staleThenNothingTail, staleThenNothingTail] },
  });
  const r = await sendReconnect({ runOrca, handle: 'term_claude_idle1', server: 'memorymaster', sleep: noSleep, pollMs: 1, timeoutMs: 2 });
  assert.equal(r.result, 'unknown');
});

test('runBroadcast: exit code is 1 when any targeted pane does not classify ok', async () => {
  const runOrca = fakeRunOrca({
    sendResults: {
      term_claude_idle1: [IDLE_TAIL, ['❯ ', 'Successfully reconnected to memorymaster.']],
      term_claude_idle2: [IDLE_TAIL, ['❯ ', 'Failed to reconnect: timeout']],
    },
  });
  const result = await runBroadcast({ server: 'memorymaster', runOrca, sleep: noSleep, selfHandle: null });
  assert.equal(result.exitCode, 1);
  const idle1Row = result.rows.find((r) => r.handle === 'term_claude_idle1');
  const idle2Row = result.rows.find((r) => r.handle === 'term_claude_idle2');
  assert.equal(idle1Row.result, 'ok');
  assert.equal(idle2Row.result, 'fail');
});

test('runBroadcast: exit code is 0 when there are no targets at all', async () => {
  const runOrca = fakeRunOrca({ terms: baseTerms().filter((t) => t.agentIdentity !== 'claude' || t.handle.includes('working') || t.handle.includes('textcomposer')) });
  const result = await runBroadcast({ server: 'memorymaster', runOrca, sleep: noSleep, selfHandle: null });
  assert.equal(result.exitCode, 0);
});

// ── plumbing ──────────────────────────────────────────────────────────────────

test('planBroadcast: census failure surfaces as {ok:false, reason}, never throws', async () => {
  const runOrca = fakeRunOrca({ fail: 'orca CLI not found' });
  const plan = await planBroadcast({ runOrca });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /orca CLI not found/);
});

test('projectName: last path segment, trailing slash tolerant', () => {
  assert.equal(projectName('G:/Py Apps/memorymaster'), 'memorymaster');
  assert.equal(projectName('G:/Py Apps/memorymaster/'), 'memorymaster');
  assert.equal(projectName(null), '');
});

test('printTable: header + one line per row, no throw on empty excerpt', () => {
  const lines = [];
  printTable([{ handle: 'term_a', worktreePath: 'G:/Py Apps/foo', result: 'ok', excerpt: 'Successfully reconnected' }], (l) => lines.push(l));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /handle/);
  assert.match(lines[2], /term_a/);
  assert.match(lines[2], /foo/);
});

test('SUCCESS_RE / FAIL_RE sanity', () => {
  assert.ok(SUCCESS_RE.test('✔ Successfully reconnected to memorymaster.'));
  assert.ok(FAIL_RE.test('Failed to reconnect: server unreachable'));
  assert.ok(!SUCCESS_RE.test('❯'));
  assert.ok(!FAIL_RE.test('❯'));
});
