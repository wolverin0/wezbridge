#!/usr/bin/env node
'use strict';
/**
 * weekly-retro.cjs — retro semanal de RL de la flota, determinista, $0 (sin
 * LLM en este archivo; una sección de juicio opcional con worker-t1 puede
 * sumarse en OTRA carta, no acá). Lee los mismos _intel/{tasks,events.jsonl,
 * actions.jsonl,queues,rulings.jsonl,foreman} que scripts/daily-rollup.cjs y
 * REUSA sus colectores/summarizers de tarjeta (buildCardRow, redispatchCount)
 * para no duplicar la lógica de duración/redespacho/espera. Escribe
 * _intel/rollups/retro-YYYY-Www.md. Corre lunes 08:15 (wezbridge-weekly-retro,
 * mismo patrón hidden-task que wezbridge-daily-rollup).
 * Uso: node scripts/weekly-retro.cjs [--dry-run] [--now <iso>].
 * Puros exportados (isoWeek, windowFor, summarize*, generateRecommendations,
 * renderRetro) — test sin FS ni clock. T-0551, absorbe T-0246.
 *
 * Todo número cita su fuente, misma regla que el rollup diario.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const DR = require(path.join(__dirname, 'daily-rollup.cjs'));

function intelDir() {
  return process.env.WEZBRIDGE_INTEL_DIR || path.join(REPO, '..', '_intel');
}

// ---------------------------------------------------------------------------
// PURE — ventana de 7 días e ISO week
// ---------------------------------------------------------------------------

/** YYYY-Www (ISO 8601 week date) del instante `now`, en UTC — una semana no
 * depende de zona horaria del operador, a diferencia del día del rollup diario. */
