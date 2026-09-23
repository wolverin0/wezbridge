'use strict';
/**
 * lane-hooks.test.cjs — T-0547: orchestrator-lane enforcement hooks in ~/.claude/hooks.
 * Spawns lane-guard.cjs (PreToolUse), lane-routing-context.cjs (UserPromptSubmit) and lane-route-audit.cjs (Stop)
 * with fixture payloads against a temp WEZ_INTEL_DIR; asserts deny/allow/updatedInput, the route-audit.jsonl lines,
 * the settings.json wiring (runs the registered command strings), and lane-guard p95 latency < 150 ms over 50 runs.
 * Hooks dir: env LANE_HOOKS_DIR or ~/.claude/hooks (suite skips when absent).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = process.env.LANE_HOOKS_DIR || path.join(os.homedir(), '.claude', 'hooks');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const GUARD = path.join(HOOKS, 'lane-guard.cjs');
const CONTEXT = path.join(HOOKS, 'lane-routing-context.cjs');
const STOP = path.join(HOOKS, 'lane-route-audit.cjs');
const skip = !fs.existsSync(GUARD) && `lane hooks not installed in ${HOOKS}`;

const TIERS = {
  version: 1,
  models: {
    'claude-fable-5-1': { alias: 'fable' }, 'claude-opus-5-5': { alias: 'opus' },
    'claude-sonnet-5': { alias: 'sonnet' }, 'claude-haiku-4-5-20251001': { alias: 'haiku' },
    'gpt-6-luna': { runtime: 'codex' },
  },
  tiers: {
    T1: { claude: { model: 'claude-haiku-4-5-20251001', effort: null }, codex: { model: 'gpt-6-luna', effort: 'low' } },
    T2: { claude: { model: 'claude-sonnet-5', effort: 'medium' } },
    T3: { claude: { model: 'claude-sonnet-5', effort: 'high' } },
    T4: { claude: { model: 'claude-opus-5-5', effort: 'high' } },
    V: { claude: { model: 'claude-sonnet-5', effort: 'high' } },
  },
  classes: { a: 'T1', b: 'T2', c: 'T3', d: 'T4' },
};

function mkIntel({ tiers = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-hooks-'));
  fs.mkdirSync(path.join(dir, 'tasks'));
  if (tiers) fs.writeFileSync(path.join(dir, 'model-tiers.json'), JSON.stringify(TIERS));
  fs.writeFileSync(path.join(dir, 'tasks', 'T-9001.json'), JSON.stringify({ id: 'T-9001', tier: 'T1' }));
  fs.writeFileSync(path.join(dir, 'tasks', 'T-9002.json'), JSON.stringify({ id: 'T-9002', model: 'claude-sonnet-5', effort: 'medium' }));
  return dir;
}

function run(script, payload, { lane = 'wezbridge', intel, extraEnv = {} } = {}) {
  const env = { ...process.env, WEZ_INTEL_DIR: intel };
  delete env.WEZ_LANE; delete env.WEZ_ORCH_BYPASS;
  Object.assign(env, extraEnv);
  if (lane) env.WEZ_LANE = lane;
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  assert.equal(r.status, 0, `exit ${r.status} stderr=${r.stderr}`);
  return { raw: r.stdout, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

function auditLines(intel) {
  const p = path.join(intel, 'route-audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const pre = (tool_name, tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name, tool_input, ...extra });
const decision = (out) => out.json?.hookSpecificOutput?.permissionDecision;

test('(a) Edit by the orchestrator (WEZ_LANE set, no agent_id) is denied with the ROUTE reason', { skip }, () => {
  const intel = mkIntel();
  const out = run(GUARD, pre('Edit', { file_path: 'x.js', old_string: 'a', new_string: 'b' }), { intel });
  assert.equal(decision(out), 'deny');
  assert.match(out.json.hookSpecificOutput.permissionDecisionReason, /delegá a un worker \(ROUTE\)/);
  for (const t of ['Write', 'MultiEdit', 'NotebookEdit']) assert.equal(decision(run(GUARD, pre(t, { file_path: 'x' }), { intel })), 'deny', t);
  const log = auditLines(intel);
  assert.equal(log.length, 4);
  assert.deepEqual(Object.keys(log[0]).slice(0, 7).sort(), ['decision', 'lane', 'model_in', 'model_out', 'reason', 'tool', 'ts'].sort());
  assert.equal(log[0].lane, 'wezbridge');
});

test('(b) Edit inside a subagent (agent_id present) is allowed', { skip }, () => {
  const intel = mkIntel();
  const out = run(GUARD, pre('Edit', { file_path: 'x.js' }, { agent_id: 'agent-123', agent_type: 'general-purpose' }), { intel });
  assert.equal(out.json, null);
});

test('(c) Bash: read-only allowed, mutating denied', { skip }, () => {
  const intel = mkIntel();
  const allowed = ['git status', 'git log --oneline -5', 'git diff HEAD~1', 'ls -la', 'cat a.txt | grep foo', 'grep -rn x src 2>/dev/null',
    'curl -s https://example.com/health', 'node "G:/Py Apps/_docs-curation/ledger.cjs" list', 'orca terminal read 3', 'npm test 2>&1 | tail -5',
    'echo "a > b"'];
  const denied = ['git commit -m x', 'git push origin main', 'git merge dev', 'git rebase main', 'rm -rf build', 'mv a b', 'cp a b',
    "sed -i 's/a/b/' f", 'npm install lodash', 'pip install requests', 'docker run alpine', 'docker exec c bash -c "ls"',
    'echo hi > out.txt', 'cat x >> log.md', 'node ledger.cjs list; rm x'];
  for (const c of allowed) assert.equal(decision(run(GUARD, pre('Bash', { command: c }), { intel })), undefined, `should allow: ${c}`);
  for (const c of denied) assert.equal(decision(run(GUARD, pre('Bash', { command: c }), { intel })), 'deny', `should deny: ${c}`);
  assert.equal(decision(run(GUARD, pre('PowerShell', { command: 'Set-Content a.txt hi' }), { intel })), 'deny');
});

test('(d) Agent with model opus but card tier T1 -> updatedInput.model = haiku (subagent_type kept)', { skip }, () => {
  const intel = mkIntel();
  const input = { description: 'census', prompt: 'task_id=T-9001 count files', subagent_type: 'Explore', model: 'opus' };
  const out = run(GUARD, pre('Agent', input), { intel });
  const h = out.json.hookSpecificOutput;
  assert.equal(h.permissionDecision, 'allow');
  assert.equal(h.updatedInput.model, 'haiku');
  assert.equal(h.updatedInput.subagent_type, 'Explore');
  assert.equal(h.updatedInput.prompt, input.prompt);
  // card with explicit model field
  assert.equal(run(GUARD, pre('Agent', { ...input, prompt: 'task_id=T-9002 fix' }), { intel }).json.hookSpecificOutput.updatedInput.model, 'sonnet');
  // tier token in the prompt, no card
  assert.equal(run(GUARD, pre('Agent', { ...input, model: 'haiku', prompt: 'tier=T4 plan it' }), { intel }).json.hookSpecificOutput.updatedInput.model, 'opus');
  // already correct -> no rewrite
  assert.equal(run(GUARD, pre('Agent', { ...input, model: 'haiku' }), { intel }).json, null);
  const log = auditLines(intel);
  assert.equal(log[0].decision, 'rewrite');
  assert.equal(log[0].model_in, 'opus');
  assert.equal(log[0].model_out, 'haiku');
});

test('(d2) Agent routing tolerates a missing model-tiers.json (built-in default)', { skip }, () => {
  const intel = mkIntel({ tiers: false });
  const out = run(GUARD, pre('Agent', { prompt: 'task_id=T-9001 x', subagent_type: 'Explore', model: 'opus' }), { intel });
  assert.equal(out.json.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.equal(auditLines(intel)[0].tiers_fallback, true);
});

test('(e) hooks are inactive when WEZ_LANE is unset: allow everything, no context, no log', { skip }, () => {
  const intel = mkIntel();
  assert.equal(run(GUARD, pre('Edit', { file_path: 'x' }), { intel, lane: null }).json, null);
  assert.equal(run(GUARD, pre('Bash', { command: 'git commit -m x' }), { intel, lane: null }).json, null);
  assert.equal(run(GUARD, pre('Agent', { prompt: 'tier=T1', model: 'opus' }), { intel, lane: null }).json, null);
  assert.equal(run(CONTEXT, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, { intel, lane: null }).json, null);
  assert.deepEqual(run(STOP, { hook_event_name: 'Stop' }, { intel, lane: null }).json, {});
  assert.equal(fs.existsSync(path.join(intel, 'route-audit.jsonl')), false);
});

test('WEZ_ORCH_BYPASS=1 allows an orchestrator Edit and logs the bypass', { skip }, () => {
  const intel = mkIntel();
  assert.equal(run(GUARD, pre('Edit', { file_path: 'x' }), { intel, extraEnv: { WEZ_ORCH_BYPASS: '1' } }).json, null);
  assert.equal(auditLines(intel)[0].decision, 'bypass');
});

test('UserPromptSubmit injects the routing table + ROUTE reminder in <= 600 chars', { skip }, () => {
  const intel = mkIntel();
  const out = run(CONTEXT, { hook_event_name: 'UserPromptSubmit', prompt: 'next card' }, { intel });
  const ctx = out.json.hookSpecificOutput.additionalContext;
  assert.equal(out.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(ctx.length <= 600, `len ${ctx.length}`);
  assert.match(ctx, /\[ROUTE\] task_id=T-NNNN/);
  assert.match(ctx, /a:T1=haiku/);
  assert.match(ctx, /d:T4=opus\/high/);
});

function writeTranscript(dir, entries) {
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return p;
}
const u = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const tr = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const a = (...blocks) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } });

test('Stop appends one line per close with inline/subagent mode and size, never blocks', { skip }, () => {
  const intel = mkIntel();
  const t1 = writeTranscript(intel, [
    u('old prompt'), a({ type: 'tool_use', name: 'Edit', input: { file_path: 'old.js' } }),
    u('do T-1'),
    a({ type: 'text', text: '[ROUTE] task_id=T-1 kind=fix size=S target=inline model=opus effort=medium' }),
    a({ type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } }), tr(),
    a({ type: 'text', text: 'done' }),
  ]);
  const o1 = run(STOP, { hook_event_name: 'Stop', session_id: 's1', transcript_path: t1 }, { intel });
  assert.deepEqual(o1.json, {});
  const t2 = writeTranscript(intel, [
    u('do T-2'), a({ type: 'tool_use', name: 'Agent', input: { prompt: 'x' } }), tr(), a({ type: 'text', text: 'delegated' }),
  ]);
  run(STOP, { hook_event_name: 'Stop', session_id: 's1', transcript_path: t2 }, { intel });
  const [l1, l2] = auditLines(intel);
  assert.equal(l1.event, 'stop');
  assert.equal(l1.has_route, true);
  assert.equal(l1.route_size, 'S');
  assert.equal(l1.route_target, 'inline');
  assert.equal(l1.mode, 'inline');
  assert.equal(l1.inline_edits, 1); // the Edit before the last real prompt is not counted
  assert.equal(l1.edit_without_agent_id, true);
  assert.equal(l2.has_route, false);
  assert.equal(l2.mode, 'subagent');
  assert.equal(l2.agent_calls, 1);
  // missing transcript still logs and exits 0 with {}
  assert.deepEqual(run(STOP, { hook_event_name: 'Stop', transcript_path: path.join(intel, 'nope.jsonl') }, { intel }).json, {});
  assert.equal(auditLines(intel).length, 3);
});

test('(f) WIRING: settings.json registers the three hooks (timeout 5) and each registered command runs', { skip: skip || (!fs.existsSync(SETTINGS) && 'no settings.json') }, () => {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const find = (event, file) => {
    for (const group of s.hooks[event] || []) for (const h of group.hooks || []) if (String(h.command).includes(file)) return { group, h };
    return null;
  };
  const g = find('PreToolUse', 'lane-guard.cjs');
  assert.ok(g, 'lane-guard not wired');
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'Agent']) assert.ok(g.group.matcher.split('|').includes(t), `matcher lacks ${t}`);
  const c = find('UserPromptSubmit', 'lane-routing-context.cjs');
  const st = find('Stop', 'lane-route-audit.cjs');
  assert.ok(c && st, 'context/stop hooks not wired');
  for (const x of [g, c, st]) assert.equal(x.h.timeout, 5);
  // Run the exact registered command strings through a shell with a real payload per event.
  const intel = mkIntel();
  const sh = (cmd, payload) => {
    const r = spawnSync(cmd, { shell: true, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, WEZ_LANE: 'wezbridge', WEZ_INTEL_DIR: intel } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(sh(g.h.command, pre('Write', { file_path: 'x' })).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(sh(c.h.command, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }).hookSpecificOutput.additionalContext, /\[ROUTE\]/);
  assert.deepEqual(sh(st.h.command, { hook_event_name: 'Stop', transcript_path: writeTranscript(intel, [u('x')]) }), {});
});

test('(g) latency: lane-guard p95 < 150 ms over 50 runs', { skip }, () => {
  const intel = mkIntel();
  const times = [];
  for (let i = 0; i < 50; i++) {
    const t0 = process.hrtime.bigint();
    run(GUARD, pre(i % 2 ? 'Bash' : 'Edit', { command: 'git status', file_path: 'x' }), { intel });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((x, y) => x - y);
  const p50 = times[24]; const p95 = times[Math.ceil(0.95 * 50) - 1];
  console.log(`lane-guard latency ms: p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} max=${times[49].toFixed(1)}`);
  assert.ok(p95 < 150, `p95 ${p95.toFixed(1)} ms`);
});
