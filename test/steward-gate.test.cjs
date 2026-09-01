'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gate = require('../scripts/steward-gate.cjs');

const H = 3600000;
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

const finding = (over = {}) => ({
  id: 'T-0001', repo: 'brlite', state: 'ready', title: 'a task',
  owner: null, age_hours: 100, category: 'idle', why: 'nobody has picked this up', ...over,
});

// ---------------------------------------------------------------------------
// The gate exists to CONTRADICT "nothing needs you". These prove it can.
// ---------------------------------------------------------------------------

test('RED: a past-deadline finding with no ruling', () => {
  const r = gate.evaluate({ findings: [finding()], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'RED', 'an idle task at 100h with no ruling must fail the gate');
  assert.strictEqual(r.unruled[0].id, 'T-0001');
});

test('GREEN: a finding that has not reached its deadline yet', () => {
  const r = gate.evaluate({ findings: [finding({ age_hours: 12 })], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'GREEN', 'idle for 12h is not yet owed a ruling');
});

test('GREEN: cancelled is permanent', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'cancelled', why: 'dead project', at: iso(-500 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'a cancelled task must never be raised again');
});

test('GREEN: cancelled covers across categories — dead work has no category', () => {
  // T-0191, live case 2026-08-20/22: cancelled by operator decision with
  // category "observability" (its ledger KIND — no steward finding existed yet
  // to copy a category from), while the still-queued card later surfaced as
  // "idle". The permanent verdict must cover it anyway: a dead card cannot
  // honestly re-enter any category, and re-firing RED daily against a recorded
  // cancellation trains everyone to ignore the gate.
  const r = gate.evaluate({
    findings: [finding({ id: 'T-0191', category: 'idle', age_hours: 73 })],
    rulings: [{ task: 'T-0191', category: 'observability', ruling: 'cancelled', why: 'buried by operator decision', at: iso(-48 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'a cancelled task must never be raised again, whatever category its open card drifts into');
  // `resolved` keeps the category match (pinned below) — this exemption is for
  // `cancelled` alone, and a deferral must still re-judge on category change.
  assert.strictEqual(
    gate.rulingCovers(
      { task: 'T-1', category: 'idle', ruling: 'deferred', until: iso(100 * H), at: iso(0) },
      { id: 'T-1', category: 'abandoned-lease', age_hours: 10 }, NOW),
    false, 'a deferral issued while idle must not silence an abandoned-lease');
});

test('GREEN: operator-gated is permanent', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'operator-gated', at: iso(-999 * H) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'GREEN', 'waiting on the operator IS the correct state');
});

// ---------------------------------------------------------------------------
// THE ANTI-WOLF PROPERTY — the veto condition for shipping this at all.
// An artifact that fires on compliant behaviour is worse than none.
// ---------------------------------------------------------------------------

test('ANTI-WOLF: a deferred task stays green across many ticks and ages', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', why: 'parked', until: iso(240 * H), at: iso(0) }];
  for (let tick = 0; tick < 25; tick += 1) {
    const now = NOW + tick * 4 * H;              // a tick every 4h for ~4 days
    const r = gate.evaluate({ findings: [finding({ age_hours: 100 + tick * 4 })], rulings, now });
    assert.strictEqual(r.verdict, 'GREEN', `tick ${tick}: a correctly parked task must not fire`);
  }
});

test('a deferral RE-RAISES once its until passes', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(10 * H), at: iso(0) }];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 9 * H }).verdict, 'GREEN');
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 11 * H }).verdict, 'RED',
    'a deferral is a pause, not an erasure');
});

test('a deferral with NO until is not a ruling — a shrug must not silence anything', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'deferred', why: 'later', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
});

// ---------------------------------------------------------------------------
// Situation changes must re-open the judgement.
// ---------------------------------------------------------------------------

test('a ruling does NOT carry over when the category changes', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(500 * H), at: iso(0) }];
  const r = gate.evaluate({ findings: [finding({ category: 'abandoned-lease', age_hours: 30 })], rulings, now: NOW });
  assert.strictEqual(r.verdict, 'RED', 'parked-while-idle must not silence a crashed lease');
});

