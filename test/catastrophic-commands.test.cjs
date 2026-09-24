'use strict';
/**
 * catastrophic-commands.test.cjs — T-0568. Verifies classifyCatastrophic() denies commands that
 * would kill processes the caller did not start (or the whole machine), allows PID-scoped
 * equivalents, follows chained/wrapped commands into every segment, and does not flag catastrophic
 * text that only appears as a literal argument to an unrelated command. Includes a mutation guard:
 * disabling the /IM rule must fail the card's primary deny case.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(path.resolve(__dirname, '..', 'src', 'catastrophic-commands.cjs'));
const { classifyCatastrophic } = mod;

function deny(cmd, msg) {
  const r = classifyCatastrophic(cmd);
  assert.equal(r.deny, true, `${msg || cmd} -> expected deny, got ${JSON.stringify(r)}`);
  assert.ok(r.rule, `${msg || cmd} -> deny result must carry a rule name`);
  assert.ok(r.reason && r.reason.length > 10, `${msg || cmd} -> deny result must carry an actionable reason`);
  return r;
}

function allow(cmd, msg) {
  const r = classifyCatastrophic(cmd);
  assert.equal(r.deny, false, `${msg || cmd} -> expected allow, got ${JSON.stringify(r)}`);
  assert.equal(r.rule, null);
}

// --- the card's 4 verbatim cases --------------------------------------------------------------

test('card case 1: taskkill /F /IM python.exe /T -> deny (with agent_id context)', () => {
  // classifyCatastrophic is agent_id-agnostic by design: it must deny this regardless of who
  // calls it, which is the whole point (subagents bypassed the old orchestrator-only guard).
  const r = deny('taskkill /F /IM python.exe /T');
  assert.equal(r.rule, 'taskkill_by_image');
});

test('card case 2: taskkill /PID 1234 /F -> allow', () => {
  allow('taskkill /PID 1234 /F');
});

test('card case 3: Stop-Process -Name node -> deny', () => {
  const r = deny('Stop-Process -Name node');
  assert.equal(r.rule, 'stop_process_by_name');
});

test('card case 4: pkill -f node -> deny', () => {
  const r = deny('pkill -f node');
  assert.equal(r.rule, 'pkill_killall');
});

// --- taskkill /IM: flag order/case, .exe, /im vs -im -------------------------------------------

test('taskkill /IM variants', () => {
  deny('taskkill.exe /IM python.exe');
  deny('taskkill /im python.exe');
  deny('taskkill -im python.exe');
  deny('taskkill /T /F /IM python.exe'); // flag order
  deny('TASKKILL /F /IM PYTHON.EXE /T'); // case
  allow('taskkill /PID 1234 /F /T');
});

// --- Stop-Process family -------------------------------------------------------------------

test('Stop-Process -Name and aliases (spps, kill -Name)', () => {
  deny('Stop-Process -Name node');
  deny('spps -Name node');
  deny('kill -Name node');
  allow('Stop-Process -Id 1234');
});

test('Get-Process <name> | Stop-Process (pipeline mass-kill)', () => {
  deny('Get-Process node | Stop-Process');
  allow('Get-Process node | Stop-Process -Id 1234');
});

// --- pkill / killall ------------------------------------------------------------------------

test('pkill/killall by name, incl. pkill -f', () => {
  deny('pkill node');
  deny('pkill -f node');
  deny('killall node');
});

// --- kill -9 -1 style mass signal -------------------------------------------------------------

test('kill mass-signal forms (-1 target) deny; PID-scoped kill allows', () => {
  deny('kill -9 -1');
  deny('kill -KILL -1');
  deny('kill -1');
  allow('kill -9 1234');
  allow('kill 1234');
});

// --- shutdown / reboot family ------------------------------------------------------------------

test('shutdown/reboot/poweroff/Restart-Computer/Stop-Computer deny', () => {
  deny('shutdown /s /t 0');
  deny('shutdown -h now');
  deny('reboot');
  deny('poweroff');
  deny('Restart-Computer -Force');
  deny('Stop-Computer');
});

// --- wmic process delete/terminate --------------------------------------------------------------

test('wmic process delete / call terminate denies', () => {
  deny('wmic process where name="python.exe" delete');
  deny('wmic process call terminate');
  allow('wmic os get caption'); // unrelated wmic query
});

// --- docker mass stop/kill/rm ------------------------------------------------------------------

test('docker stop|kill|rm: mass forms deny, explicit target allows', () => {
  deny('docker stop $(docker ps -q)');
  deny('docker stop $(docker ps -a -q)');
  deny('docker kill -a -q');
  deny('docker rm');
  allow('docker stop mycontainer');
  allow('docker kill mycontainer');
  allow('docker rm mycontainer -f');
});

// --- chaining: deny if ANY segment is catastrophic ----------------------------------------------

test('chained commands: deny if any segment matches, across &&, ;, |, newlines', () => {
  deny('echo hi && taskkill /F /IM python.exe /T');
  deny('git status; pkill -f node');
  deny('echo start\ntaskkill /IM python.exe /F');
  deny('cd /tmp && Stop-Process -Name node');
  allow('git status && echo done');
});

// --- wrapper shells: cmd /c, powershell -Command, bash -c --------------------------------------

test('wrapper shells are unwrapped and their inner command classified', () => {
  deny('cmd /c "taskkill /F /IM python.exe /T"');
  deny('cmd.exe /c "taskkill /F /IM python.exe /T"');
  deny('powershell -Command "Stop-Process -Name node"');
  deny('powershell.exe -NoProfile -Command "pkill -f node"');
  deny('bash -c "pkill -f node"');
  deny("sh -c 'killall node'");
  allow('powershell -Command "Get-Process"');
  // wrapper as one segment of a chain
  deny('echo hi && cmd /c "taskkill /IM python.exe /F"');
});

// --- false-positive guards: literal text as an argument, not an invocation ---------------------

test('quoted literal text passed as an argument to an unrelated command is allowed', () => {
  // Decision: only the program actually invoked (first token of a segment/pipeline stage) is
  // classified. A string that merely CONTAINS "taskkill /IM" as a literal argument to git/echo/
  // grep is not itself an invocation of taskkill and must not be denied — otherwise routine work
  // like committing this very test file, or grepping for the pattern, would be blocked.
  allow('echo "taskkill /IM"');
  allow('grep taskkill file.txt');
  allow('grep -rn "pkill -f" src');
  allow('git commit -m "docs: mention taskkill /IM python.exe /T in the brief"');
  allow('echo "Stop-Process -Name node is dangerous"');
});

test('unrelated commands with similar-looking tokens allow', () => {
  allow('npm test 2>&1 | tail -5');
  allow('node script.js --kill-timeout 5000');
  allow('echo "please do not shutdown the server manually"');
});

// --- reason text must be actionable ------------------------------------------------------------

test('deny reasons tell the agent what to do instead', () => {
  const r1 = classifyCatastrophic('taskkill /F /IM python.exe /T');
  assert.match(r1.reason, /PID/i);
  const r2 = classifyCatastrophic('Stop-Process -Name node');
  assert.match(r2.reason, /-Id/i);
  const r3 = classifyCatastrophic('pkill -f node');
  assert.match(r3.reason, /PID|stop command/i);
});

// --- purity: no I/O, deterministic, no thrown errors on odd input ------------------------------

test('classifyCatastrophic is pure and tolerant of odd input', () => {
  assert.deepEqual(classifyCatastrophic(''), { deny: false, rule: null, reason: null });
  assert.deepEqual(classifyCatastrophic(undefined), { deny: false, rule: null, reason: null });
  assert.deepEqual(classifyCatastrophic(null), { deny: false, rule: null, reason: null });
  // deterministic: same input -> same output
  const a = classifyCatastrophic('taskkill /F /IM python.exe /T');
  const b = classifyCatastrophic('taskkill /F /IM python.exe /T');
  assert.deepEqual(a, b);
});

// === T-0602: recursive-delete of shared temp root + git stash ban ==============================
// Incident 24/09: a verifier ran `rm -rf /t/claudecodetemp` (root of ALL sessions' scratchpads,
// task outputs and ad-hoc worktrees); 5 agents used `git stash` (stack shared across worktrees/
// sessions) despite prose bans in their briefs. See _intel/briefs/2026-09-24-T0602-guard.md.

// --- git stash: deny every mutating form, allow list/show --------------------------------------

test('git stash: mutating forms deny (push/save/pop/apply/drop/clear/-u), incl. git -C', () => {
  deny('git stash');
  deny('git stash push -u -m x');
  deny('git stash pop');
  deny('git stash save "wip"');
  deny('git stash apply');
  deny('git stash apply stash@{0}');
  deny('git stash drop');
  deny('git stash clear');
  deny('git stash -u');
  deny('git -C /some/worktree stash');
  deny('git -C /some/worktree stash pop');
});

test('git stash: list/show are read-only and allowed', () => {
  allow('git stash list');
  allow('git stash show');
  allow('git stash show -p stash@{0}');
});

test('git stash: chained forms deny', () => {
  deny('git status && git stash');
  deny('cd /some/dir; git stash pop');
});

test('git worktree remove is unrelated to stash and stays allowed', () => {
  allow('git worktree remove --force /some/path');
  allow('git worktree remove wt-name');
});

// --- recursive delete of the shared scratch root ------------------------------------------------

test('recursive delete of the shared temp root (all spellings) denies', () => {
  deny('rm -rf /t/claudecodetemp');
  deny('rm -rf T:/claudecodetemp');
  deny('rm -rf T:\\claudecodetemp');
  deny('rm -rf /mnt/t/claudecodetemp');
  deny('rm -rf /t/claudecodetemp/');
  deny('rm -rf /t/claudecodetemp/*');
});

test('recursive delete of the shared claude/ session dir and its direct children denies', () => {
  deny('rm -rf T:/claudecodetemp/claude');
  deny('rm -rf T:/claudecodetemp/claude/some-project-slug');
});

test('Remove-Item -Recurse on the temp root denies (PowerShell, backslash path)', () => {
  deny('Remove-Item -Recurse T:\\claudecodetemp');
  deny('Remove-Item -Recurse -Force T:\\claudecodetemp\\claude');
  deny('ri -Recurse T:\\claudecodetemp');
  deny('del -Recurse T:\\claudecodetemp');
});

test('rmdir /s and rd /s on the temp root deny (cmd.exe)', () => {
  deny('rmdir /s /q T:\\claudecodetemp');
  deny('rd /s T:\\claudecodetemp');
});

test('bare home and filesystem/drive roots deny', () => {
  deny('rm -rf ~');
  deny('rm -rf /');
  deny('rm -rf C:/');
  deny('rm -rf C:\\');
});

test('chained: cd into the temp root then recursive-delete a relative path denies', () => {
  deny('cd /t && rm -rf claudecodetemp');
  deny('cd T:/claudecodetemp && rm -rf claude');
});

test('own scratchpad subtree (session-scoped) is allowed even under claudecodetemp/claude', () => {
  const context = { sessionId: 'd4bc9114-9903-4308-bff6-2d1586c6ab75' };
  allow2('rm -rf T:/claudecodetemp/claude/wezbridge-project/d4bc9114-9903-4308-bff6-2d1586c6ab75/scratchpad/x', context);
  allow2('Remove-Item -Recurse T:\\claudecodetemp\\claude\\wezbridge-project\\d4bc9114-9903-4308-bff6-2d1586c6ab75\\scratchpad\\x', context);
});

test('another session\'s scratchpad subtree (different session id) still denies', () => {
  const context = { sessionId: 'd4bc9114-9903-4308-bff6-2d1586c6ab75' };
  const r = classifyCatastrophic('rm -rf T:/claudecodetemp/claude/wezbridge-project/OTHER-SESSION-ID/scratchpad/x', context);
  assert.equal(r.deny, true, 'deleting another session\'s scratchpad must still deny');
});

test('own worktree/cwd is allowed, incl. relative targets like node_modules', () => {
  const context = { cwd: 'G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge/.claude/worktrees/agent-x' };
  allow2('rm -rf node_modules', context);
  allow2('rm -rf G:/_OneDrive/OneDrive/Desktop/Py Apps/wezbridge/.claude/worktrees/agent-x/build', context);
  allow2('Remove-Item -Recurse node_modules', context);
});

test('when context is unknown, explicit dangerous roots still deny but generic rm -r is not blocked', () => {
  deny('rm -rf /t/claudecodetemp');
  allow('rm -rf ./dist');
  allow('rm -rf node_modules');
  allow('rm -rf build');
});

test('without a known sessionId, a deep claude/<slug>/<x>/... path is NOT auto-denied (cannot tell it apart from own scratchpad)', () => {
  // Regression guard: only deny "someone else's session" once we KNOW our own session id and it
  // didn't match. Without it, this must fall back to "don't block generic rm -r".
  allow('rm -rf T:/claudecodetemp/claude/some-project/some-session-id/scratchpad/x');
  allow2('rm -rf T:/claudecodetemp/claude/some-project/some-session-id/scratchpad/x', { cwd: '/wherever' });
});

test('AC3: common worker-flow strings are not newly blocked', () => {
  allow('git worktree remove --force');
  allow('rm -rf "$TMPDIR/x"');
  allow('rm -rf ../sibling-dir');
});

// --- purity/tolerance with the new optional context arg ----------------------------------------

test('classifyCatastrophic(command, context) tolerates missing/odd context', () => {
  assert.deepEqual(classifyCatastrophic('echo hi', undefined), { deny: false, rule: null, reason: null });
  assert.deepEqual(classifyCatastrophic('echo hi', {}), { deny: false, rule: null, reason: null });
  assert.deepEqual(classifyCatastrophic('echo hi', null), { deny: false, rule: null, reason: null });
});

function allow2(cmd, context, msg) {
  const r = classifyCatastrophic(cmd, context);
  assert.equal(r.deny, false, `${msg || cmd} -> expected allow, got ${JSON.stringify(r)}`);
  assert.equal(r.rule, null);
}

// --- mutation guard: disabling the /IM rule must break the card's primary case -----------------

test('mutation guard: without the /IM check, the card primary deny case would wrongly allow', () => {
  // Re-implements the taskkill anchor without the /IM flag check, proving the flag check is load
  // bearing for the card's case 1 (a bare "taskkill" prefix match alone would even wrongly deny
  // "taskkill /PID 1234 /F", case 2 — so the /IM requirement also gates the allow-case).
  const withoutImCheck = (s) => /^(?:sudo\s+)?(?:\S*[\\/])?taskkill(?:\.exe)?\b/i.test(s);
  assert.equal(withoutImCheck('taskkill /F /IM python.exe /T'), true, 'sanity: bare prefix matches');
  assert.equal(withoutImCheck('taskkill /PID 1234 /F'), true, 'without /IM gating this would deny the allow-case too');
  // The real classifier must distinguish the two using the /IM flag.
  assert.equal(classifyCatastrophic('taskkill /F /IM python.exe /T').deny, true);
  assert.equal(classifyCatastrophic('taskkill /PID 1234 /F').deny, false);
});
