#!/usr/bin/env node
'use strict';
/**
 * decidir.cjs — el operador decidio EN ESTE PANE: escribilo ANTES de actuar (T-0326).
 *
 *   node scripts/decidir.cjs T-0303 aprobar  "dale, hacelo"                 [--corr X]
 *   node scripts/decidir.cjs T-0253 cancelar "olvidate de eso"
 *   node scripts/decidir.cjs T-0312 diferir  "despues del deploy" --until 2026-09-03T14:00:00Z
 *
 * Veredictos (letra o palabra): a|aprobar|approved · c|cancelar|cancelled · d|diferir|deferred.
 * El tercer argumento es lo que dijo el operador, TEXTUAL: es la razon del ruling.
 *
 * Arma y corre `ledger.cjs decide <T> --ruling <r> --why "<textual>" --source
 * orchestrator-pane --by operator --corr <corr>` (el corr sale de la tarjeta si no
 * se pasa). Es el mismo camino que el tablero: ruling PRIMERO en rulings.jsonl,
 * FSM despues, des-gate de la tarjeta. Sin este paso el fleet se entera horas
 * despues (o nunca) y el steward lo marca `decision-unrecorded`.
 *
 * Exit: 0 escrito y tarjeta movida · 1 escrito pero la tarjeta no se movio (lo
 * dice ledger) · 2 uso · 3 ledger no encontrado.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERDICTS = Object.freeze({
  a: 'approved', aprobar: 'approved', approved: 'approved', aprobado: 'approved', si: 'approved',
  c: 'cancelled', cancelar: 'cancelled', cancelled: 'cancelled', cancelado: 'cancelled', no: 'cancelled',
  d: 'deferred', diferir: 'deferred', deferred: 'deferred', diferido: 'deferred', despues: 'deferred',
});

function usage(msg) {
  if (msg) console.error(`decidir: ${msg}`);
  console.error('uso: node scripts/decidir.cjs T-NNNN aprobar|cancelar|diferir "<lo que dijo el operador, textual>" [--corr <id>] [--until <iso>] [--by operator]');
  return 2;
}

/** Puro: arma los argumentos de `ledger decide` a partir de la orden del operador. */
function buildDecideArgs({ task, verdict, why, corr, until, by = 'operator', card = null }) {
  if (!/^T-\d{4}$/.test(String(task || ''))) throw new Error(`tarjeta invalida ${JSON.stringify(task)} (T-NNNN)`);
  const ruling = VERDICTS[String(verdict || '').trim().toLowerCase()];
  if (!ruling) throw new Error(`veredicto ${JSON.stringify(verdict)}: usa aprobar | cancelar | diferir (o a | c | d)`);
  if (!String(why || '').trim()) throw new Error('falta el textual del operador: es la razon del ruling, no se inventa');
  if (ruling === 'deferred' && !until) throw new Error('diferir necesita --until <iso futuro>');
  const args = ['decide', task, '--ruling', ruling, '--why', String(why).trim(), '--source', 'orchestrator-pane', '--by', by];
  const c = corr || (card && card.corr) || null;
  if (c) args.push('--corr', String(c));
  if (until) args.push('--until', String(until));
  return { ruling, args, corr: c };
}

function parseCli(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i += 1; } else pos.push(argv[i]);
  }
  return { task: pos[0], verdict: pos[1], why: pos.slice(2).join(' '), ...opts };
}

function main() {
  const o = parseCli(process.argv.slice(2));
  if (!o.task || !o.verdict) return usage();
  const intel = process.env.WEZBRIDGE_INTEL_DIR || path.resolve(__dirname, '..', '..', '_intel');
  const ledger = process.env.WEZBRIDGE_LEDGER_PATH || path.resolve(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
  if (!fs.existsSync(ledger)) { console.error(`decidir: no encuentro ${ledger}`); return 3; }
  let card = null;
  try { card = JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${o.task}.json`), 'utf8')); } catch { card = null; }
  let plan;
  try { plan = buildDecideArgs({ ...o, card }); } catch (e) { return usage(e.message); }
  const env = { ...process.env, WEZBRIDGE_INTEL_DIR: intel, WEZBRIDGE_ROOT: process.env.WEZBRIDGE_ROOT || path.resolve(__dirname, '..') };
  const r = spawnSync(process.execPath, [ledger, ...plan.args], { encoding: 'utf8', env });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status === 0) {
    console.log(`decidir: ${o.task} ${plan.ruling} by operator${plan.corr ? ` corr=${plan.corr}` : ''} — escrito en rulings.jsonl ANTES de actuar. Ahora si: actua.`);
  }
  return r.status === null ? 1 : r.status;
}

module.exports = { buildDecideArgs, VERDICTS, parseCli };
if (require.main === module) process.exit(main());
