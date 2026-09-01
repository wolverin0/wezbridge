#!/usr/bin/env node
'use strict';
/**
 * daily-rollup.cjs — bandeja diaria del operador, determinista, $0 (sin LLM).
 * Lee _intel/{turns,actions.jsonl,a2a-results.jsonl,rulings.jsonl,queues,tasks}
 * + gates latest + census schtasks (Last Result, clase silent-failure) y escribe
 * _intel/rollups/YYYY-MM-DD.md con autoeval del orquestador (% sin acción,
 * misroutes, auto_acks, shadow). C1 del plan harness/software-factory 2026-08-22.
 * Uso: node scripts/daily-rollup.cjs [--dry-run] [--date YYYY-MM-DD].
 * Puros exportados (reportDateFor, summarize*, render*) — test sin FS ni clock.
 *
 * Todo número del rollup cita su fuente. Un número sin fuente es prosa, y la
 * prosa es exactamente lo que esta bandeja reemplaza: el handoff manual donde
 * "el steward está verde" podía ser cierto hace tres días.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(REPO, '..', '_intel');
}

// ---------------------------------------------------------------------------
// PURE — date window
// ---------------------------------------------------------------------------

/**
 * Qué día reporta una corrida que arranca en `now` (Date, hora LOCAL).
 * La corrida programada es 02:30: a esa hora el día que interesa es AYER —
 * un rollup de "hoy" a las 02:30 tendría dos horas de datos y toda la
 * confianza de un día completo. Regla: antes de las 06:00 locales se cierra
 * el día anterior; desde las 06:00, el día corriente (corridas manuales).
 */
function reportDateFor(now) {
  const shifted = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  return localDateOf(shifted);
}

