'use strict';
/**
 * no-new-coordinator.test.cjs — makes a 2026-04-30 decision executable.
 *
 * The repo's own debate concluded "stop building autonomous multi-pane
 * orchestrators on generic LLM CLIs" and predicted its own violation: *"without
 * P5, in 6 weeks we will rationalize iteration 4 the same way we rationalized
 * 1->2 and 2->3."* It was violated three times, because the decision was prose
 * and prose cannot fail.
 *
 * This can fail. It is not here to forbid coordinators — it is here to make
 * adding one a DELIBERATE, VISIBLE act: put it in src/COORDINATORS.json with the
 * operator ruling that authorised it. Ten seconds of work, impossible to do by
 * accident.
 *
 * ANTI-WOLF: every existing module is pre-listed, so this is green on the day it
 * ships and stays green for anyone not adding a new background driver. An
 * enforcement artifact that fires on compliant behaviour is worse than none —
 * it trains people to route around it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ALLOWLIST = path.join(SRC, 'COORDINATORS.json');

/** Filenames that announce a background driver. */
const NAME_RE = /(waker|watchdog|sentinel|orchestrat|heartbeat|monitor|scheduler)/i;
/** The behavioural shape: a timer loop that types into panes. */
const SEND_RE = /(sendText|sendPrompt|send_prompt|sendTextBracketed|sendTextNoEnter)/;

function listModules(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { out.push(...listModules(path.join(dir, entry.name), rel)); continue; }
    if (entry.name.endsWith('.cjs')) out.push(rel);
  }
  return out;
}

/**
 * PURE: given a module's name and source, does it have the coordinator shape?
 * Split out so the rule itself is testable without touching the filesystem —
 * a check whose logic has never been exercised is not a check.
 */
function isCoordinator(relPath, source) {
  if (NAME_RE.test(path.basename(relPath))) return true;
  return source.includes('setInterval') && SEND_RE.test(source);
}

test('no NEW always-on coordinator module without an operator ruling', () => {
  const allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
  const allowed = new Set(allow.allowed.map((e) => e.module.replace(/^src\//, '')));

  const offenders = listModules(SRC).filter((rel) => {
    if (allowed.has(rel)) return false;
    return isCoordinator(rel, fs.readFileSync(path.join(SRC, rel), 'utf8'));
  });

  assert.deepStrictEqual(offenders, [],
    `New always-on coordinator module(s) detected: ${offenders.join(', ')}.\n\n` +
    'This repo has shipped six autonomous-orchestrator iterations and abandoned all six;\n' +
    'the failure was never the code, it was that the model became load-bearing for LIVENESS.\n' +
    'If the operator authorised this one, add it to src/COORDINATORS.json with the ruling.\n' +
    'If nobody authorised it, that is the finding — say so out loud rather than shipping it.');
});

test('every allowlist entry still exists and carries a ruling', () => {
  const allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
  for (const entry of allow.allowed) {
    assert.ok(fs.existsSync(path.join(SRC, entry.module.replace(/^src\//, ''))),
      `allowlist names ${entry.module} but it does not exist — stale entries hide real ones`);
    assert.ok(entry.ruling && entry.ruling.length > 10,
      `${entry.module} has no ruling — an allowlist without reasons is just a mute button`);
  }
});

// ---------------------------------------------------------------------------
// The rule itself, exercised directly. Without these, the check above could be
// silently inert (matching nothing) and still pass forever.
// ---------------------------------------------------------------------------

test('the rule FIRES on a coordinator-shaped module (name)', () => {
  assert.strictEqual(isCoordinator('my-new-waker.cjs', 'const x = 1;'), true);
  assert.strictEqual(isCoordinator('fleet-monitor.cjs', ''), true);
});

test('the rule FIRES on the behavioural shape even with an innocent name', () => {
  const src = 'setInterval(() => { wez.sendText(paneId, "do the thing"); }, 60000);';
  assert.strictEqual(isCoordinator('helper.cjs', src), true,
    'a timer loop that types into panes IS the shape, whatever it is called');
});

test('the rule does NOT fire on ordinary modules', () => {
  assert.strictEqual(isCoordinator('task-parser.cjs', 'function parse(md) { return []; }'), false);
  assert.strictEqual(isCoordinator('poller.cjs', 'setInterval(() => fetchStuff(), 1000);'), false,
    'a timer alone is not a coordinator — plenty of loops never drive an agent');
  assert.strictEqual(isCoordinator('sender.cjs', 'wez.sendText(1, "hi");'), false,
    'a one-shot send is not a coordinator either — it takes BOTH');
});

module.exports = { isCoordinator };
