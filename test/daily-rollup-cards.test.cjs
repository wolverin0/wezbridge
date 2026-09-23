'use strict';
/**
 * daily-rollup-cards.test.cjs — T-0551: fila por tarjeta ("Tarjetas del día"),
 * hilos A2A del día y el render de ambas secciones. Puros sin FS/clock salvo
 * el end-to-end final, que usa WEZBRIDGE_INTEL_DIR en un temp dir (mismo
 * patrón que daily-rollup.test.cjs) y nunca schtasks real.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../scripts/daily-rollup.cjs');
const {
  eventsForTask, buildCardRow, buildCardRows, dispatcherFor, redispatchCount,
  summarizeThreads, renderRollup, generateRollup, isOnDate,
} = R;

// ── eventsForTask ────────────────────────────────────────────────────────

test('eventsForTask: filtra por task_id y ordena cronológicamente', () => {
  const events = [
    { time: '2026-09-23T10:00:00Z', task_id: 'T-0002', event: 'task.updated' },
    { time: '2026-09-23T08:00:00Z', task_id: 'T-0001', event: 'task.leased' },
    { time: '2026-09-23T09:00:00Z', task_id: 'T-0001', event: 'task.updated', state: 'running' },
  ];
  const evs = eventsForTask(events, 'T-0001');
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].event, 'task.leased');
  assert.strictEqual(evs[1].event, 'task.updated');
});

// ── buildCardRow: duración, owner, outcome, redespachos, espera ─────────

test('buildCardRow: duración = running -> estado terminal, owner del último lease, outcome done', () => {
  const task = {
    id: 'T-0100', repo: 'wezbridge', state: 'done', lease: null,
    corr: 'orch-20260923', evaluator_evidence: 'todo paso',
  };
  const events = [
    { time: '2026-09-23T08:00:00.000Z', task_id: 'T-0100', event: 'task.leased', owner: 'pane-7' },
    { time: '2026-09-23T08:00:00.100Z', task_id: 'T-0100', event: 'task.updated', state: 'running' },
    { time: '2026-09-23T10:00:00.100Z', task_id: 'T-0100', event: 'task.updated', state: 'review' },
    { time: '2026-09-23T10:30:00.100Z', task_id: 'T-0100', event: 'task.updated', state: 'done' },
  ];
  const row = buildCardRow(task, events, [], [], []);
  assert.strictEqual(row.owner, 'pane-7');
  assert.strictEqual(row.durationHours, 2.5);
  assert.strictEqual(row.outcome, 'done');
  assert.strictEqual(row.redispatches, 0);
  assert.strictEqual(row.decisionWaitHours, null);
  assert.strictEqual(row.source, 'tasks/T-0100.json + events.jsonl');
});

test('buildCardRow: evidencia con ABANDON se marca en el outcome', () => {
  const task = { id: 'T-0101', repo: 'infra', state: 'done', evaluator_evidence: 'OPERADOR: cerrar con ABANDON de AC4' };
  const row = buildCardRow(task, [], [], [], []);
  assert.match(row.outcome, /ABANDON/);
});

test('buildCardRow: cuenta redespachos por corr repetido en actions.jsonl (spawn_pane/queue_deliver)', () => {
  const task = { id: 'T-0102', repo: 'wezbridge', state: 'running', corr: 'c1' };
  const actionsAll = [
    { action: 'spawn_pane', corr: 'T-0102', actor: 'mcp-server' },
    { action: 'spawn_pane', corr: 'T-0102', actor: 'mcp-server' },
    { action: 'queue_deliver', corr: 'T-0102', actor: 'mcp-server' },
    { action: 'spawn_pane', corr: 'T-9999', actor: 'other' }, // otra tarjeta: no cuenta
  ];
  const row = buildCardRow(task, [], actionsAll, [], []);
  assert.strictEqual(row.redispatches, 2); // 3 despachos - 1
});

test('redispatchCount: suma despachos de actions.jsonl + envíos de cola con el mismo corr', () => {
  const actionsAll = [{ action: 'spawn_pane', corr: 'T-0200' }];
  const queueRecordsAll = [{ corr: 'T-0200' }, { corr: 'T-0200' }];
  assert.strictEqual(redispatchCount('T-0200', actionsAll, queueRecordsAll), 2); // 3 - 1
  assert.strictEqual(redispatchCount('T-0201', actionsAll, queueRecordsAll), 0);
});

test('dispatcherFor: prioriza actions.jsonl (spawn_pane/queue_deliver por corr); cae a rulings si no hay despacho', () => {
  const actionsAll = [{ action: 'spawn_pane', corr: 'T-0300', actor: 'mcp-server' }];
  assert.strictEqual(dispatcherFor('T-0300', actionsAll, []), 'mcp-server');

  const rulingsAll = [{ task: 'T-0301', by: 'operator', source: 'orchestrator-pane' }];
  assert.strictEqual(dispatcherFor('T-0301', [], rulingsAll), 'operator');

  assert.strictEqual(dispatcherFor('T-0302', [], []), '—');
});

test('buildCardRow: espera de decisión = tiempo con blocked_by=operator hasta el cierre', () => {
  const task = { id: 'T-0400', repo: 'wezbridge', state: 'done', evaluator_evidence: 'listo' };
  const events = [
    { time: '2026-09-20T00:00:00.000Z', task_id: 'T-0400', event: 'task.updated', blocked_by: 'operator', state: 'blocked' },
    { time: '2026-09-23T00:00:00.000Z', task_id: 'T-0400', event: 'task.updated', state: 'done' },
  ];
  const row = buildCardRow(task, events, [], [], []);
  assert.strictEqual(row.decisionWaitHours, 72);
});

// ── buildCardRows: filtro por día ────────────────────────────────────────

test('buildCardRows: solo tarjetas cuyo state_changed_at cae en el día pedido, ordenadas por id', () => {
  const tasks = [
    { id: 'T-0002', repo: 'infra', state: 'done', state_changed_at: '2026-09-23T12:00:00.000Z' },
    { id: 'T-0001', repo: 'wezbridge', state: 'done', state_changed_at: '2026-09-23T09:00:00.000Z' },
    { id: 'T-0003', repo: 'wezbridge', state: 'done', state_changed_at: '2026-09-22T09:00:00.000Z' }, // otro día
  ];
  const rows = buildCardRows(tasks, [], '2026-09-23', { actionsAll: [], rulingsAll: [], queueRecordsAll: [] });
  assert.deepStrictEqual(rows.map((r) => r.id), ['T-0001', 'T-0002']);
});

test('buildCardRows: vacío si ninguna tarjeta cambió ese día', () => {
  const rows = buildCardRows([{ id: 'T-1', state_changed_at: '2026-01-01T00:00:00Z' }], [], '2026-09-23');
  assert.deepStrictEqual(rows, []);
});

// ── summarizeThreads ──────────────────────────────────────────────────────

test('summarizeThreads: agrupa por (corr, from_pane, to_pane) y se queda con el último resultado', () => {
  const results = [
    { time: '2026-09-23T10:00:00Z', corr: 'X', from_pane: 1, to_pane: 2, v2: 'partial' },
    { time: '2026-09-23T12:00:00Z', corr: 'X', from_pane: 1, to_pane: 2, v2: 'ok' },
    { time: '2026-09-23T11:00:00Z', corr: 'Y', from_pane: 3, to_pane: 4, v2: 'missing' },
  ];
  const threads = summarizeThreads(results);
  assert.strictEqual(threads.length, 2);
  const x = threads.find((t) => t.corr === 'X');
  assert.strictEqual(x.result, 'ok');
});

// ── render ────────────────────────────────────────────────────────────────

test('renderRollup: sección "Tarjetas del día" imprime la tabla con fuente por fila', () => {
  const md = renderRollup({
    date: '2026-09-23', generatedAt: 'x',
    turns: R.summarizeTurns([]), actions: R.summarizeActions([]), results: R.summarizeResults([]),
    rulings: R.summarizeRulings([]), gates: { steward: null, boardFresh: null },
    census: { skipped: true, items: [], silent: [] },
    ledger: { byState: {}, dashboardLine: null },
    queues: R.summarizeQueues([]),
    cards: [{
      id: 'T-0551', repo: 'wezbridge', owner: 'wezbridge', dispatchedBy: 'operator',
      model: '—', effort: '—', durationHours: 1.5, outcome: 'done', redispatches: 0,
      decisionWaitHours: null, source: 'tasks/T-0551.json + events.jsonl',
    }],
    threads: [{ corr: 'orch-20260923', from_pane: 1, to_pane: 2, result: 'ok' }],
  });
  assert.match(md, /## Tarjetas del día/);
  assert.ok(md.includes('| T-0551 | wezbridge | wezbridge | —/— | operator | 1.5h | done | 0 | — | tasks/T-0551.json + events.jsonl |'), md);
  assert.match(md, /## Hilos A2A del día/);
  assert.ok(md.includes('| orch-20260923 | pane-1 → pane-2 | ok |'), md);
});

test('renderRollup: sin tarjetas ni hilos declara "ninguna"/"sin hilos" en vez de tabla vacía', () => {
  const md = renderRollup({
    date: '2026-09-23', generatedAt: 'x',
    turns: R.summarizeTurns([]), actions: R.summarizeActions([]), results: R.summarizeResults([]),
    rulings: R.summarizeRulings([]), gates: { steward: null, boardFresh: null },
    census: { skipped: true, items: [], silent: [] },
    ledger: { byState: {}, dashboardLine: null },
    queues: R.summarizeQueues([]),
    cards: [],
    threads: [],
  });
  assert.match(md, /ninguna tarjeta cambió de estado hoy/);
  assert.match(md, /sin hilos A2A hoy/);
});

// ── end-to-end: generateRollup arma "Tarjetas del día" desde fixtures reales ──

test('generateRollup: end-to-end arma la fila de una tarjeta cerrada hoy con lease+running+done en events.jsonl', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rollup-cards-'));
  const prevIntel = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  try {
    fs.mkdirSync(path.join(tmp, 'tasks'));
    fs.writeFileSync(path.join(tmp, 'tasks', 'T-0900.json'), JSON.stringify({
      id: 'T-0900', repo: 'wezbridge', state: 'done', lease: null, corr: 'orch-20260923',
      state_changed_at: '2026-09-23T10:30:00.000Z', evaluator_evidence: 'hecho',
    }));
    fs.writeFileSync(path.join(tmp, 'events.jsonl'), [
      JSON.stringify({ time: '2026-09-23T08:00:00.000Z', event: 'task.leased', task_id: 'T-0900', owner: 'wezbridge' }),
      JSON.stringify({ time: '2026-09-23T08:00:01.000Z', event: 'task.updated', task_id: 'T-0900', state: 'running' }),
      JSON.stringify({ time: '2026-09-23T10:30:00.000Z', event: 'task.updated', task_id: 'T-0900', state: 'done' }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(tmp, 'actions.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'a2a-results.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'rulings.jsonl'), '');

    const { data, md } = generateRollup({
      now: new Date('2026-09-23T20:00:00Z'), date: '2026-09-23', dryRun: true, censusRows: [],
    });
    assert.strictEqual(data.cards.length, 1);
    assert.strictEqual(data.cards[0].id, 'T-0900');
    assert.strictEqual(data.cards[0].owner, 'wezbridge');
    assert.strictEqual(data.cards[0].durationHours, 2.5);
    assert.match(md, /T-0900/);
  } finally {
    if (prevIntel === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prevIntel;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isOnDate still exported and usable by this suite\'s fixtures (sanity import check)', () => {
  assert.strictEqual(isOnDate('2026-09-23T10:00:00Z', '2026-09-23'), true);
});
