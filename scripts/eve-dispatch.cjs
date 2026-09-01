#!/usr/bin/env node
'use strict';
/**
 * eve-dispatch.cjs — imprime el payload EXACTO de `task_submit` (FinalOrchestra)
 * a partir de una tarjeta del ledger. NO habla HTTP: el MCP es el intake
 * gobernado (idempotencia, schema de origin, auth del worker), asi que este
 * script produce el JSON y el pane lo ejecuta con mcp__finalorchestra__task_submit.
 * Uso: node scripts/eve-dispatch.cjs T-NNNN --project-id <id> [--slug s]
 *      [--date yyyymmdd] [--client-kind CLAUDE_CODE] [--apply --job-id JOB]
 * `--apply` setea el corr, mueve la tarjeta a running por saltos LEGALES
 * (queued->ready->running) y toma la lease `eve:<jobId>` por 240 min.
 *
 * CONVENCION DE CORR: `<T-id>:<slug>:<yyyymmdd>`, seteada ANTES del submit. El
 * jobId no existe todavia en ese momento, y `origin.correlationId` es el UNICO
 * string que sobrevive el viaje de ida y vuelta: vuelve como `corr` del A2A y
 * es lo que le permite al linker mover la tarjeta. Ver docs/a2a-protocol.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { intelDir } = require('../src/a2a-intel.cjs');

/** El vocabulario de clientKind lo cierra el schema de task_submit, no nosotros. */
const CLIENT_KINDS = ['CODEX_APP', 'CODEX_CLI', 'CLAUDE_CODE', 'CLAUDE_DESKTOP', 'SHELL'];

/** Saltos LEGALES hasta running. `queued -> running` no existe en el FSM. */
const HOPS = {
  queued: ['ready', 'running'],
  ready: ['running'],
  review: ['running'],
  failed: ['ready', 'running'],
};

/** kebab de las tres primeras palabras del titulo, sin acentos ni puntuacion. */
function slugFrom(title) {
  const words = String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim().split(/\s+/).filter(Boolean).slice(0, 3);
  const slug = words.join('-').toLowerCase();
  return slug || 'task';
}

const todayUTC = (now = Date.now()) => new Date(now).toISOString().slice(0, 10).replace(/-/g, '');

const corrFor = (card, { slug, date } = {}) => `${card.id}:${slug || slugFrom(card.title)}:${date || todayUTC()}`;

/**
 * `mode` sale del CONTRATO, nunca de la intencion del que despacha: un kind sin
 * escritura declarada se despacha como INVESTIGATE aunque quien lo manda crea
 * que hace falta un cambio. Sin contrato legible, la autoridad MINIMA.
 */
function modeFor(card) {
  const m = String((card.contract && card.contract.mode) || '').trim();
  return m === 'scoped_write' ? 'CHANGE' : 'INVESTIGATE';
}

const gateOf = (card) => (card.gate || (card.contract && card.contract.gate) || null);

function buildPayload(card, { projectId, corr, clientKind = 'CLAUDE_CODE' } = {}) {
  const mode = modeFor(card);
  // El kind viaja DENTRO del objective como linea propia: es lo unico que Eve
  // puede leer para consultar el gate del graph (W0). Un kind que no viaja es
  // un despacho que pasa por la standing authorization sin gate.
  const objective = `${card.goal}\nkind=${card.kind}`;
  const acceptanceCriteria = Array.isArray(card.acceptance_criteria) ? card.acceptance_criteria : [];
  const allowed = (card.contract && Array.isArray(card.contract.allowed_paths))
    ? card.contract.allowed_paths : [];
  return {
    projectId,
    mode,
    objective,
    doneMeans: acceptanceCriteria,
    idempotencyKey: crypto.createHash('sha256').update(corr).digest('hex'),
    delegationBrief: {
      schemaVersion: '1',
      objective,
      verifiedContext: [],
      constraints: [...allowed, `gate=${gateOf(card) || 'null'}`],
      acceptanceCriteria,
      authority: { mode, maximumOutput: mode === 'CHANGE' ? 'DRAFT_PR' : 'REPORT' },
    },
    origin: {
      schemaVersion: '1',
      clientKind,
      originProject: 'wezbridge',
      correlationId: corr,
      returnPreference: 'WEZBRIDGE',
      // SIN paneHint a proposito: el result cae en `to_project`, sobrevive la
      // renumeracion de panes y aterriza en la cola durable.
    },
  };
}

