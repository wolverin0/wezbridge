'use strict';
/**
 * routine-findings-single-reader.test.cjs — ONE interpreter for findings_file.
 *
 * THIS TEST IS THE DELIVERABLE OF T-0147, not the dedupe it accompanies.
 *
 * History it exists to stop repeating: the resolution of a run record's
 * `findings_file` (relative paths resolve against the routine-findings dir, NOT
 * the process cwd) was written three times — routine-audit.cjs, which owns the
 * contract, plus copies in fleet-board.cjs and board-app/server.cjs. Both copies
 * carried the same cwd bug, and both were found and fixed SEPARATELY, weeks
 * apart, each fix leaving the other copy broken. A fourth consumer would have
 * copied it wrong again.
 *
 * Prose could not stop that; two code comments explicitly warning about the cwd
 * were sitting next to the bug while it shipped. So the rule is executable: no
 * file outside the owner may mention `findings_file` at all. A new consumer must
 * either call loadRuns()/boardVerdict(), or come here and argue for an
 * allowlist entry — which is exactly the conversation that never happened the
 * first three times.
 *
 * The test is proven by mutation: adding a fourth copy turns it red. A guard
 * that has never been seen to fail is a guard that only describes the present.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The single owner of the findings_file contract. */
const OWNER = path.join('scripts', 'routine-audit.cjs');

/**
 * Files permitted to name `findings_file` without owning its interpretation.
 * Every entry needs a reason: an allowlist without reasons becomes a list of
 * everything anyone ever added.
 */
const ALLOWED = new Map([
  [OWNER, 'owns the contract — this is the one interpreter'],
  [path.join('scripts', 'orch-ctx-check.cjs'), 'writes the key into a run record; never resolves or reads it'],
  [path.join('test', 'routine-findings-single-reader.test.cjs'), 'this guard'],
  [path.join('test', 'routine-audit.test.cjs'), 'tests the owner directly'],
  [path.join('test', 'board-server.test.cjs'), 'builds run-record fixtures for the board API'],
  [path.join('test', 'fleet-board-routines.test.cjs'), 'builds run-record fixtures; asserts the resolution behaviour end to end'],
]);

// Note for anyone tempted to allowlist a consumer instead of fixing it: the two
// board files were caught by this guard on its first run, because their own
// comments named the identifier. They were reworded to "findings-file" rather
// than allowlisted. An allowlist entry means "this file does not interpret the
// contract" — it is not an escape hatch for one that does.

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vault', '.orchestrator', 'graphify-out', '.gitnexus']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.orchestrator') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(cjs|js|mjs|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every repo file that mentions findings_file, as repo-relative paths. */
function offenders() {
  return walk(ROOT)
    .filter((f) => fs.readFileSync(f, 'utf8').includes('findings_file'))
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => !ALLOWED.has(rel));
}

test('only routine-audit interprets findings_file — no fourth copy', () => {
  const found = offenders();
  assert.deepStrictEqual(found, [],
    found.length
      ? `These files reference findings_file without being allowlisted:\n  ${found.join('\n  ')}\n\n`
        + 'Call routine-audit loadRuns()/boardVerdict() instead of resolving the path yourself. '
        + 'That resolution has been written wrong twice already. If this file genuinely must name '
        + 'findings_file without interpreting it, add it to ALLOWED with a reason.'
      : 'clean');
});

test('the guard actually fires — a fourth copy turns it red', () => {
  // Without this, the test above only describes today's repo. Write a real
  // fourth copy into a real scanned directory, confirm it is caught, remove it.
  const planted = path.join(ROOT, 'scripts', '__fourth-copy-probe.cjs');
  assert.ok(!fs.existsSync(planted), 'probe path must be free before planting');
  fs.writeFileSync(planted, [
    "'use strict';",
    '// Temporary probe written by routine-findings-single-reader.test.cjs.',
    'const path = require("node:path");',
    'function resolveIt(rec, dir) {',
    '  return path.isAbsolute(rec.findings_file) ? rec.findings_file : path.join(dir, rec.findings_file);',
    '}',
    'module.exports = { resolveIt };',
    '',
  ].join('\n'));

  try {
    const found = offenders();
    assert.ok(found.includes(path.join('scripts', '__fourth-copy-probe.cjs')),
      `the guard did not catch a planted fourth copy — it is describing the present, not enforcing the rule. Saw: ${JSON.stringify(found)}`);
  } finally {
    fs.rmSync(planted, { force: true });
  }

  assert.deepStrictEqual(offenders(), [], 'probe removed, repo clean again');
});

test('both board consumers actually call the shared reader', () => {
  // The grep rule above is satisfied by a consumer that shows no routine data
  // at all. This asserts the positive: they read through the owner.
  for (const rel of [path.join('scripts', 'fleet-board.cjs'), path.join('board-app', 'server.cjs')]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Both spellings occur: a plain string literal, and path.join(...) pieces.
    assert.ok(src.includes('routine-audit.cjs'), `${rel} requires routine-audit`);
    assert.match(src, /loadRuns\(/, `${rel} calls loadRuns`);
    assert.match(src, /boardVerdict\(/, `${rel} calls boardVerdict`);
  }
});