test('dispatched expires after the grace window so a swallowed dispatch resurfaces', () => {
  const rulings = [{ task: 'T-0001', category: 'idle', ruling: 'dispatched', at: iso(0) }];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 5 * H }).verdict, 'GREEN');
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 30 * H }).verdict, 'RED',
    'if a dispatch never moved the task, the gate must ask again');
});

test('the LATEST ruling wins, so a decision can be revised by appending', () => {
  const rulings = [
    { task: 'T-0001', category: 'idle', ruling: 'deferred', until: iso(1 * H), at: iso(-10 * H) },
    { task: 'T-0001', category: 'idle', ruling: 'cancelled', at: iso(-1 * H) },
  ];
  assert.strictEqual(gate.evaluate({ findings: [finding()], rulings, now: NOW + 50 * H }).verdict, 'GREEN');
});

test('awaiting-operator is never gated — it is the correct resting state', () => {
  const r = gate.evaluate({ findings: [finding({ category: 'awaiting-operator', age_hours: 9999 })], rulings: [], now: NOW });
  assert.strictEqual(r.verdict, 'GREEN');
});

test('an unknown ruling word covers nothing', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-0001', category: 'idle', ruling: 'noted', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED', '"noted" is narration, and narration is what this gate exists to defeat');
});

test('a ruling for a DIFFERENT task does not cover this one', () => {
  const r = gate.evaluate({
    findings: [finding()],
    rulings: [{ task: 'T-9999', category: 'idle', ruling: 'cancelled', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
});

test('mixed board: one ruled, one not — RED, and it names the unruled one', () => {
  const r = gate.evaluate({
    findings: [finding({ id: 'T-A' }), finding({ id: 'T-B' })],
    rulings: [{ task: 'T-A', category: 'idle', ruling: 'cancelled', at: iso(0) }],
    now: NOW,
  });
  assert.strictEqual(r.verdict, 'RED');
  assert.strictEqual(r.unruled.length, 1);
  assert.strictEqual(r.unruled[0].id, 'T-B');
});

// ---------------------------------------------------------------------------
// The gate must not go blind when the operator owes something
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');
const gatePath = require('node:path').join(__dirname, '..', 'scripts', 'steward-gate.cjs');

function runGate(args, intelDir) {
  try {
    const stdout = execFileSync(process.execPath, [gatePath, ...args],
      { encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intelDir } });
    return { code: 0, stdout };
  } catch (e) { return { code: e.status, stdout: String(e.stdout || '') }; }
}

test('a steward that exits NON-ZERO still yields a usable report', () => {
  // MUST exercise the SPAWNED steward, not --from. The first version of this
  // test used --from, which never reaches execFileSync at all, so removing the
  // whole fix left it green: a test passing for the wrong reason, again.
  // Here the REAL steward runs against a real ledger containing an
  // operator-gated blocked task, which makes it genuinely exit 1.
  const os = require('node:os'); const fsx = require('node:fs'); const p = require('node:path');
  const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'gate-spawn-'));
  fsx.mkdirSync(p.join(dir, 'tasks'));
  const old = new Date(Date.now() - 400 * 3600000).toISOString();
  // makes the steward exit 1
  fsx.writeFileSync(p.join(dir, 'tasks', 'T-GATE.json'), JSON.stringify({
    id: 'T-GATE', repo: 'r', state: 'blocked', gate: 'operator',
    blocker: 'operator owes an answer', updated_at: old, title: 'gated',
  }));
  // and an unruled idle task, so a gate that really evaluated must say RED
  fsx.writeFileSync(p.join(dir, 'tasks', 'T-IDLE.json'), JSON.stringify({
    id: 'T-IDLE', repo: 'r', state: 'ready', updated_at: old, title: 'idle',
  }));
  fsx.writeFileSync(p.join(dir, 'rulings.jsonl'), '');

  const res = runGate([], dir);
  assert.notStrictEqual(res.code, 3, 'UNKNOWN here means the gate went blind because the steward exited 1');
  assert.strictEqual(res.code, 1, 'it must reach the RED verdict the findings warrant');
  assert.match(res.stdout, /T-IDLE/);
});

test('a report supplied via --from is validated the same way', () => {
  // fleet-steward exits 1 on purpose when the operator personally owes
  // something, and execFileSync throws on any non-zero exit. That made the gate
  // report UNKNOWN precisely when an operator decision was pending — blind in
  // the one situation it exists to surface. Found 2026-08-14. A report is valid
  // because it PARSES, not because the exit code was 0.
  const os = require('node:os'); const fsx = require('node:fs'); const p = require('node:path');
  const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'gate-exit-'));
  const findings = p.join(dir, 'findings.json');
  fsx.writeFileSync(findings, JSON.stringify({
    findings: [{ id: 'T-X', repo: 'r', category: 'idle', age_hours: 999, title: 't' }],
  }));
  fsx.writeFileSync(p.join(dir, 'rulings.jsonl'), '');
  const res = runGate(['--from', findings], dir);
  assert.strictEqual(res.code, 1, 'must reach a RED verdict, not UNKNOWN(3)');
  assert.match(res.stdout, /RED/);
});