function isoWeek(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // lunes=0 ... domingo=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // jueves de esa semana ISO
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Ventana rodante de `days` días terminando en `now` (exclusive). Corrida de
 * lunes 08:15 sobre `days=7` cubre aproximadamente la semana calendario
 * anterior completa — no se alinea a medianoche a propósito, es una ventana
 * de "últimos 7 días", no "semana ISO exacta" (esa sólo nombra el archivo). */
function windowFor(now, days = 7) {
  const to = new Date(now.getTime());
  const from = new Date(now.getTime() - days * 86400000);
  return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
}

function inWindow(iso, window) {
  const t = new Date(iso || '');
  if (Number.isNaN(t.getTime())) return false;
  return t >= window.from && t < window.to;
}

// ---------------------------------------------------------------------------
// PURE — summarizers
// ---------------------------------------------------------------------------

const ABANDON_RE = /ABANDON:?\s*([^\n.]{0,160})/gi;
const FALSE_POSITIVE_RE = /falso positivo/i;

/**
 * Foreman = el detector de falsos positivos de la flota. Su directorio
 * (`_intel/foreman/`) puede no existir o no tener JSON todavía — se lee
 * tolerante. Además se escanea `evaluator_evidence` de las tarjetas de la
 * ventana por la frase literal "falso positivo": es donde el operador o un
 * revisor asienta el hallazgo cuando Foreman (o cualquier otro chequeo)
 * marcó algo que no era. Dos fuentes, un conteo, cada item dice de cuál vino.
 */
function summarizeForemanFalsePositives({ foremanFiles, tasks, window }) {
  const items = [];
  for (const f of foremanFiles || []) {
    const text = JSON.stringify(f.data || {});
    if (FALSE_POSITIVE_RE.test(text) || f.data?.false_positive === true || f.data?.verdict === 'false_positive') {
      items.push({ source: `foreman/${f.name}`, id: f.data?.task_id || f.data?.id || null });
    }
  }
  for (const t of tasks || []) {
    if (!inWindow(t.state_changed_at, window)) continue;
    if (FALSE_POSITIVE_RE.test(t.evaluator_evidence || '')) {
      items.push({ source: `tasks/${t.id}.json (evaluator_evidence)`, id: t.id });
    }
  }
  return { count: items.length, items };
}

/** Tarjetas que ESTA semana quedaron done pero fueron redespachadas (mismo
 * corr, >1 despacho histórico en actions.jsonl/colas) — trabajo ya hecho al
 * que se le volvió a mandar gente. Reusa redispatchCount del rollup diario. */
function summarizeRedispatchesOfDoneWork({ tasks, actionsAll, queueRecordsAll, window }) {
  const items = [];
  let total = 0;
  for (const t of tasks || []) {
    if (t.state !== 'done' || !inWindow(t.state_changed_at, window)) continue;
    const n = DR.redispatchCount(t.id, actionsAll, queueRecordsAll);
    if (n > 0) { items.push({ id: t.id, redispatches: n }); total += n; }
  }
  items.sort((a, b) => b.redispatches - a.redispatches);
  return { total, items };
}

/** Horas de espera de decisión del operador por tarjeta, reusando
 * buildCardRow (mismo cálculo que "Tarjetas del día": tiempo con
 * blocked_by=operator hasta el cierre, o hasta `now` si sigue abierta).
 * Tarjeta entra a la ventana si cerró en ella O si sigue con espera abierta
 * ahora mismo — una espera activa de 10 días no puede desaparecer del retro
 * solo porque no cerró todavía. */
function summarizeOperatorWaitHours({ tasks, events, window, now }) {
  const rows = [];
  for (const t of tasks || []) {
    const closedInWindow = TERMINAL_STATES(t.state) && inWindow(t.state_changed_at, window);
    const stillBlocked = t.blocked_by === 'operator' && !TERMINAL_STATES(t.state);
    if (!closedInWindow && !stillBlocked) continue;
    const row = DR.buildCardRow(t, events, [], [], []);
    if (row.decisionWaitHours !== null) rows.push({ id: t.id, hours: row.decisionWaitHours });
  }
  rows.sort((a, b) => b.hours - a.hours);
  const sum = Math.round(rows.reduce((acc, r) => acc + r.hours, 0) * 10) / 10;
  return { sum, top5: rows.slice(0, 5), count: rows.length };
}
function TERMINAL_STATES(state) { return state === 'done' || state === 'failed' || state === 'cancelled'; }

/** Tarjetas cerradas con ABANDON dentro de la ventana + qué criterio se
 * abandonó, extraído literalmente de evaluator_evidence (línea "ABANDON: ..."
 * — es el marcador que ledger.cjs exige para cerrar un criterio imposible en
 * vez de narrarlo como pass, ver _docs-curation/ledger.cjs). */
function summarizeAbandons({ tasks, window }) {
  const items = [];
  for (const t of tasks || []) {
    if (t.state !== 'done' || !inWindow(t.state_changed_at, window)) continue;
    const evidence = t.evaluator_evidence || '';
    const matches = [...evidence.matchAll(ABANDON_RE)].map((m) => m[1].trim());
    if (matches.length) items.push({ id: t.id, criteria: matches });
  }
  return { count: items.length, items };
}

/** Costo por tier: NO hay conteo de tokens por tarjeta todavía (el ledger no
 * los graba), así que esto cuenta TARJETAS por (model, effort) y adjunta el
 * precio por Mtok de _intel/model-tiers.json cuando el modelo aparece ahí —
 * un proxy de exposición de costo, no un total en $. */
function summarizeCostByTier({ tasks, window, modelTiers }) {
  const groups = new Map();
  for (const t of tasks || []) {
    if (!inWindow(t.state_changed_at, window)) continue;
    const model = t.model || 'desconocido';
    const effort = t.effort || '—';
    const key = `${model}|${effort}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const models = (modelTiers && modelTiers.models) || {};
  return [...groups.entries()].map(([key, count]) => {
    const [model, effort] = key.split('|');
    const priced = models[model];
    return {
      model, effort, count,
      price_in: priced ? priced.price_in : null,
      price_out: priced ? priced.price_out : null,
    };
  }).sort((a, b) => b.count - a.count);
}

/**
 * Tres recomendaciones, siempre — ni cero (nada que decir no es lo mismo que
 * nada que mirar) ni una lista de largo variable (dificulta comparar semana a
 * semana). Reglas en orden fijo: espera del operador, redespachos, Foreman +
 * ABANDON. Cada regla decide su propio texto según si hay hallazgo o no, pero
 * SIEMPRE devuelve una línea — el "sin hallazgos" también es información.
 */
function generateRecommendations({ waits, redispatches, foreman, abandons }) {
  const recs = [];

  const overThreshold = waits.top5.filter((r) => r.hours > 48);
  recs.push(overThreshold.length
    ? `${overThreshold.length} tarjeta(s) esperaron >48h una decisión del operador (${overThreshold.map((r) => r.id).join(', ')}): defaultealas o resolvé la pregunta esta semana.`
    : `Esperas de decisión del operador OK: máximo ${waits.top5[0] ? waits.top5[0].hours : 0}h de ${waits.count} tarjeta(s) medida(s) (umbral 48h).`);

  recs.push(redispatches.total > 0
    ? `${redispatches.total} redespacho(s) de trabajo ya hecho esta semana (tarjetas: ${redispatches.items.map((i) => i.id).join(', ')}): revisar dedupe de despacho por corr.`
    : '0 redespachos de trabajo ya hecho detectados esta semana.');

  const fpAndAbandon = foreman.count + abandons.count;
  recs.push(fpAndAbandon > 0
    ? `${foreman.count} falso(s) positivo(s) de Foreman + ${abandons.count} tarjeta(s) con ABANDON esta semana: revisar criterios (${abandons.items.map((i) => i.id).join(', ') || 'sin ids de ABANDON'}).`
    : '0 falsos positivos de Foreman y 0 ABANDON esta semana.');

  return recs;
}

// ---------------------------------------------------------------------------
// PURE — render
// ---------------------------------------------------------------------------

const trunc = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

function renderRetro(data) {
  const {
    week, generatedAt, windowLabel, foreman, redispatches, waits, abandons, costByTier, recommendations,
  } = data;
  const L = [];
  L.push(`# Retro semanal de RL de la flota — ${week}`);
  L.push(`Generado ${generatedAt} por scripts/weekly-retro.cjs — determinista, $0, sin LLM. Fuente: _intel/{tasks,events.jsonl,actions.jsonl,queues,foreman,model-tiers.json}.`);
  L.push('Cubre: falsos positivos de Foreman, redespachos de trabajo ya hecho, horas de espera de decisión del operador (suma + top 5), tarjetas ABANDON y qué criterio, costo estimado por tier (conteo de tarjetas, tokens no medidos), 3 recomendaciones por reglas.');
  L.push('Key terms: falso positivo, redespacho, espera de decisión, ABANDON, tier de modelo.');
  L.push(`Leer cuando: lunes a la mañana. Ventana: ${windowLabel}. El histórico vive en _intel/rollups/retro-*.md.`);
  L.push('Regla: cada número cita su fuente; un número sin fuente es prosa.');
  L.push('Generador: node scripts/weekly-retro.cjs (registrado como wezbridge-weekly-retro, lunes 08:15).');
  L.push('');

  L.push(`## Falsos positivos de Foreman (${foreman.count} — fuente _intel/foreman/*.json + tasks/*.json evaluator_evidence)`);
  if (!foreman.items.length) L.push('- 0 en la ventana.');
  for (const it of foreman.items) L.push(`- ${it.id || '(sin id)'} — ${it.source}`);
  L.push('');

  L.push(`## Redespachos de trabajo ya hecho (${redispatches.total} — fuente actions.jsonl + queues/*.jsonl por corr)`);
  if (!redispatches.items.length) L.push('- 0 en la ventana.');
  for (const it of redispatches.items) L.push(`- ${it.id}: ${it.redispatches} redespacho(s)`);
  L.push('');

  L.push(`## Esperas de decisión del operador (suma ${waits.sum}h sobre ${waits.count} tarjeta(s) — fuente events.jsonl blocked_by=operator)`);
  if (!waits.top5.length) L.push('- sin esperas medidas en la ventana.');
  L.push('Top 5:');
  for (const r of waits.top5) L.push(`- ${r.id}: ${r.hours}h`);
  L.push('');

  L.push(`## Tarjetas ABANDON (${abandons.count} — fuente tasks/*.json evaluator_evidence)`);
  if (!abandons.items.length) L.push('- 0 en la ventana.');
  for (const it of abandons.items) {
    for (const c of it.criteria) L.push(`- ${it.id}: ${trunc(c, 160)}`);
  }
  L.push('');

  L.push(`## Costo estimado por tier (${costByTier.length} grupo(s) — fuente tasks/*.json model/effort × _intel/model-tiers.json; tokens NO medidos, esto es conteo de tarjetas)`);
  if (!costByTier.length) L.push('- sin tarjetas en la ventana.');
  else {
    L.push('| model | effort | tarjetas | $in/Mtok | $out/Mtok |');
    L.push('|---|---|---|---|---|');
    for (const g of costByTier) L.push(`| ${g.model} | ${g.effort} | ${g.count} | ${g.price_in ?? '—'} | ${g.price_out ?? '—'} |`);
  }
  L.push('');

  L.push('## Recomendaciones (3, generadas por reglas — ver generateRecommendations)');
  recommendations.forEach((r, i) => L.push(`${i + 1}. ${r}`));
  L.push('');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function collectForemanFiles(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'foreman'))
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try { return [{ name: f, data: JSON.parse(fs.readFileSync(path.join(dir, 'foreman', f), 'utf8')) }]; } catch { return []; }
      });
  } catch { return []; } // sin directorio: nada que leer, no rompe
}

