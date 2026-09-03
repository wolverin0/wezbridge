#!/usr/bin/env node
'use strict';
/**
 * intake-card.cjs — de una idea anotada en Super Productivity (proyecto Intake) a una
 * tarjeta del ledger, idempotente (T-0338).
 *
 * sp-bridge exporta cada tarea nueva de Intake a `_intel/intake/<taskId>.json`
 * ({taskId, title, notes, created, exportedAt, t_id:null}). El turno del orquestador
 * (routines/orchestrator-turn.md, paso "Intake") lee el brief con `--list`, redacta el
 * goal en terminos ejecutables, elige repo y kind, escribe >= 2 criterios verificables
 * y llama a `create`. Este script es la parte que NO debe hacer el modelo:
 *   - crea la tarjeta con `--origin sp:<taskId>` (findByOrigin => una sola tarjeta por idea,
 *     igual que roadmap-import), corr `sp:<taskId>`, refs al json;
 *   - exige >= 2 criterios y goal no vacio (falla cerrado);
 *   - escribe `t_id` + `cardedAt` en el json para que sp-bridge lo devuelva a la nota de la
 *     tarea y complete la tarea cuando la tarjeta cierre.
 *
 * CLI:
 *   node scripts/intake-card.cjs --list                      # pendientes (sin t_id), JSON
 *   node scripts/intake-card.cjs create <taskId> --repo <slug> --kind <kind> --goal "..."
 *        --criterion "..." --criterion "..." [--state queued|blocked] [--blocked-by agent|operator]
 *        [--title "..."] [--next "..."]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INTEL = process.env.WEZBRIDGE_INTEL_DIR || path.resolve(__dirname, '..', '..', '_intel');
const LEDGER = process.env.WEZBRIDGE_LEDGER_PATH || path.resolve(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');

function intakeDir(intel = INTEL) { return path.join(intel, 'intake'); }
function readIntake(intel = INTEL) {
  let names = [];
  try { names = fs.readdirSync(intakeDir(intel)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of names) {
    try { out.push({ file: path.join(intakeDir(intel), f), ...JSON.parse(fs.readFileSync(path.join(intakeDir(intel), f), 'utf8')) }); } catch { /* ilegible: no es una idea */ }
  }
  return out;
}
function listPending(intel = INTEL) { return readIntake(intel).filter((r) => !r.t_id); }

/** Puro: arma los argumentos de `ledger create` y valida lo que el modelo suele olvidar. */
function buildCreateArgs({ taskId, title, goal, repo, kind, criteria = [], state = 'queued', blockedBy = 'agent', next = '' }) {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(String(taskId || ''))) throw new Error(`taskId invalido ${JSON.stringify(taskId)}`);
  if (!String(goal || '').trim()) throw new Error('falta --goal: el goal se escribe en terminos ejecutables, no se copia el titulo');
  if (!String(repo || '').trim()) throw new Error('falta --repo: sin repo la tarjeta es inruteable');
  const crit = criteria.map((c) => String(c || '').trim()).filter(Boolean);
  if (crit.length < 2) throw new Error(`hacen falta >= 2 criterios verificables (recibi ${crit.length}); una idea sin criterios no se puede cerrar con evidencia`);
  const args = ['create', '--title', title, '--goal', goal, '--repo', repo, '--kind', kind || 'general', '--state', state,
    '--blocked-by', blockedBy, '--origin', `sp:${taskId}`, '--corr', `sp:${taskId}`, '--refs', `_intel/intake/${taskId}.json`];
  if (next) args.push('--next', next);
  for (const c of crit) args.push('--criterion', c);
  return args;
}

function createCard(opts, { intel = INTEL, ledger = LEDGER, run } = {}) {
  const pending = readIntake(intel).find((r) => r.taskId === opts.taskId);
  if (!pending) throw new Error(`no hay _intel/intake/${opts.taskId}.json: exportala primero con sp-bridge sync`);
  const title = opts.title || pending.title || `Idea ${opts.taskId}`;
  const args = buildCreateArgs({ ...opts, title });
  const exec = run || ((a) => spawnSync(process.execPath, [ledger, ...a], { encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel } }));
  const r = exec(args);
  if (r.status !== 0) throw new Error(`ledger create fallo: ${String(r.stderr || r.stdout).slice(0, 400)}`);
  const card = JSON.parse(r.stdout);
  const reused = card.origin_key === `sp:${opts.taskId}` && !!pending.t_id;
  const rec = { ...pending };
  delete rec.file;
  rec.t_id = card.id;
  rec.cardedAt = rec.cardedAt || new Date().toISOString();
  fs.writeFileSync(pending.file, JSON.stringify(rec, null, 2));
  return { card, taskId: opts.taskId, reused };
}

function parse(argv) {
  const pos = []; const opts = { criterion: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (k === 'list') { opts.list = true; continue; }
    const v = argv[i + 1]; i += 1;
    if (k === 'criterion') opts.criterion.push(v); else opts[k] = v;
  }
  return { pos, opts };
}
function main() {
  const { pos, opts } = parse(process.argv.slice(2));
  if (opts.list) { console.log(JSON.stringify(listPending().map(({ file, ...r }) => r), null, 2)); return 0; }
  if (pos[0] === 'create' && pos[1]) {
    const r = createCard({ taskId: pos[1], title: opts.title, goal: opts.goal, repo: opts.repo, kind: opts.kind, criteria: opts.criterion, state: opts.state, blockedBy: opts['blocked-by'], next: opts.next });
    console.log(JSON.stringify({ t_id: r.card.id, state: r.card.state, origin_key: r.card.origin_key, reused: r.reused }));
    return 0;
  }
  console.error('uso: intake-card.cjs --list | create <taskId> --repo <slug> --kind <kind> --goal "..." --criterion "..." --criterion "..." [--state] [--blocked-by] [--title] [--next]');
  return 2;
}

module.exports = { readIntake, listPending, buildCreateArgs, createCard, intakeDir };
if (require.main === module) { try { process.exit(main()); } catch (e) { console.error(`intake-card: ${e.message}`); process.exit(1); } }
