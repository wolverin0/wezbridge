'use strict';
/**
 * weekly-retro.test.cjs — T-0551: retro semanal de RL de la flota. Puros sin
 * FS/clock salvo el end-to-end final (WEZBRIDGE_INTEL_DIR en temp dir, mismo
 * patrón que daily-rollup.test.cjs).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WR = require('../scripts/weekly-retro.cjs');
const {
  isoWeek, windowFor, inWindow,
  summarizeForemanFalsePositives, summarizeRedispatchesOfDoneWork, summarizeOperatorWaitHours,
  summarizeAbandons, summarizeCostByTier, generateRecommendations, renderRetro, generateRetro,
} = WR;

// ── ventana / ISO week ──────────────────────────────────────────────────

test('isoWeek: martes 22/09/2026 cae en la semana ISO 2026-W39', () => {
  assert.strictEqual(isoWeek(new Date(Date.UTC(2026, 8, 22, 12, 0, 0))), '2026-W39');
});

test('isoWeek: lunes de una nueva semana ISO cambia el número', () => {
  const mon = isoWeek(new Date(Date.UTC(2026, 8, 21, 8, 15, 0)));
  const sun = isoWeek(new Date(Date.UTC(2026, 8, 20, 8, 15, 0)));
  assert.notStrictEqual(mon, sun);
});

test('windowFor/inWindow: ventana de 7 días termina en `now`, exclusive', () => {
  const now = new Date('2026-09-23T08:15:00.000Z');
  const w = windowFor(now, 7);
  assert.strictEqual(w.toIso, now.toISOString());
  assert.ok(inWindow('2026-09-20T00:00:00.000Z', w));
  assert.ok(!inWindow('2026-09-15T00:00:00.000Z', w)); // fuera, antes del from
  assert.ok(!inWindow('2026-09-23T08:15:00.000Z', w)); // exclusive del borde
  assert.ok(!inWindow('garbage', w));
});

// ── foreman false positives ─────────────────────────────────────────────

test('summarizeForemanFalsePositives: junta hallazgos de foreman/*.json y de evaluator_evidence', () => {
  const window = windowFor(new Date('2026-09-23T08:15:00.000Z'), 7);
  const foremanFiles = [
    { name: 'T-0100.json', data: { task_id: 'T-0100', verdict: 'false_positive' } },
    { name: 'T-0101.json', data: { task_id: 'T-0101', verdict: 'ok' } },
  ];
  const tasks = [
    { id: 'T-0200', state: 'done', state_changed_at: '2026-09-21T00:00:00Z', evaluator_evidence: 'era un falso positivo del steward' },
    { id: 'T-0201', state: 'done', state_changed_at: '2026-09-10T00:00:00Z', evaluator_evidence: 'falso positivo pero fuera de ventana' },
  ];
  const s = summarizeForemanFalsePositives({ foremanFiles, tasks, window });
  assert.strictEqual(s.count, 2);
  assert.ok(s.items.some((i) => i.id === 'T-0100'));
  assert.ok(s.items.some((i) => i.id === 'T-0200'));
  assert.ok(!s.items.some((i) => i.id === 'T-0201'));
});

test('summarizeForemanFalsePositives: directorio foreman ausente no rompe (items=[])', () => {
  const window = windowFor(new Date('2026-09-23T08:15:00.000Z'), 7);
  const s = summarizeForemanFalsePositives({ foremanFiles: [], tasks: [], window });
  assert.deepStrictEqual(s, { count: 0, items: [] });
});

// ── redispatches of done work ───────────────────────────────────────────

test('summarizeRedispatchesOfDoneWork: solo cuenta tarjetas done dentro de la ventana con >1 despacho', () => {
  const window = windowFor(new Date('2026-09-23T08:15:00.000Z'), 7);
  const tasks = [
    { id: 'T-0300', state: 'done', state_changed_at: '2026-09-22T00:00:00Z' },
    { id: 'T-0301', state: 'running', state_changed_at: '2026-09-22T00:00:00Z' }, // no done
    { id: 'T-0302', state: 'done', state_changed_at: '2026-09-01T00:00:00Z' }, // fuera de ventana
  ];
  const actionsAll = [
    { action: 'spawn_pane', corr: 'T-0300' }, { action: 'spawn_pane', corr: 'T-0300' },
    { action: 'spawn_pane', corr: 'T-0301' }, { action: 'spawn_pane', corr: 'T-0301' },
    { action: 'spawn_pane', corr: 'T-0302' }, { action: 'spawn_pane', corr: 'T-0302' },
  ];
  const s = summarizeRedispatchesOfDoneWork({ tasks, actionsAll, queueRecordsAll: [], window });
  assert.strictEqual(s.total, 1);
  assert.deepStrictEqual(s.items, [{ id: 'T-0300', redispatches: 1 }]);
});

// ── operator wait hours ─────────────────────────────────────────────────

test('summarizeOperatorWaitHours: suma horas y arma top5, incluye tarjetas AUN bloqueadas', () => {
  const now = new Date('2026-09-23T08:15:00.000Z');
  const window = windowFor(now, 7);
  const tasks = [
    { id: 'T-0400', state: 'done', state_changed_at: '2026-09-22T00:00:00Z', blocked_by: null },
    { id: 'T-0401', state: 'blocked', blocked_by: 'operator' }, // sigue esperando, sin cerrar
  ];
  const events = [
    { time: '2026-09-21T00:00:00.000Z', task_id: 'T-0400', event: 'task.updated', blocked_by: 'operator' },
    { time: '2026-09-22T00:00:00.000Z', task_id: 'T-0400', event: 'task.updated', state: 'done' },
    { time: '2026-09-20T08:15:00.000Z', task_id: 'T-0401', event: 'task.updated', blocked_by: 'operator' },
  ];
  const s = summarizeOperatorWaitHours({ tasks, events, window, now });
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.top5[0].id, 'T-0401'); // 3 dias abierta > 24h cerrada
  assert.ok(s.sum > 0);
});

// ── abandons ─────────────────────────────────────────────────────────────

test('summarizeAbandons: extrae el texto tras "ABANDON:" de tarjetas done en ventana', () => {
  const window = windowFor(new Date('2026-09-23T08:15:00.000Z'), 7);
  const tasks = [
    { id: 'T-0500', state: 'done', state_changed_at: '2026-09-22T00:00:00Z', evaluator_evidence: 'AC1 pass. ABANDON: AC4 foto de la PWA, el operador no la va a sacar.' },
    { id: 'T-0501', state: 'done', state_changed_at: '2026-09-01T00:00:00Z', evaluator_evidence: 'ABANDON: fuera de ventana' },
  ];
  const s = summarizeAbandons({ tasks, window });
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.items[0].id, 'T-0500');
  assert.match(s.items[0].criteria[0], /AC4 foto de la PWA/);
});

// ── cost by tier ─────────────────────────────────────────────────────────

test('summarizeCostByTier: agrupa tarjetas por model/effort y adjunta precio si el modelo está en model-tiers.json', () => {
  const window = windowFor(new Date('2026-09-23T08:15:00.000Z'), 7);
  const tasks = [
    { id: 'T-0600', state_changed_at: '2026-09-22T00:00:00Z', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'T-0601', state_changed_at: '2026-09-22T00:00:00Z', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'T-0602', state_changed_at: '2026-09-22T00:00:00Z' }, // sin model/effort
  ];
  const modelTiers = { models: { 'claude-sonnet-5': { price_in: 2, price_out: 10 } } };
  const groups = summarizeCostByTier({ tasks, window, modelTiers });
  assert.strictEqual(groups.length, 2);
  const sonnet = groups.find((g) => g.model === 'claude-sonnet-5');
  assert.strictEqual(sonnet.count, 2);
  assert.strictEqual(sonnet.price_in, 2);
  const unknown = groups.find((g) => g.model === 'desconocido');
  assert.strictEqual(unknown.count, 1);
  assert.strictEqual(unknown.price_in, null);
});

// ── recommendations: SIEMPRE 3 ──────────────────────────────────────────

test('generateRecommendations: siempre devuelve exactamente 3 strings, con hallazgos', () => {
  const recs = generateRecommendations({
    waits: { top5: [{ id: 'T-1', hours: 60 }], count: 1, sum: 60 },
    redispatches: { total: 2, items: [{ id: 'T-2', redispatches: 2 }] },
    foreman: { count: 1, items: [] },
    abandons: { count: 1, items: [{ id: 'T-3', criteria: ['AC4'] }] },
  });
  assert.strictEqual(recs.length, 3);
  assert.match(recs[0], />48h/);
  assert.match(recs[0], /T-1/);
  assert.match(recs[1], /2 redespacho/);
  assert.match(recs[2], /1 falso/);
});

test('generateRecommendations: siempre devuelve exactamente 3 strings, sin hallazgos', () => {
  const recs = generateRecommendations({
    waits: { top5: [], count: 0, sum: 0 },
    redispatches: { total: 0, items: [] },
    foreman: { count: 0, items: [] },
    abandons: { count: 0, items: [] },
  });
  assert.strictEqual(recs.length, 3);
  assert.match(recs[0], /OK/);
  assert.match(recs[1], /^0 redespachos/);
  assert.match(recs[2], /^0 falsos positivos/);
});

// ── render ────────────────────────────────────────────────────────────────

test('renderRetro: imprime las 3 recomendaciones numeradas y las secciones citan fuente', () => {
  const md = renderRetro({
    week: '2026-W39', generatedAt: 'x', windowLabel: 'a → b',
    foreman: { count: 0, items: [] },
    redispatches: { total: 0, items: [] },
    waits: { sum: 0, count: 0, top5: [] },
    abandons: { count: 0, items: [] },
    costByTier: [],
    recommendations: ['uno', 'dos', 'tres'],
  });
  assert.match(md, /## Recomendaciones/);
  assert.match(md, /1\. uno/);
  assert.match(md, /2\. dos/);
  assert.match(md, /3\. tres/);
  assert.match(md, /fuente _intel\/foreman/);
});

// ── end-to-end ────────────────────────────────────────────────────────────

test('generateRetro: end-to-end sobre WEZBRIDGE_INTEL_DIR temp produce el .md con 3 recomendaciones', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-retro-'));
  const prevIntel = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  try {
    fs.mkdirSync(path.join(tmp, 'tasks'));
    fs.writeFileSync(path.join(tmp, 'tasks', 'T-0700.json'), JSON.stringify({
      id: 'T-0700', repo: 'wezbridge', state: 'done', state_changed_at: '2026-09-22T00:00:00.000Z',
      evaluator_evidence: 'ABANDON: AC9 no medible',
    }));
    fs.writeFileSync(path.join(tmp, 'events.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'actions.jsonl'), '');
    fs.writeFileSync(path.join(tmp, 'rulings.jsonl'), '');

    const { file, data, md } = generateRetro({ now: new Date('2026-09-23T08:15:00.000Z'), dryRun: true });
    assert.ok(fs.existsSync(file));
    assert.strictEqual(data.week, '2026-W39');
    assert.strictEqual(data.recommendations.length, 3);
    assert.match(md, /ABANDON/);
    assert.match(path.basename(file), /^retro-2026-W39\.md$/);
  } finally {
    if (prevIntel === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prevIntel;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