/** YYYY-MM-DD del instante en hora LOCAL (el día del operador, no UTC). */
function localDateOf(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ¿El timestamp ISO cae en el día local `date`? Inválido = false. */
function isOnDate(iso, date) {
  const t = new Date(iso || '');
  return !Number.isNaN(t.getTime()) && localDateOf(t) === date;
}

// ---------------------------------------------------------------------------
// PURE — summarizers (cada uno toma registros ya parseados, sin FS)
// ---------------------------------------------------------------------------

/**
 * Turnos del waker. `% sin acción` (meta <20%) cuenta turnos que DESPERTARON
 * un modelo y no produjeron artefactos: el campo `stalls` del turno i+1 sube
 * exactamente cuando el turno woke anterior fue improductivo (contrato de
 * orchestrator-turn.cjs). Los skip ($0, sin modelo) se reportan aparte:
 * un skip correcto es el clasificador funcionando, no un turno perdido.
 */
function summarizeTurns(turns) {
  const sorted = [...(turns || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const byAction = {};
  const byClass = {};
  const noise = [];
  let woke = 0;
  let unproductiveWoke = 0;
  let maxStalls = 0;
  sorted.forEach((t, i) => {
    byAction[t.action || '?'] = (byAction[t.action || '?'] || 0) + 1;
    for (const c of t.classes || []) byClass[c] = (byClass[c] || 0) + 1;
    for (const n of t.noise || []) noise.push(n);
    if (t.woke) woke += 1;
    maxStalls = Math.max(maxStalls, t.stalls || 0);
    if (i > 0 && (t.stalls || 0) === (sorted[i - 1].stalls || 0) + 1) unproductiveWoke += 1;
  });
  return {
    total: sorted.length,
    skips: byAction.none || 0,
    woke,
    unproductiveWoke,
    pctWokeSinAccion: woke ? Math.round((unproductiveWoke / woke) * 100) : 0,
    maxStalls,
    byAction,
    byClass,
    noise,
  };
}

function summarizeActions(actions) {
  const byAction = {};
  for (const a of actions || []) byAction[a.action || '?'] = (byAction[a.action || '?'] || 0) + 1;
  return { total: (actions || []).length, byAction };
}

/** Orden del ledger de decisiones: menor confianza primero. Sin tag = primero
 * de todos — una decisión sin autoevaluar es la que más ojos necesita. */
const CONF_RANK = { baja: 1, media: 2, alta: 3 };
function sortDecisions(items) {
  return [...(items || [])].sort(
    (a, b) => (CONF_RANK[a.confidence] || 0) - (CONF_RANK[b.confidence] || 0),
  );
}

function summarizeResults(results) {
  const v2 = { ok: 0, partial: 0, missing: 0 };
  let abandons = 0;
  let withEvidence = 0;
  const decisions = [];
  for (const r of results || []) {
    if (r.v2 in v2) v2[r.v2] += 1;
    abandons += r.abandons || 0;
    if (r.evidence && r.evidence.count > 0) withEvidence += 1;
    for (const d of (r.decisions && r.decisions.items) || []) {
      decisions.push({ ...d, corr: r.corr, from_pane: r.from_pane });
    }
  }
  return {
    total: (results || []).length,
    v2,
    abandons,
    withEvidence,
    decisions: sortDecisions(decisions),
  };
}

function summarizeRulings(rulings) {
  const byRuling = {};
  for (const r of rulings || []) byRuling[r.ruling || '?'] = (byRuling[r.ruling || '?'] || 0) + 1;
  return { total: (rulings || []).length, byRuling, items: rulings || [] };
}

function summarizeQueues(queues) {
  const perProject = {};
  for (const q of queues || []) {
    const p = perProject[q.project] || { total: 0, delivered: 0, undelivered: 0, flagged: q.flagged || 0 };
    for (const rec of q.records || []) {
      p.total += 1;
      if (rec.ok) p.delivered += 1; else p.undelivered += 1;
    }
    p.flagged = q.flagged || 0;
    perProject[q.project] = p;
  }
  const totals = Object.values(perProject).reduce(
    (acc, p) => ({
      undelivered: acc.undelivered + p.undelivered,
      flagged: acc.flagged + p.flagged,
    }),
    { undelivered: 0, flagged: 0 },
  );
  return { perProject, ...totals };
}

// ---------------------------------------------------------------------------
// PURE — census de scheduled tasks
// ---------------------------------------------------------------------------

/**
 * Salidas no-cero que NO son fallas: son el canal de alerta documentado de esa
 * task. Un census que las pinte de rojo entrena al operador a ignorar el rojo
 * — la clase exacta de alarma-que-miente que el A4 acaba de desarmar.
 */
const CONTRACT_NONZERO = {
  'wezbridge-fleet-steward': 'exit 1 = el operador debe algo (contrato documentado)',
  'wezbridge-steward-gate': 'exit 1 = gate RED, el poke ya disparó (contrato)',
  'wezbridge-orchestrator-turn': 'exit 30 = loop stalled, ESA es la alerta (contrato)',
  'infra-coolify-drift-check': 'exit 1 = drift, exit 2 = check incompleto (contrato)',
};

/**
 * Parser del CSV de `schtasks /query /v /fo csv`. NO es CSV honesto: los
 * campos con comillas embebidas (Task To Run) no las duplican, así que un
 * parser RFC se rompe. `","` como separador sobrevive porque schtasks nunca
 * emite esa secuencia dentro de un campo. Repite el header por carpeta:
 * toda línea idéntica al header se descarta.
 */
function parseSchtasksCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const parse = (l) => l.replace(/^"/, '').replace(/"$/, '').split('","');
  const header = parse(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    if (line === lines[0]) continue; // header repetido
    const cells = parse(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

/**
 * Clase de una fila del census. `silent-failure` es LA clase que motivó esta
 * sección: routine-test-strength-wezbridge salió 1 durante seis días y nada
 * en el sistema lo dijo — el Last Result solo existe si alguien lo lee.
 */
function classifyCensusRow(row, contractMap = CONTRACT_NONZERO) {
  const name = String(row.TaskName || '').replace(/^\\/, '');
  const result = String(row['Last Result'] || '').trim();
  const state = String(row['Scheduled Task State'] || row.Status || '');
  if (/disabled/i.test(state)) return { name, class: 'disabled', note: null };
  if (result === '267011' || /N\/A/i.test(String(row['Last Run Time'] || ''))) {
    return { name, class: 'never-ran', note: null };
  }
  if (result === '267009') return { name, class: 'running', note: null };
  if (result === '0') return { name, class: 'ok', note: null };
  if (contractMap[name]) return { name, class: 'contract-signal', note: contractMap[name] };
  return { name, class: 'silent-failure', note: `Last Result ${result} y nadie lo estaba mirando` };
}

function summarizeCensus(rows, { pattern = /^(wezbridge|routine-|NAS-|brlite|PyApps-)/i, contractMap } = {}) {
  const seen = new Set();
  const items = [];
  for (const row of rows || []) {
    const name = String(row.TaskName || '').replace(/^\\/, '');
    if (!pattern.test(name) || seen.has(name)) continue;
    seen.add(name);
    items.push({
      ...classifyCensusRow(row, contractMap),
      lastRun: row['Last Run Time'] || '?',
      lastResult: row['Last Result'] || '?',
      nextRun: row['Next Run Time'] || '?',
    });
  }
  const silent = items.filter((i) => i.class === 'silent-failure');
  return { items, silent };
}

// ---------------------------------------------------------------------------
// PURE — render
// ---------------------------------------------------------------------------

const fmtHist = (h) => Object.entries(h).map(([k, v]) => `${k}=${v}`).join(', ') || '—';
const trunc = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

function renderRollup(data) {
  const {
    date, generatedAt, turns, actions, results, rulings, gates, census, ledger, queues,
  } = data;
  const L = [];
  // Doc-head: 7 líneas densas y greppeables (regla de instrucción global).
  L.push(`# Rollup diario del operador — ${date}`);
  L.push(`Generado ${generatedAt} por scripts/daily-rollup.cjs — determinista, $0, sin LLM. Fuente: _intel/{turns,actions.jsonl,a2a-results.jsonl,rulings.jsonl,queues,tasks} + gates latest + schtasks.`);
  L.push('Cubre: gates, turnos del waker (clases + % sin acción, meta <20%), acciones de flota, results A2A con ledger de decisiones (menor confianza primero), rulings, colas por proyecto, census de scheduled tasks (Last Result, clase silent-failure), resumen del ledger, autoeval del orquestador.');
  L.push('Key terms: waker_skip, silent-failure, contract-signal, auto_ack, auto_close_shadow, spawn_refused, misroutes, decisions ledger.');
  L.push('Leer cuando: revisión matinal del operador. El histórico vive en _intel/rollups/.');
  L.push('Regla: cada número cita su fuente; un número sin fuente es prosa.');
  L.push('Ventana: día LOCAL del operador; la corrida de 02:30 cierra el día anterior.');
  L.push('');

  L.push('## Gates');
  L.push(`- steward-gate: ${trunc(gates.steward, 200) || 'SIN ARCHIVO — el gate no corrió o no escribió su latest'}`);
  L.push(`- board-fresh-gate: ${trunc(gates.boardFresh, 200) || 'SIN ARCHIVO'}`);
  L.push('');

  L.push(`## Turnos del waker (${turns.total} — fuente turns/*.json)`);
  L.push(`- woke=${turns.woke} · skip $0=${turns.skips} · acciones: ${fmtHist(turns.byAction)}`);
  L.push(`- clases de razón: ${fmtHist(turns.byClass)}`);
  L.push(`- turnos woke SIN acción: ${turns.unproductiveWoke}/${turns.woke} = ${turns.pctWokeSinAccion}% (meta <20%) · stalls máx=${turns.maxStalls}`);
  if (turns.noise.length) L.push(`- ruido filtrado sin despertar (mm-d216): ${turns.noise.map((n) => trunc(n, 60)).join(' · ')}`);
  L.push('');

  L.push(`## Acciones de flota (${actions.total} — fuente actions.jsonl)`);
  L.push(`- ${fmtHist(actions.byAction)}`);
  L.push('');

  L.push(`## Results A2A (${results.total} — fuente a2a-results.jsonl)`);
  L.push(`- criteria v2: ok=${results.v2.ok} partial=${results.v2.partial} missing=${results.v2.missing} · abandons=${results.abandons} · con evidencia=${results.withEvidence}/${results.total}`);
  if (results.decisions.length) {
    L.push(`- decisiones tomadas donde el plan callaba (${results.decisions.length}, menor confianza primero):`);
    for (const d of results.decisions) {
      L.push(`  - [${d.confidence || 'sin conf'}] (${d.corr} · pane-${d.from_pane}) ${trunc(d.decision, 140)}${d.would_have_asked ? ` — habría preguntado: ${trunc(d.would_have_asked, 100)}` : ''}`);
    }
  } else {
    L.push('- sin bloques decisions: hoy (0 items).');
  }
  L.push('');

  L.push(`## Rulings (${rulings.total} — fuente rulings.jsonl)`);
  L.push(`- ${fmtHist(rulings.byRuling)}`);
  for (const r of rulings.items) {
    L.push(`  - ${r.task} → ${r.ruling}${r.until ? ` (hasta ${r.until})` : ''}: ${trunc(r.why, 140)}`);
  }
  L.push('');

  L.push('## Colas por proyecto (fuente _intel/queues/)');
  const qEntries = Object.entries(queues.perProject);
  if (!qEntries.length) L.push('- sin colas con actividad hoy.');
  for (const [p, q] of qEntries) {
    L.push(`- ${p}: ${q.total} envíos (ok=${q.delivered}, sin entregar=${q.undelivered}) · flagged=${q.flagged}`);
  }
  L.push('');

  L.push('## Census de scheduled tasks (fuente schtasks /query /v)');
  if (census.skipped) {
    L.push('- CENSUS OMITIDO en esta corrida (schtasks no disponible o suprimido).');
  } else {
    for (const t of census.items) {
      const mark = t.class === 'silent-failure' ? ' ⟵ FALLA SILENCIOSA' : '';
      L.push(`- ${t.name}: ${t.class}${mark} · last=${t.lastResult} @ ${t.lastRun} · next=${t.nextRun}${t.note ? ` · ${t.note}` : ''}`);
    }
    L.push(census.silent.length
      ? `- ⚠ ${census.silent.length} task(s) en clase silent-failure: ${census.silent.map((s) => s.name).join(', ')} — exit≠0 que NADIE lee salvo este census.`
      : '- 0 tasks en clase silent-failure.');
  }
  L.push('');

  L.push('## Ledger (fuente _intel/tasks/*.json + dashboard.md)');
  L.push(`- estados: ${fmtHist(ledger.byState)}`);
  if (ledger.dashboardLine) L.push(`- dashboard: ${trunc(ledger.dashboardLine, 200)}`);
  L.push('');

  const canc = ledger.cancellations || { cancelled: 0, byOrigin: {} };
  L.push('## Cancelaciones por origen (fuente origin_key de _intel/tasks/*.json)');
  const origins = Object.entries(canc.byOrigin).sort((a, b) => b[1].cancelled - a[1].cancelled || a[0].localeCompare(b[0]));
  if (!origins.length) L.push('- sin tarjetas');
  for (const [k, v] of origins) L.push(`- ${k}: ${v.cancelled}/${v.total} (${Math.round(v.rate * 100)}%)`);
  L.push(`- total canceladas: ${canc.cancelled}`);
  L.push('');

  const a = actions.byAction;
  L.push('## Autoeval del orquestador');
  L.push(`- dispatches: ${(a.spawn_pane || 0) + (a.queue_deliver || 0)} (spawn_pane=${a.spawn_pane || 0}, queue_deliver=${a.queue_deliver || 0} — fuente actions.jsonl)`);
  L.push(`- misroutes=0?: ${queues.undelivered === 0 && queues.flagged === 0 ? 'SÍ' : `NO — ${queues.undelivered} envíos sin entregar + ${queues.flagged} flagged en colas`} (fuente queues/*.jsonl + flags)`);
  L.push(`- % turnos woke sin acción: ${turns.pctWokeSinAccion}% (meta <20%) · skips $0 del clasificador: ${turns.skips}`);
  L.push(`- turnos LLM ahorrados por auto_ack: ${a.auto_ack || 0} · spawn_refused (tope): ${a.spawn_refused || 0} · auto_close_shadow (solo sombra, nada muerto): ${a.auto_close_shadow || 0}`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// IO — colectores (cada uno tolera archivo/dir ausente: sección vacía, no crash)
// ---------------------------------------------------------------------------

function readJsonl(file, date, tsField) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { const o = JSON.parse(l); return isOnDate(o[tsField], date) ? [o] : []; } catch { return []; }
    });
  } catch { return []; }
}

function collectTurns(dir, date) {
  try {
    return fs.readdirSync(path.join(dir, 'turns'))
      .filter((f) => f.startsWith('turn-') && f.endsWith('.json'))
      .flatMap((f) => {
        try { const t = JSON.parse(fs.readFileSync(path.join(dir, 'turns', f), 'utf8')); return isOnDate(t.at, date) ? [t] : []; } catch { return []; }
      });
  } catch { return []; }
}

function collectQueues(dir, date) {
  const { listQueues } = require(path.join(REPO, 'src', 'project-queue.cjs'));
  return listQueues({ base: dir }).map((project) => {
    const records = readJsonl(path.join(dir, 'queues', `${project}.jsonl`), date, 'time');
    let flagged = 0;
    try {
      flagged = Object.keys(JSON.parse(fs.readFileSync(
        path.join(dir, 'queues', 'state', project, 'flags.json'), 'utf8',
      ))).length;
    } catch { /* sin estado = sin flags */ }
    return { project, records, flagged };
  });
}

/**
 * W6 (T31): cancelaciones por origen. El prefijo de origin_key (antes del primer ':')
 * dice de DONDE vino el trabajo que murio: roadmap:, orchestrator:, codex-turn-end:...
 * Sin origin_key => 'manual'. La tasa se calcula sobre TODAS las tarjetas del prefijo,
 * no solo las canceladas, para que "roadmap 3" signifique algo (3 de cuantas).
 */
function summarizeCancellations(tasks) {
  const byOrigin = {};
  let cancelled = 0;
  for (const t of tasks || []) {
    const key = t && typeof t.origin_key === 'string' && t.origin_key.trim()
      ? t.origin_key.split(':')[0]
      : 'manual';
    const b = byOrigin[key] || (byOrigin[key] = { cancelled: 0, total: 0, rate: 0 });
    b.total += 1;
    if (t && t.state === 'cancelled') { b.cancelled += 1; cancelled += 1; }
  }
  for (const b of Object.values(byOrigin)) b.rate = b.total ? b.cancelled / b.total : 0;
  return { cancelled, byOrigin };
}

function collectLedger(dir) {
  const byState = {};
  const tasks = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'tasks'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', f), 'utf8'));
        tasks.push(t);
        byState[t.state || '?'] = (byState[t.state || '?'] || 0) + 1;
      } catch { /* tarea ilegible: no cuenta */ }
    }
  } catch { /* sin ledger */ }
  let dashboardLine = null;
  try { dashboardLine = fs.readFileSync(path.join(dir, 'dashboard.md'), 'utf8').split('\n')[1] || null; } catch { /* sin dashboard */ }
  return { byState, dashboardLine, cancellations: summarizeCancellations(tasks) };
}