function collectModelTiers(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'model-tiers.json'), 'utf8')); } catch { return null; }
}

function generateRetro({ now = new Date(), dryRun = false } = {}) {
  const dir = intelDir();
  const window = windowFor(now);
  const tasks = DR.collectAllTasks(dir);
  const events = DR.collectEvents(dir);
  const actionsAll = DR.collectAllActions(dir);
  const queueRecordsAll = DR.collectAllQueueRecords(dir);
  const foremanFiles = collectForemanFiles(dir);
  const modelTiers = collectModelTiers(dir);

  const foreman = summarizeForemanFalsePositives({ foremanFiles, tasks, window });
  const redispatches = summarizeRedispatchesOfDoneWork({ tasks, actionsAll, queueRecordsAll, window });
  const waits = summarizeOperatorWaitHours({ tasks, events, window, now });
  const abandons = summarizeAbandons({ tasks, window });
  const costByTier = summarizeCostByTier({ tasks, window, modelTiers });
  const recommendations = generateRecommendations({ waits, redispatches, foreman, abandons });

  const week = isoWeek(now);
  const data = {
    week,
    generatedAt: now.toISOString(),
    windowLabel: `${window.fromIso} → ${window.toIso}`,
    foreman,
    redispatches,
    waits,
    abandons,
    costByTier,
    recommendations,
  };
  const md = renderRetro(data);
  const outDir = path.join(dir, 'rollups');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `retro-${week}.md`);
  fs.writeFileSync(outFile, md);
  if (!dryRun) {
    try {
      const { logAction } = require(path.join(REPO, 'src', 'action-log.cjs'));
      logAction('weekly_retro', {
        target: outFile,
        why: `retro semanal ${week}`,
        extra: {
          foreman_fp: foreman.count, redispatches: redispatches.total,
          wait_hours_sum: waits.sum, abandons: abandons.count,
        },
      });
    } catch { /* la observabilidad no rompe la retro */ }
  }
  return { file: outFile, data, md };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const nowIdx = process.argv.indexOf('--now');
  const nowArg = nowIdx !== -1 ? process.argv[nowIdx + 1] : undefined;
  const now = nowArg ? new Date(nowArg) : new Date();
  if (nowArg && Number.isNaN(now.getTime())) {
    console.error(`weekly-retro: --now inválido: ${nowArg}`);
    return 1;
  }
  try {
    const { file, data } = generateRetro({ now, dryRun });
    console.log(`${new Date().toISOString()} weekly-retro${dryRun ? ' (dry-run)' : ''}: ${file}`);
    console.log(`  semana=${data.week} foreman_fp=${data.foreman.count} redespachos=${data.redispatches.total} espera_h=${data.waits.sum} abandons=${data.abandons.count}`);
    try {
      const { renderRollupHtml } = require(path.join(__dirname, 'rollup-to-html.cjs'));
      const htmlFile = renderRollupHtml(file);
      console.log(`  html: ${htmlFile}`);
    } catch (err) {
      console.error(`  rollup-to-html no corrió (no rompe la retro): ${err.message}`);
    }
    return 0;
  } catch (err) {
    console.error(`weekly-retro BROKE: ${err.stack || err.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = {
  isoWeek, windowFor, inWindow,
  summarizeForemanFalsePositives, summarizeRedispatchesOfDoneWork, summarizeOperatorWaitHours,
  summarizeAbandons, summarizeCostByTier, generateRecommendations,
  renderRetro, generateRetro, collectForemanFiles, collectModelTiers,
};