test('genuinely unreadable input is still UNKNOWN, never a verdict', () => {
  // The fix above must not have turned "cannot see" into "nothing found".
  const os = require('node:os'); const fsx = require('node:fs'); const p = require('node:path');
  const dir = fsx.mkdtempSync(p.join(os.tmpdir(), 'gate-unk-'));
  assert.strictEqual(runGate(['--from', p.join(dir, 'missing.json')], dir).code, 3, 'missing file');
  const bad = p.join(dir, 'bad.json');
  fsx.writeFileSync(bad, '{not json');
  assert.strictEqual(runGate(['--from', bad], dir).code, 3, 'unparseable');
  const wrong = p.join(dir, 'wrong.json');
  fsx.writeFileSync(wrong, '{"findings":"not an array"}');
  assert.strictEqual(runGate(['--from', wrong], dir).code, 3, 'right JSON, wrong shape');
});

test('`resolved` permanently covers a finding, and an unknown word never does', () => {
  // Added 2026-08-14 after the first autonomous turn reported that the enum had
  // no word for "harvested and closed" and had to log three closures as
  // `dispatched`. `cancelled` would have been just as wrong in the other
  // direction: it says the work is dead, not finished.
  const f = { id: 'T-1', category: 'stale-review', age_hours: 999 };
  const now = Date.parse('2026-08-14T12:00:00Z');
  const at = '2026-01-01T00:00:00Z';          // ancient on purpose: permanence is the point
  assert.strictEqual(gate.rulingCovers({ task: 'T-1', category: 'stale-review', ruling: 'resolved', at }, f, now), true);
  // and it must not silently cover a DIFFERENT category — closing a review says
  // nothing about the same task later going stale-failed
  assert.strictEqual(gate.rulingCovers({ task: 'T-1', category: 'idle', ruling: 'resolved', at }, f, now), false);
  // the enum stays closed: a plausible-looking word is not a ruling
  for (const word of ['closed', 'done', 'harvested', 'complete', '', null]) {
    assert.strictEqual(gate.rulingCovers({ task: 'T-1', category: 'stale-review', ruling: word, at }, f, now), false,
      `"${word}" was accepted as a ruling`);
  }
});

test('proposal-unledgered is gated at 24h: unruled past deadline goes RED', () => {
  // Slice 5 closes the loop: a lost proposal is not just a report line — after
  // 24h without a ruling the gate itself refuses to stay green. Without this
  // deadline the steward finding would be narration, which is what gets ignored.
  const pf = (age) => finding({
    id: 'proposal:board-push', category: 'proposal-unledgered', repo: 'wezbridge', age_hours: age,
  });
  assert.strictEqual(gate.DEADLINES['proposal-unledgered'], 24);
  assert.strictEqual(
    gate.evaluate({ findings: [pf(30)], rulings: [], now: NOW }).verdict, 'RED',
    'a proposal lost for 30h with no ruling must fail the gate');
  assert.strictEqual(
    gate.evaluate({ findings: [pf(10)], rulings: [], now: NOW }).verdict, 'GREEN',
    'under the deadline nothing is owed yet');
  assert.strictEqual(
    gate.evaluate({
      findings: [pf(30)],
      rulings: [{ task: 'proposal:board-push', category: 'proposal-unledgered', ruling: 'cancelled', why: 'proposal rejected', at: iso(0) }],
      now: NOW,
    }).verdict, 'GREEN',
    'a ruling clears it through the existing vocabulary — no new machinery');
});