function readFirstLine(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').find((l) => l.trim()) || null; } catch { return null; }
}

function collectCensus() {
  if (process.env.WEZBRIDGE_ROLLUP_SKIP_CENSUS === '1') return { skipped: true, items: [], silent: [] };
  const r = spawnSync('schtasks', ['/query', '/v', '/fo', 'csv'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.error || r.status !== 0) return { skipped: true, items: [], silent: [] };
  return summarizeCensus(parseSchtasksCsv(r.stdout));
}

/**
 * Genera el rollup del día y lo escribe en <intel>/rollups/<date>.md.
 * `censusRows` inyectable (tests); dryRun evita el logAction, no el archivo:
 * el archivo ES el entregable y un dry-run que no lo produce no prueba nada.
 */
function generateRollup({ now = new Date(), date, dryRun = false, censusRows } = {}) {
  const dir = intelDir();
  const day = date || reportDateFor(now);
  const data = {
    date: day,
    generatedAt: now.toISOString(),
    turns: summarizeTurns(collectTurns(dir, day)),
    actions: summarizeActions(readJsonl(path.join(dir, 'actions.jsonl'), day, 'ts')),
    results: summarizeResults(readJsonl(path.join(dir, 'a2a-results.jsonl'), day, 'time')),
    rulings: summarizeRulings(readJsonl(path.join(dir, 'rulings.jsonl'), day, 'at')),
    gates: {
      steward: readFirstLine(path.join(dir, 'steward-gate-latest.txt')),
      boardFresh: readFirstLine(path.join(dir, 'board-fresh-gate-latest.txt')),
    },
    census: censusRows ? summarizeCensus(censusRows) : collectCensus(),
    ledger: collectLedger(dir),
    queues: summarizeQueues(collectQueues(dir, day)),
  };
  const md = renderRollup(data);
  const outDir = path.join(dir, 'rollups');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${day}.md`);
  fs.writeFileSync(outFile, md);
  if (!dryRun) {
    try {
      const { logAction } = require(path.join(REPO, 'src', 'action-log.cjs'));
      logAction('daily_rollup', {
        target: outFile,
        why: `rollup diario ${day}`,
        extra: { turns: data.turns.total, actions: data.actions.total, results: data.results.total, silent_failures: data.census.silent.length },
      });
    } catch { /* la observabilidad no rompe el rollup */ }
  }
  return { file: outFile, data, md };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dateIdx = process.argv.indexOf('--date');
  const date = dateIdx !== -1 ? process.argv[dateIdx + 1] : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`daily-rollup: --date inválida: ${date} (formato YYYY-MM-DD)`);
    return 1;
  }
  try {
    const { file, data } = generateRollup({ date, dryRun });
    console.log(`${new Date().toISOString()} daily-rollup${dryRun ? ' (dry-run)' : ''}: ${file}`);
    console.log(`  turnos=${data.turns.total} acciones=${data.actions.total} results=${data.results.total} rulings=${data.rulings.total} silent-failures=${data.census.silent.length}`);
    return 0;
  } catch (err) {
    console.error(`daily-rollup BROKE: ${err.stack || err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = {
  reportDateFor, localDateOf, isOnDate,
  summarizeTurns, summarizeActions, summarizeResults, summarizeRulings, summarizeQueues, summarizeCancellations,
  sortDecisions, parseSchtasksCsv, classifyCensusRow, summarizeCensus, CONTRACT_NONZERO,
  renderRollup, generateRollup,
};
