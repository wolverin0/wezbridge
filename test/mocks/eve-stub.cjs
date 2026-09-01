'use strict';
/**
 * eve-stub.cjs — Eve/FinalOrchestra de mentira para el drill (T31, check 3 y 6).
 * Implementa EXACTAMENTE el contrato que le pedimos al pane finalorchestra en T-0308:
 * submit() lee <reposRoot>/<repo>/.agent-workflow/graph.json y el gate del kind manda
 * sobre la standing policy; complete() arma el sobre de result (<=1200 chars, misma forma
 * que result-delivery.ts de FinalOrchestra) y lo entrega por el sendResult inyectado.
 * Determinista, reloj inyectado, sin red. Es la spec de aceptacion externa de W0.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY = 1200;
const CORR_RE = /^T-\d{4}:/;

function readGate(reposRoot, repo, kind) {
  const file = path.join(reposRoot, repo, '.agent-workflow', 'graph.json');
  let graph;
  try { graph = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { gate: 'operator', reason: `graph.json ilegible o ausente (${e.code || e.message}) — fail-closed` };
  }
  const kinds = (graph && graph.kinds) || {};
  if (!Object.prototype.hasOwnProperty.call(kinds, kind)) {
    return { gate: 'operator', reason: `unknown kind "${kind}" — no esta en graph.json kinds` };
  }
  const k = kinds[kind] || {};
  const gate = 'gate' in k ? k.gate : ((graph.defaults && graph.defaults.gate) || null);
  return { gate: gate || null, reason: `graph.json kinds.${kind}.gate=${gate || 'null'}` };
}

function validateOrigin(payload) {
  const o = payload && payload.origin;
  if (!o) return 'origin ausente';
  if (typeof o.correlationId !== 'string' || !CORR_RE.test(o.correlationId)) return 'origin.correlationId debe empezar con T-NNNN:';
  if (o.originProject !== 'wezbridge') return 'origin.originProject debe ser wezbridge';
  if (o.returnPreference !== 'WEZBRIDGE') return 'origin.returnPreference debe ser WEZBRIDGE';
  if (!['INVESTIGATE', 'CHANGE'].includes(payload.mode)) return 'mode invalido';
  if (!Array.isArray(payload.doneMeans)) return 'doneMeans debe ser array';
  return null;
}

function buildEnvelope(job, { verdict, summary, criteria, filesChanged, prUrl }) {
  const lines = [
    `FinalOrchestra ${job.jobId}: ${verdict}`,
    summary || `${job.kind} sobre ${job.repo}`,
    'criteria:',
    ...criteria.map((c, i) => `- ${c.name}: ${c.pass ? 'pass' : 'fail'} — ${c.evidence || `E=${job.jobId}-${i + 1}`}`),
    `evidence: E=${job.jobId}-1`,
    `files_changed: ${(filesChanged || []).join(', ') || '(none)'}`,
    `next_action: factory result ${job.jobId} --detail full`,
  ];
  if (prUrl) lines.push(`pr: ${prUrl}`);
  let body = lines.join('\n');
  if (body.length > MAX_BODY) {
    // recorta el summary primero, como hace result-delivery.ts
    const over = body.length - MAX_BODY;
    lines[1] = lines[1].slice(0, Math.max(0, lines[1].length - over - 1)) + '…';
    body = lines.join('\n');
  }
  return body.slice(0, MAX_BODY);
}

function createEveStub({ reposRoot, now = () => Date.now(), sendResult, standingPolicy = true, jobPrefix = 'JOB-drill' } = {}) {
  if (!reposRoot) throw new Error('eve-stub: reposRoot requerido');
  const jobs = new Map();
  let seq = 0;

  function submit(payload) {
    const bad = validateOrigin(payload);
    if (bad) return { error: bad, status: 'REJECTED' };
    const { gate, reason } = readGate(reposRoot, payload.repo, payload.kind);
    const jobId = `${jobPrefix}-${++seq}`;
    // la standing policy NUNCA pisa un gate operator; solo gate null la alcanza
    const status = gate === 'operator' ? 'AWAITING_APPROVAL' : (standingPolicy ? 'QUEUED' : 'AWAITING_APPROVAL');
    const job = {
      jobId, status, gate, reason, kind: payload.kind, repo: payload.repo, mode: payload.mode,
      origin: payload.origin, submitted_at: new Date(now()).toISOString(), events: [{ at: now(), status }],
    };
    if (status === 'QUEUED') { job.status = 'RUNNING'; job.events.push({ at: now(), status: 'RUNNING' }); }
    jobs.set(jobId, job);
    return { jobId, status, gate, reason };
  }

  function approve(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`eve-stub: job desconocido ${jobId}`);
    if (job.status !== 'AWAITING_APPROVAL') return { jobId, status: job.status, noop: true };
    job.status = 'RUNNING';
    job.events.push({ at: now(), status: 'RUNNING', by: 'approve' });
    return { jobId, status: 'RUNNING' };
  }

  async function complete(jobId, { verdict = 'COMPLETED', summary, criteria = [], filesChanged = [], prUrl = null } = {}) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`eve-stub: job desconocido ${jobId}`);
    if (job.status !== 'RUNNING') throw new Error(`eve-stub: ${jobId} no esta RUNNING (${job.status})`);
    const body = buildEnvelope(job, { verdict, summary, criteria, filesChanged, prUrl });
    job.status = verdict;
    job.result = { verdict, body, criteria, filesChanged, prUrl, completed_at: new Date(now()).toISOString() };
    if (typeof sendResult === 'function') {
      job.delivery = await sendResult({
        to_project: job.origin.originProject,
        from_pane: job.origin.paneHint || null,
        corr: job.origin.correlationId,
        type: 'result',
        body,
      });
    }
    return { jobId, status: job.status, body, delivery: job.delivery || null };
  }

  const get = (jobId) => jobs.get(jobId) || null;
  const isAlive = (jobId) => { const j = jobs.get(jobId); return !!j && ['AWAITING_APPROVAL', 'QUEUED', 'RUNNING'].includes(j.status); };

  return { submit, approve, complete, get, isAlive, _jobs: jobs, readGate: (repo, kind) => readGate(reposRoot, repo, kind) };
}

module.exports = { createEveStub, buildEnvelope, readGate, validateOrigin, MAX_BODY };