test('approved covers awaiting-operator, and nothing else', () => {
  // ESTE TEST CAMBIO DE SIGNO EL 2026-09-01 (W1). Leer entero antes de tocarlo.
  //
  // La version anterior afirmaba que `approved` no cubria NADA, con un
  // argumento correcto: des-gatear es lo que saca la tarjeta del tablero, y
  // darle cobertura permanente dejaria a "si, hacelo" silenciando una tarea
  // para siempre mientras el trabajo no ocurre.
  //
  // Lo que ese razonamiento no separaba son DOS preguntas. `awaiting-operator`
  // es "el operador debe una respuesta": aprobar LA RESPONDE, y el hallazgo
  // tiene que dejar de sonar. `idle` es "nadie tomo esto": aprobar NO lo
  // responde, y una tarjeta aprobada que nadie levanta en 72h TIENE que volver
  // a sonar. El match de categoria es exactamente esa separacion, asi que la
  // consecuencia que preocupaba sigue viva y ahora esta afirmada abajo.
  //
  // Ademas `awaiting-operator` tiene deadline Infinity, o sea que hoy el gate
  // ni siquiera lo evalua; la cobertura importa para los consumidores que
  // preguntan "esta decision fue respondida?" sin pasar por el deadline.
  const now = Date.parse('2026-08-16T12:00:00Z');
  const at = '2026-08-16T11:00:00Z';
  assert.strictEqual(
    gate.rulingCovers(
      { task: 'T-1', category: 'awaiting-operator', ruling: 'approved', at },
      { id: 'T-1', category: 'awaiting-operator', age_hours: 999 }, now),
    true,
    'aprobar responde la pregunta del operador — eso es lo que `approved` cubre');
  // Sin categoria (el escritor no vio ningun hallazgo) sigue cubriendo SOLO la
  // pregunta del operador: la categoria que manda es la del HALLAZGO.
  assert.strictEqual(
    gate.rulingCovers(
      { task: 'T-1', category: null, ruling: 'approved', at },
      { id: 'T-1', category: 'awaiting-operator', age_hours: 999 }, now),
    true,
    'un ruling sin categoria cubre la pregunta que respondio');
  for (const category of ['idle', 'stale-review', 'stale-running', 'dead-owner-lease']) {
    assert.strictEqual(
      gate.rulingCovers({ task: 'T-1', category, ruling: 'approved', at },
        { id: 'T-1', category, age_hours: 999 }, now),
      false,
      `approved NO puede cubrir ${category}: aprobar no es hacer, y a las 72h sin dueno tiene que volver a sonar`);
    assert.strictEqual(
      gate.rulingCovers({ task: 'T-1', category: null, ruling: 'approved', at },
        { id: 'T-1', category, age_hours: 999 }, now),
      false,
      `approved sin categoria tampoco cubre ${category}`);
  }
});

test('los deadlines nuevos de W1 existen y son mas apretados que el resto', () => {
  // Una decision que el dueno nunca escucho es un loop roto AHORA: 6h, igual de
  // apretado que dead-owner-lease. Un result que no movio su tarjeta es una
  // tarjeta que miente: 24h.
  assert.strictEqual(gate.DEADLINES['decision-unheard'], 6);
  assert.strictEqual(gate.DEADLINES['result-unlinked'], 24);
  assert.strictEqual(
    gate.evaluate({
      findings: [finding({ id: 'T-0301', category: 'decision-unheard', age_hours: 7 })],
      rulings: [], now: NOW,
    }).verdict, 'RED',
    'una decision sin entregar a las 7h no puede dejar el gate verde');
  assert.strictEqual(
    gate.evaluate({
      findings: [finding({ id: 'result:corr-9', category: 'result-unlinked', age_hours: 25 })],
      rulings: [], now: NOW,
    }).verdict, 'RED',
    'un result huerfano a las 25h tampoco');
});
