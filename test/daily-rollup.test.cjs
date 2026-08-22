'use strict';
/**
 * daily-rollup.test.cjs — C1: bandeja diaria del operador.
 * Puros sin FS/clock (reportDateFor, summarize*, census classifier, render);
 * IO con WEZBRIDGE_INTEL_DIR en temp dir + census inyectado (nunca schtasks real).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  reportDateFor, localDateOf, isOnDate,
  summarizeTurns, summarizeResults, summarizeQueues, sortDecisions,
  parseSchtasksCsv, classifyCensusRow, summarizeCensus,
  renderRollup, generateRollup,
} = require('../scripts/daily-rollup.cjs');

// ── ventana de fecha ────────────────────────────────────────────────────────

test('reportDateFor: la corrida de 02:30 cierra el día ANTERIOR', () => {
  const d = new Date(2026, 7, 23, 2, 30, 0); // 23-ago 02:30 local
  assert.strictEqual(reportDateFor(d), '2026-08-22');
});

test('reportDateFor: una corrida manual de mediodía reporta el día corriente', () => {
  const d = new Date(2026, 7, 22, 13, 0, 0);
  assert.strictEqual(reportDateFor(d), '2026-08-22');
});

test('isOnDate: bucketing por día local, timestamps inválidos quedan afuera', () => {
  const noonLocal = new Date(2026, 7, 22, 12, 0, 0).toISOString();
  assert.strictEqual(isOnDate(noonLocal, '2026-08-22'), true);
  assert.strictEqual(isOnDate(noonLocal, '2026-08-21'), false);
  assert.strictEqual(isOnDate('garbage', '2026-08-22'), false);
  assert.strictEqual(isOnDate(undefined, '2026-08-22'), false);
});

// ── turnos ──────────────────────────────────────────────────────────────────

test('summarizeTurns: % sin acción cuenta solo turnos WOKE improductivos (incremento de stalls)', () => {
  // t1 woke productivo (t2.stalls=0), t2 woke improductivo (t3.stalls=1), t3 skip.
  const turns = [
    { at: '2026-08-22T10:00:00Z', woke: true, action: 'poked-pane', stalls: 0, classes: ['real-stall'] },
    { at: '2026-08-22T12:00:00Z', woke: true, action: 'headless', stalls: 0, classes: ['results-directed'] },
    { at: '2026-08-22T14:00:00Z', woke: false, action: 'none', stalls: 1, classes: [], noise: ['permission-wait from wabot'] },
  ];
  const s = summarizeTurns(turns);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.woke, 2);
  assert.strictEqual(s.skips, 1);
  assert.strictEqual(s.unproductiveWoke, 1);
  assert.strictEqual(s.pctWokeSinAccion, 50);
  assert.strictEqual(s.byClass['real-stall'], 1);
  assert.deepStrictEqual(s.noise, ['permission-wait from wabot']);
});

test('summarizeTurns: vacío no divide por cero', () => {
  const s = summarizeTurns([]);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.pctWokeSinAccion, 0);
});

// ── decisions ledger ────────────────────────────────────────────────────────

test('sortDecisions: menor confianza primero, sin tag antes que todo', () => {
  const sorted = sortDecisions([
    { decision: 'a', confidence: 'alta' },
    { decision: 'b', confidence: 'baja' },
    { decision: 'c', confidence: null },
    { decision: 'd', confidence: 'media' },
  ]);
  assert.deepStrictEqual(sorted.map((d) => d.decision), ['c', 'b', 'd', 'a']);
});

test('summarizeResults: junta decisions de varios results y cuenta v2/evidence; legacy sin campos no rompe', () => {
  const s = summarizeResults([
    { corr: 'X', from_pane: 3, v2: 'ok', abandons: 1, evidence: { count: 2, items: ['a', 'b'] }, decisions: { count: 1, items: [{ decision: 'usar tmp', confidence: 'baja', would_have_asked: 'dónde' }] } },
    { corr: 'Y', from_pane: 4, v2: 'missing', abandons: 0 }, // record pre-A1: sin decisions/evidence
  ]);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.v2.ok, 1);
  assert.strictEqual(s.v2.missing, 1);
  assert.strictEqual(s.abandons, 1);
  assert.strictEqual(s.withEvidence, 1);
  assert.strictEqual(s.decisions.length, 1);
  assert.strictEqual(s.decisions[0].corr, 'X');
});

// ── census ──────────────────────────────────────────────────────────────────

const CSV_HEADER = '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run","Start In","Comment","Scheduled Task State","Idle Time","Power Management","Run As User","Delete Task If Not Rescheduled","Stop Task If Runs X Hours and X Mins","Schedule","Schedule Type","Start Time","Start Date","End Date","Days","Months","Repeat: Every","Repeat: Until: Time","Repeat: Until: Duration","Repeat: Stop If Still Running"';
function csvRow({ name, next = '23-Aug-26 9:00:00 AM', lastRun = '22-Aug-26 9:00:01 AM', lastResult = '0', state = 'Enabled' }) {
  return `"HOST","\\${name}","${next}","Ready","Interactive only","${lastRun}","${lastResult}","N/A","wscript.exe //B //NoLogo "C:\\Users\\x\\run-hidden.vbs" C:\\Users\\x\\ht\\${name}.cmdline","N/A","N/A","${state}","Disabled","x","u","Disabled","72:00:00","x","Daily ","9:00:00 AM","13-Aug-26","N/A","Every 1 day(s)","N/A","Disabled","Disabled","Disabled","Disabled"`;
}

test('parseSchtasksCsv: sobrevive comillas embebidas en Task To Run y headers repetidos', () => {
  const rows = parseSchtasksCsv([CSV_HEADER, csvRow({ name: 'wezbridge-fleet-board' }), CSV_HEADER, csvRow({ name: 'wezbridge-steward-gate', lastResult: '1' })].join('\n'));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].TaskName, '\\wezbridge-fleet-board');
  assert.match(rows[0]['Task To Run'], /run-hidden\.vbs/);
  assert.strictEqual(rows[1]['Last Result'], '1');
});

test('classifyCensusRow: exit-1 sin contrato = silent-failure; con contrato = contract-signal', () => {
  const silent = classifyCensusRow({ TaskName: '\\routine-test-strength-wezbridge', 'Last Result': '1', 'Last Run Time': '16-Aug-26', 'Scheduled Task State': 'Enabled' });
  assert.strictEqual(silent.class, 'silent-failure');
  const contract = classifyCensusRow({ TaskName: '\\wezbridge-fleet-steward', 'Last Result': '1', 'Last Run Time': '22-Aug-26', 'Scheduled Task State': 'Enabled' });
  assert.strictEqual(contract.class, 'contract-signal');
  assert.match(contract.note, /operador/);
});

test('classifyCensusRow: disabled / never-ran / running / ok', () => {
  assert.strictEqual(classifyCensusRow({ TaskName: '\\t', 'Last Result': '0', 'Scheduled Task State': 'Disabled' }).class, 'disabled');
  assert.strictEqual(classifyCensusRow({ TaskName: '\\t', 'Last Result': '267011', 'Last Run Time': 'N/A', 'Scheduled Task State': 'Enabled' }).class, 'never-ran');
  assert.strictEqual(classifyCensusRow({ TaskName: '\\t', 'Last Result': '267009', 'Last Run Time': 'x', 'Scheduled Task State': 'Enabled' }).class, 'running');
  assert.strictEqual(classifyCensusRow({ TaskName: '\\t', 'Last Result': '0', 'Last Run Time': 'x', 'Scheduled Task State': 'Enabled' }).class, 'ok');
});

test('summarizeCensus: filtra por patrón, dedupea y junta las silent-failures', () => {
  const rows = parseSchtasksCsv([
    CSV_HEADER,
    csvRow({ name: 'wezbridge-fleet-board' }),
    csvRow({ name: 'routine-test-strength-wezbridge', lastResult: '1' }),
    csvRow({ name: 'OneDrive-Updater' }), // fuera del patrón
    csvRow({ name: 'wezbridge-fleet-board' }), // duplicado
  ].join('\n'));
  const c = summarizeCensus(rows);
  assert.strictEqual(c.items.length, 2);
  assert.strictEqual(c.silent.length, 1);
  assert.strictEqual(c.silent[0].name, 'routine-test-strength-wezbridge');
});

// ── colas ───────────────────────────────────────────────────────────────────

test('summarizeQueues: separa entregados de sin-entregar y arrastra flagged', () => {
  const s = summarizeQueues([
    { project: 'wezbridge', flagged: 1, records: [{ ok: true }, { ok: false }] },
    { project: 'mutual', flagged: 0, records: [{ ok: true }] },
  ]);
  assert.strictEqual(s.perProject.wezbridge.undelivered, 1);
  assert.strictEqual(s.perProject.mutual.delivered, 1);
  assert.strictEqual(s.undelivered, 1);
  assert.strictEqual(s.flagged, 1);
});

// ── render + IO end-to-end sobre temp dir ───────────────────────────────────

function seedIntel(dir, date) {
  // Timestamps a mediodía LOCAL: el día local coincide sin ambigüedad de TZ.
  const [y, m, d] = date.split('-').map(Number);
  const noon = new Date(y, m - 1, d, 12, 0, 0).toISOString();
  const noon2 = new Date(y, m - 1, d, 13, 0, 0).toISOString();
  const otherDay = new Date(y, m - 1, d - 1, 12, 0, 0).toISOString();

  fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'turns', 'turn-a.json'), JSON.stringify({ at: noon, woke: true, action: 'poked-pane', stalls: 0, classes: ['real-stall'], reasons: ['gate RED'] }));
  fs.writeFileSync(path.join(dir, 'turns', 'turn-b.json'), JSON.stringify({ at: noon2, woke: false, action: 'none', stalls: 1, classes: [], noise: ['permission-wait from wabot'] }));
  fs.writeFileSync(path.join(dir, 'turns', 'turn-old.json'), JSON.stringify({ at: otherDay, woke: true, action: 'headless', stalls: 0, classes: [] }));

  fs.writeFileSync(path.join(dir, 'actions.jsonl'), [
    JSON.stringify({ ts: noon, actor: 'pane-0', action: 'spawn_pane', target: 'pane-9' }),
    JSON.stringify({ ts: noon, actor: 'pane-0', action: 'auto_ack', target: 'corr=T-1' }),
    JSON.stringify({ ts: noon, actor: 'x', action: 'spawn_refused', target: 'y' }),
    JSON.stringify({ ts: otherDay, actor: 'x', action: 'kill_pane', target: 'z' }),
  ].join('\n') + '\n');

  fs.writeFileSync(path.join(dir, 'a2a-results.jsonl'), [
    JSON.stringify({ time: noon, event: 'a2a.result', corr: 'T-1', from_pane: 5, to_pane: 0, v2: 'ok', abandons: 0, evidence: { count: 1, items: ['suite 10/10'] }, decisions: { count: 2, items: [{ decision: 'elegí puerto 4300', confidence: 'baja', would_have_asked: 'qué puerto' }, { decision: 'nombre en inglés', confidence: 'alta', would_have_asked: null }] } }),
    JSON.stringify({ time: noon, event: 'a2a.result', corr: 'T-2', from_pane: 6, to_pane: 0, v2: 'missing', abandons: 1, body: 'legacy' }),
  ].join('\n') + '\n');

  fs.writeFileSync(path.join(dir, 'rulings.jsonl'),
    JSON.stringify({ task: 'T-0189', category: 'idle', ruling: 'deferred', until: '2026-08-24', why: 'espera al workflow', at: noon }) + '\n');

  fs.writeFileSync(path.join(dir, 'steward-gate-latest.txt'), 'steward-gate GREEN: 17 findings, all ruled.\n');
  fs.writeFileSync(path.join(dir, 'board-fresh-gate-latest.txt'), 'board-fresh-gate: GREEN\n');

  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 'T-1.json'), JSON.stringify({ id: 'T-1', state: 'review' }));
  fs.writeFileSync(path.join(dir, 'tasks', 'T-2.json'), JSON.stringify({ id: 'T-2', state: 'queued' }));
  fs.writeFileSync(path.join(dir, 'dashboard.md'), '# Intel dashboard\nRegenerated X by ledger.cjs. Tasks: 2 total, 2 open.\n');

  fs.mkdirSync(path.join(dir, 'queues', 'state', 'wezbridge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queues', 'wezbridge.jsonl'), [
    JSON.stringify({ id: 'q1', time: noon, project: 'wezbridge', corr: 'T-1', type: 'result', from_pane: 5, ok: true }),
    JSON.stringify({ id: 'q2', time: noon, project: 'wezbridge', corr: 'T-3', type: 'request', from_pane: 0, ok: false }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'queues', 'state', 'wezbridge', 'flags.json'), JSON.stringify({ qf: { reason: 'attempt cap' } }));
}

test('generateRollup: end-to-end sobre WEZBRIDGE_INTEL_DIR temp con census inyectado', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-'));
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  try {
    const date = '2026-08-22';
    seedIntel(tmp, date);
    const censusRows = parseSchtasksCsv([CSV_HEADER, csvRow({ name: 'wezbridge-daily-rollup' }), csvRow({ name: 'routine-test-strength-wezbridge', lastResult: '1' })].join('\n'));
    const { file, md, data } = generateRollup({ now: new Date(2026, 7, 22, 13, 30, 0), date, dryRun: true, censusRows });

    assert.strictEqual(path.basename(file), '2026-08-22.md');
    assert.ok(fs.existsSync(file), 'el rollup md debe existir en <intel>/rollups/');
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.strictEqual(onDisk, md);

    // doc-head greppeable en las primeras 7 líneas
    const head = md.split('\n').slice(0, 7).join('\n');
    assert.match(head, /Rollup diario del operador — 2026-08-22/);
    assert.match(head, /determinista/);

    // secciones con los números de las fixtures (el día viejo queda AFUERA)
    assert.strictEqual(data.turns.total, 2);
    assert.strictEqual(data.actions.total, 3);
    assert.strictEqual(data.results.total, 2);
    assert.match(md, /steward-gate GREEN/);
    assert.match(md, /elegí puerto 4300/);
    assert.match(md, /\[baja\].*elegí puerto 4300/); // menor confianza primero
    assert.ok(md.indexOf('elegí puerto 4300') < md.indexOf('nombre en inglés'));
    assert.match(md, /T-0189 → deferred/);
    assert.match(md, /routine-test-strength-wezbridge: silent-failure/);
    assert.match(md, /FALLA SILENCIOSA/);
    assert.match(md, /wezbridge: 2 envíos \(ok=1, sin entregar=1\) · flagged=1/);
    assert.match(md, /estados: .*review=1/);
    assert.match(md, /misroutes=0\?: NO — 1 envíos sin entregar \+ 1 flagged/);
    assert.match(md, /auto_ack: 1/);
    assert.match(md, /spawn_refused \(tope\): 1/);

    // dry-run NO escribe actions.jsonl del rollup (solo las fixtures siguen)
    const actions = fs.readFileSync(path.join(tmp, 'actions.jsonl'), 'utf8');
    assert.ok(!actions.includes('daily_rollup'));
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('generateRollup: corrida real (no dry) loguea daily_rollup en actions.jsonl del intel dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-'));
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  try {
    const { file } = generateRollup({ now: new Date(2026, 7, 22, 13, 30, 0), date: '2026-08-22', dryRun: false, censusRows: [] });
    assert.ok(fs.existsSync(file));
    const actions = fs.readFileSync(path.join(tmp, 'actions.jsonl'), 'utf8');
    assert.match(actions, /"action":"daily_rollup"/);
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('generateRollup: intel dir vacío produce un rollup válido sin crashear', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-'));
  const prev = process.env.WEZBRIDGE_INTEL_DIR;
  process.env.WEZBRIDGE_INTEL_DIR = tmp;
  try {
    const { md, data } = generateRollup({ now: new Date(2026, 7, 22, 13, 30, 0), date: '2026-08-22', dryRun: true, censusRows: [] });
    assert.strictEqual(data.turns.total, 0);
    assert.match(md, /SIN ARCHIVO/);
    assert.match(md, /sin colas con actividad hoy/);
  } finally {
    if (prev === undefined) delete process.env.WEZBRIDGE_INTEL_DIR; else process.env.WEZBRIDGE_INTEL_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderRollup: census skipped se declara en vez de fingir 0 fallas', () => {
  const md = renderRollup({
    date: '2026-08-22', generatedAt: 'x',
    turns: summarizeTurns([]), actions: { total: 0, byAction: {} },
    results: summarizeResults([]), rulings: { total: 0, byRuling: {}, items: [] },
    gates: { steward: 'g', boardFresh: 'b' },
    census: { skipped: true, items: [], silent: [] },
    ledger: { byState: {}, dashboardLine: null },
    queues: summarizeQueues([]),
  });
  assert.match(md, /CENSUS OMITIDO/);
  assert.ok(!md.includes('0 tasks en clase silent-failure'));
});
