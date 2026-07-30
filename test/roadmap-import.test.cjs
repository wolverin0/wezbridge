'use strict';
// R.3 exit criteria, hermetic. WEZBRIDGE_INTEL_DIR must be set BEFORE the
// requires — both ledger.cjs and roadmap-import.cjs freeze it at module load.
// node --test runs each file in its own process, so this cannot leak into the
// live ledger.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-import-'));
process.env.WEZBRIDGE_INTEL_DIR = path.join(tmp, 'intel');
fs.mkdirSync(path.join(tmp, 'intel', 'tasks'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'repo'), { recursive: true });

const { test, after } = require('node:test');
const assert = require('node:assert');
const { importRepo } = require('../../_docs-curation/roadmap-import.cjs');
const ledger = require('../../_docs-curation/ledger.cjs');

const ROADMAP = path.join(tmp, 'repo', 'ROADMAP.md');

// Minimal registries in the hermetic intel dir. Absolute repo path on purpose.
fs.writeFileSync(path.join(tmp, 'intel', 'repos.json'), JSON.stringify({
  repos: {
    pilot: { path: path.join(tmp, 'repo'), status: 'active' },
    gated: { path: path.join(tmp, 'repo'), status: 'pending_operator', pending: 'a ruling' },
  },
}));
fs.writeFileSync(path.join(tmp, 'intel', 'kinds.json'), JSON.stringify({
  kinds: {
    general: { fallback_mode: 'read_mostly', fallback_gate: null },
    docs: { fallback_mode: 'scoped_write', fallback_gate: null },
    'customer-send': { fallback_mode: 'read_mostly', fallback_gate: 'operator' },
  },
}));

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function write(md) { fs.writeFileSync(ROADMAP, md); }

test('dry-run plans creations and writes NOTHING', () => {
  write('- [ ] fix the widget\n- [x] already done thing\n');
  const before = fs.readFileSync(ROADMAP, 'utf8');
  const plan = importRepo('pilot');
  assert.strictEqual(plan.create.length, 1);
  assert.strictEqual(plan.mode, 'dry-run');
  assert.strictEqual(fs.readFileSync(ROADMAP, 'utf8'), before, 'dry-run must not touch the file');
  assert.strictEqual(ledger.allTasks().length, 0, 'dry-run must not create tasks');
});

test('apply is idempotent: run twice -> identical task count, zero duplicates', () => {
  // The R.3 exit criterion verbatim.
  write('- [ ] fix the widget\n- [ ] docs pass | second item\n');
  const p1 = importRepo('pilot', { apply: true });
  assert.strictEqual(p1.create.length, 2);
  const countAfterFirst = ledger.allTasks().length;
  const p2 = importRepo('pilot', { apply: true });
  assert.strictEqual(p2.create.length, 0, 'second run must find ids, create nothing');
  assert.strictEqual(p2.existing.length, 2);
  assert.strictEqual(ledger.allTasks().length, countAfterFirst);
});

test('write-back puts the T-id in the line, and the id — not the text — is identity', () => {
  const text = fs.readFileSync(ROADMAP, 'utf8');
  assert.match(text, /- \[ \] T-\d{4} \| fix the widget/);
  // Reword the title AFTER write-back: no new task may be minted.
  fs.writeFileSync(ROADMAP, text.replace('fix the widget', 'repair the widget thoroughly'));
  const before = ledger.allTasks().length;
  const plan = importRepo('pilot', { apply: true });
  assert.strictEqual(plan.create.length, 0, 'reworded title must not mint a second task');
  assert.strictEqual(ledger.allTasks().length, before);
});

test('a gated kind is born blocked at create — the FSM forbids patching it later', () => {
  write('- [ ] kind=customer-send | send the winback message\n');
  const plan = importRepo('pilot', { apply: true });
  assert.strictEqual(plan.create[0].state, 'blocked');
  const task = ledger.allTasks().find((t) => t.id === plan.create[0].id);
  assert.strictEqual(task.state, 'blocked');
});

test('section-level {kind=...} inheritance reaches untagged items', () => {
  write('## Docs work {kind=docs}\n- [ ] write the guide\n\n## Other\n- [ ] untagged item\n');
  const plan = importRepo('pilot');
  assert.strictEqual(plan.create[0].kind, 'docs');
  assert.strictEqual(plan.create[1].kind, 'general', 'a new heading without a tag resets inheritance');
});

test('unknown kind resolves to general AND is flagged, never honoured silently', () => {
  write('- [ ] kind=made-up-thing | mystery work\n');
  const plan = importRepo('pilot');
  assert.strictEqual(plan.create[0].kind, 'general');
  assert.strictEqual(plan.unknown_kinds.length, 1);
  assert.strictEqual(plan.unknown_kinds[0].declared, 'made-up-thing');
});

test('an id-tagged line with no ledger row is an ORPHAN, never re-minted', () => {
  write('- [ ] T-9876 | ghost item\n');
  const plan = importRepo('pilot', { apply: true });
  assert.strictEqual(plan.create.length, 0);
  assert.strictEqual(plan.orphans.length, 1);
  assert.strictEqual(plan.orphans[0].id, 'T-9876');
});

test('import refuses non-active repos — pending_operator is a hard stop', () => {
  assert.throws(() => importRepo('gated'), /pending_operator/);
});

test('crash-safety: same normalized line re-imports to the SAME task via origin_key', () => {
  // Simulate create-succeeded-but-write-back-lost: strip the id from the line.
  write('- [ ] docs pass | second item\n');
  const before = ledger.allTasks().length;
  const plan = importRepo('pilot', { apply: true });
  assert.strictEqual(ledger.allTasks().length, before,
    'origin_key must re-find the existing task instead of duplicating');
  assert.ok(plan.create[0].id, 'the write-back still restores the id to the line');
});