function defaultLedgerRunner(args) {
  const ledger = path.join(intelDir(), '..', '_docs-curation', 'ledger.cjs');
  return execFileSync(process.execPath, [ledger, ...args], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
}

function readCard(id, dir = intelDir()) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'tasks', `${id}.json`), 'utf8'));
}

/**
 * Setea el corr, mueve la tarjeta a running y toma la lease de Eve.
 * Refusa (tira) sobre lo que no es suyo decidir: una tarjeta ya running (dos
 * executors sobre una tarjeta) y una gateada (des-gatear es del operador).
 */
function apply(card, { corr, jobId, runLedger = defaultLedgerRunner, minutes = 240 } = {}) {
  if (!jobId) throw new Error('--apply requires --job-id <JOB>: sin el, la lease queda ilegible (owner "eve:" a secas) y lease-reconcile no puede verificar al dueno');
  if (card.state === 'running') throw new Error(`${card.id} is already running (lease: ${card.lease ? card.lease.owner : 'none'}) — release it or dispatch to the current owner`);
  if (card.state === 'blocked') throw new Error(`${card.id} is blocked: gated card, decide first — ${card.blocker || 'sin blocker declarado'}`);
  const hops = HOPS[card.state];
  if (!hops) throw new Error(`${card.id} is in state "${card.state}" — no legal path to running from there`);
  runLedger(['update', card.id, '--corr', corr]);
  for (const state of hops) runLedger(['update', card.id, '--state', state]);
  runLedger(['lease', card.id, '--owner', `eve:${jobId}`, '--minutes', String(minutes)]);
  return { hops, lease: `eve:${jobId}`, minutes };
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const name = a.slice(2);
    if (name === 'apply') { opts.apply = true; continue; }
    opts[name] = argv[i + 1];
    i += 1;
  }
  return opts;
}

function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseArgs(argv);
  const id = opts._[0];
  if (!id || !/^T-\d{4}$/.test(id)) throw new Error('usage: eve-dispatch.cjs T-NNNN --project-id <id> [--slug s] [--date yyyymmdd] [--apply --job-id JOB]');
  if (!opts['project-id']) throw new Error('--project-id is required: FinalOrchestra routes by project, and guessing it dispatches into someone else\'s repo');
  const clientKind = opts['client-kind'] || 'CLAUDE_CODE';
  if (!CLIENT_KINDS.includes(clientKind)) throw new Error(`--client-kind must be one of: ${CLIENT_KINDS.join(', ')}`);
  const card = (deps.readCard || readCard)(id);
  const corr = corrFor(card, { slug: opts.slug, date: opts.date });
  const payload = buildPayload(card, { projectId: opts['project-id'], corr, clientKind });
  const applied = opts.apply
    ? apply(card, { corr, jobId: opts['job-id'], runLedger: deps.runLedger })
    : null;
  return { payload, corr, card: id, applied };
}

module.exports = { main, buildPayload, apply, slugFrom, corrFor, modeFor, todayUTC, HOPS, CLIENT_KINDS };

if (require.main === module) {
  try {
    const out = main();
    // stdout es el payload PELADO y nada mas: se copia y pega en
    // mcp__finalorchestra__task_submit sin editar. El schema del tool declara
    // additionalProperties:false, asi que un envoltorio con metadatos obligaria
    // a desarmar la salida a mano — que es justo el paso donde se pierde un
    // campo. La tarjeta, los saltos y la lease van por stderr.
    process.stdout.write(JSON.stringify(out.payload, null, 2) + '\n');
    const applied = out.applied
      ? ` APPLIED hops=${out.applied.hops.join('->')} lease=${out.applied.lease} minutes=${out.applied.minutes}`
      : ' (dry-run: la tarjeta no se toco; agrega --apply --job-id <JOB> despues del submit)';
    process.stderr.write(`eve-dispatch: ${out.card} corr=${out.corr} tool=mcp__finalorchestra__task_submit${applied}\n`);
  } catch (e) {
    process.stderr.write(`eve-dispatch error: ${e.message}\n`);
    process.exit(1);
  }
}
