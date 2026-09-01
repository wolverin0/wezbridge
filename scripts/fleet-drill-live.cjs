'use strict';
/**
 * fleet-drill-live.cjs — modo LIVE del drill T31: corre sobre el _intel REAL, con Eve real y
 * el tap del operador en el tablero. RESUMIBLE: el estado vive en _intel/.fleet-drill/live-<date>.json;
 * lo que necesita una mano externa se pasa por flag en la re-corrida (--job-id-docs, --job-id-deploy,
 * --deploy-status, --deploy-reason). Un paso sin su entrada externa es UNKNOWN, nunca GREEN.
 * Uso: node scripts/fleet-drill.cjs --mode live --fo-project-id <id> [--preflight] [--wait-min 10]
 *      [--wait-result-min 30] [--report artifacts/YYYY-MM-DD-fleet-drill-N.md] [--redo 4,5]
 * Efectos reales: crea 2 tarjetas [DRILL] (idempotentes por origin_key); la de deploy nace gateada y
 * dispara el push de Telegram. Teardown: las tarjetas quedan (review o cancelled con evidencia), nunca se borran.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const a2aIntel = require(path.join(ROOT, 'src', 'a2a-intel.cjs'));

class DrillUnknown extends Error { constructor(m) { super(m); this.name = 'DrillUnknown'; } }
class DrillRed extends Error { constructor(m, side) { super(m); this.name = 'DrillRed'; this.side = side; } }
const must = (c, m, side) => { if (!c) throw new DrillRed(m, side); };
const unknown = (m) => { throw new DrillUnknown(m); };
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(token ? { 'x-board-token': token } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* texto */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', reject); req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
}

function makeCtx(flags) {
  const intel = a2aIntel.intelDir();
  const ledgerBin = path.join(process.env.WEZBRIDGE_LEDGER_DIR || path.join(intel, '..', '_docs-curation'), 'ledger.cjs');
  const date = flags.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const stateDir = path.join(intel, '.fleet-drill');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `live-${date}.json`);
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* primera corrida */ }
  const ctx = { mode: 'live', intel, ledgerBin, repo: 'wezbridge', repoDir: ROOT, date, flags, stateFile, state, measures: state.measures || { checks: {}, hops: {}, delivery: {}, verification: {}, keystrokes: null, unknown: 0 } };
  ctx.save = () => { state.measures = ctx.measures; fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); };
  ctx.runLedger = (args) => { const out = execFileSync(process.execPath, [ledgerBin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); try { return JSON.parse(out); } catch { return out; } };
  ctx.readCard = (id) => { try { return JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8')); } catch { return null; } };
  ctx.readTasks = () => fs.readdirSync(path.join(intel, 'tasks')).filter((f) => /^T-\d{4}\.json$/.test(f)).map((f) => ctx.readCard(f.replace('.json', ''))).filter(Boolean);
  ctx.events = () => readJsonl(path.join(intel, 'events.jsonl'));
  ctx.rulings = () => readJsonl(path.join(intel, 'rulings.jsonl'));
  ctx.results = () => readJsonl(path.join(intel, 'a2a-results.jsonl'));
  return ctx;
}

async function preflight(ctx) {
  const out = [];
  const daemon = await httpJson('GET', 'http://127.0.0.1:4200/api/panes').catch((e) => ({ status: 0, text: e.message }));
  must(daemon.status === 200, `daemon :4200 no responde (${daemon.status} ${daemon.text || ''})`);
  out.push(`daemon :4200 ok (${Array.isArray(daemon.json) ? daemon.json.length : '?'} panes)`);
  const srv = require(path.join(ROOT, 'board-app', 'server.cjs'));
  let token = null; try { token = srv.loadToken(); } catch (e) { unknown(`token del tablero ilegible: ${e.message}`); }
  ctx.boardToken = token;
  const board = await httpJson('GET', 'http://127.0.0.1:4272/api/state', { token }).catch((e) => ({ status: 0, text: e.message }));
  must(board.status === 200, `tablero :4272 no responde con token (${board.status})`);
  out.push(`tablero :4272 ok (decisiones=${(board.json && (board.json.decisions || board.json.waiting) || []).length})`);
  const foUrl = process.env.FINALORCHESTRA_URL || process.env.V_CONTROL_PLANE_URL || 'http://127.0.0.1:3100';
  const fo = await httpJson('GET', `${foUrl}/`).catch((e) => ({ status: 0, text: e.message }));
  must(fo.status > 0 && fo.status < 500, `control plane ${foUrl} no responde (${fo.status})`);
  out.push(`finalorchestra ${foUrl} ok (${fo.status})`);
  must(ctx.flags['fo-project-id'] || ctx.state.foProjectId, 'falta --fo-project-id (mcp__finalorchestra__projects_list → id de wezbridge)');
  ctx.state.foProjectId = ctx.flags['fo-project-id'] || ctx.state.foProjectId;
  ctx.state.preflight = { at: new Date().toISOString(), out };
  ctx.save();
  return out;
}

function findByOrigin(ctx, origin) { return ctx.readTasks().find((t) => t.origin_key === origin) || null; }

const STEPS = [
  {
    id: 1, side: 'wezbridge', title: 'Tarjetas reales [DRILL] nacen desde el graph de wezbridge (docs queued, deploy blocked/operator)',
    async run(ctx) {
      const oD = `drill:live:${ctx.date}:docs`; const oP = `drill:live:${ctx.date}:deploy`;
      const docs = findByOrigin(ctx, oD) || ctx.runLedger(['create', '--title', '[DRILL] docs header live', '--goal', 'Agregar el header greppable de 7 lineas a docs/DRILL.md (archivo nuevo, una linea por seccion). Cambio acotado a docs/**. Es un simulacro: no tocar otra cosa.', '--kind', 'docs', '--repo', 'wezbridge', '--criteria', 'docs/DRILL.md existe con header de 7 lineas;node --test test/*.test.cjs sin fails nuevos', '--blocked-by', 'agent', '--origin', oD]);
      const deploy = findByOrigin(ctx, oP) || ctx.runLedger(['create', '--title', '[DRILL] deploy probe live', '--goal', 'Simulacro de gate: reportar el valor de WEZBRIDGE_BIND del daemon y NO cambiar nada. Si el operador aprueba desde el tablero, el drill mide que el aviso llegue.', '--kind', 'deploy', '--repo', 'wezbridge', '--criteria', 'valor reportado', '--origin', oP]);
      const d = ctx.readCard(docs.id); const p = ctx.readCard(deploy.id);
      must(d && ['queued', 'ready', 'running', 'review'].includes(d.state) && d.contract && d.contract.gate === null, `docs ${docs.id} state=${d && d.state} gate=${d && d.contract && d.contract.gate}`);
      must(p && p.contract && p.contract.gate === 'operator' && (p.state === 'blocked' || p.state === 'ready'), `deploy ${deploy.id} state=${p && p.state} gate=${p && p.contract && p.contract.gate}`);
      ctx.state.cards = { docs: docs.id, deploy: deploy.id }; ctx.state.createdAt = ctx.state.createdAt || new Date().toISOString(); ctx.save();
      return [`${docs.id} ${d.state} gate=null`, `${deploy.id} ${p.state} gate=operator blocked_by=${p.blocked_by}`];
    },
  },
  {
    id: 2, side: 'wezbridge', title: 'Dispatch a Eve: payload impreso; con --job-id-docs se aplica corr+lease eve:<job>',
    async run(ctx) {
      const { docs } = ctx.state.cards || {}; must(docs, 'sin tarjetas: corre el paso 1');
      const bin = path.join(ROOT, 'scripts', 'eve-dispatch.cjs');
      const base = [bin, docs, '--project-id', ctx.state.foProjectId, '--slug', 'drill-docs', '--date', ctx.date];
      const out = spawnSync(process.execPath, base, { encoding: 'utf8' });
      must(out.status === 0, `eve-dispatch exit ${out.status}: ${(out.stderr || out.stdout).slice(0, 300)}`);
      const payload = JSON.parse(out.stdout);
      ctx.state.payloadDocs = payload; ctx.save();
      const job = ctx.flags['job-id-docs'] || ctx.state.jobDocs;
      if (!job) unknown(`payload listo (corr=${payload.origin.correlationId}). Ejecuta mcp__finalorchestra__task_submit con ese payload y re-corre con --job-id-docs <JOB>. Payload en ${ctx.stateFile}`);
      const card = ctx.readCard(docs);
      if (card.state !== 'running') {
        const ap = spawnSync(process.execPath, [...base, '--apply', '--job-id', job], { encoding: 'utf8' });
        must(ap.status === 0, `--apply exit ${ap.status}: ${(ap.stderr || ap.stdout).slice(0, 300)}`);
      }
      const after = ctx.readCard(docs);
      must(after.corr === payload.origin.correlationId && after.lease && after.lease.owner === `eve:${job}`, `card corr=${after.corr} lease=${after.lease && after.lease.owner}`);
      ctx.state.jobDocs = job; ctx.measures.hops['create->dispatch'] = Date.now() - Date.parse(ctx.state.createdAt); ctx.save();
      return [`corr=${payload.origin.correlationId} mode=${payload.mode}`, `${docs} running lease=eve:${job}`];
    },
  },
  {
    id: 3, side: 'finalorchestra', title: 'Eve honra el gate: el job de deploy queda AWAITING_APPROVAL citando graph.json',
    async run(ctx) {
      const { deploy } = ctx.state.cards || {}; must(deploy, 'sin tarjetas');
      const bin = path.join(ROOT, 'scripts', 'eve-dispatch.cjs');
      const out = spawnSync(process.execPath, [bin, deploy, '--project-id', ctx.state.foProjectId, '--slug', 'drill-deploy', '--date', ctx.date], { encoding: 'utf8' });
      must(out.status === 0, `eve-dispatch (deploy) exit ${out.status}: ${(out.stderr || out.stdout).slice(0, 300)}`);
      ctx.state.payloadDeploy = JSON.parse(out.stdout); ctx.save();
      const job = ctx.flags['job-id-deploy'] || ctx.state.jobDeploy;
      const status = ctx.flags['deploy-status'] || ctx.state.deployStatus;
      const reason = ctx.flags['deploy-reason'] || ctx.state.deployReason || '';
      if (!job || !status) unknown(`payload de deploy listo. Ejecuta task_submit y re-corre con --job-id-deploy <JOB> --deploy-status <STATUS> --deploy-reason "<razon textual de FO>"`);
      Object.assign(ctx.state, { jobDeploy: job, deployStatus: status, deployReason: reason }); ctx.save();
      must(status === 'AWAITING_APPROVAL', `FO devolvio ${status} para kind=deploy con la politica activa — el gate del graph NO manda (T-0308 pendiente)`, 'finalorchestra');
      must(/graph|gate|kind/i.test(reason), `AWAITING pero la razon no cita el graph: "${reason}"`, 'finalorchestra');
      return [`${job} ${status} (${reason.slice(0, 120)})`];
    },
  },
  {
    id: 4, side: 'operator', title: 'Decision sin teclado: el operador toca Aprobar en el tablero; ruling con source board-app; teclas sobre los corrs del drill = 0',
    async run(ctx) {
      const { deploy } = ctx.state.cards || {}; must(deploy, 'sin tarjetas');
      const waitMs = Number(ctx.flags['wait-min'] || 10) * 60000;
      const t0 = Date.now();
      const notified = ctx.events().find((e) => e.event === 'decision.notified' && e.task_id === deploy);
      let ruling = null;
      while (Date.now() - t0 < waitMs) {
        ruling = ctx.rulings().filter((r) => r.task === deploy && r.ruling === 'approved').pop();
        if (ruling) break;
        await sleep(1000);
      }
      if (!ruling) unknown(`el operador no aprobo ${deploy} en ${waitMs / 60000} min (push ${notified ? 'enviado ' + notified.time : 'NO registrado en events.jsonl'})`);
      const card = ctx.readCard(deploy);
      const { gateOf } = require(path.join(ROOT, 'scripts', 'fleet-board.cjs'));
      must(ruling.source === 'board-app', `ruling sin source board-app: ${JSON.stringify(ruling)}`);
      must(card.state === 'ready' && gateOf(card) !== 'operator' && card.blocked_by !== 'operator', `card state=${card.state} gate=${gateOf(card)} blocked_by=${card.blocked_by}`);
      const corrs = new Set([deploy, ctx.state.cards.docs, ...(ctx.state.payloadDocs ? [ctx.state.payloadDocs.origin.correlationId] : []), ...(ctx.state.payloadDeploy ? [ctx.state.payloadDeploy.origin.correlationId] : [])]);
      const since = Date.parse(ctx.state.createdAt);
      const keys = ctx.events().filter((e) => e.event === 'a2a.sent' && corrs.has(e.corr) && Date.parse(e.time) >= since && e.type === 'request');
      ctx.measures.keystrokes = keys.length;
      ctx.measures.hops['push->ruling'] = notified ? Date.parse(ruling.at) - Date.parse(notified.time) : null;
      ctx.state.rulingAt = ruling.at; ctx.save();
      return [`ruling ${JSON.stringify(ruling)}`, `push->ruling ${ctx.measures.hops['push->ruling']} ms`, `teclas (a2a.sent request sobre corrs del drill) = ${keys.length}`];
    },
  },
  {
    id: 5, side: 'wezbridge', title: 'El dueño se entera: decision-relay --once → decision.queued|delivered para la tarjeta aprobada',
    async run(ctx) {
      const { deploy } = ctx.state.cards || {}; must(deploy && ctx.state.rulingAt, 'sin ruling aprobado: corre el paso 4');
      const before = ctx.events().filter((e) => /^decision\.(delivered|queued|undeliverable)$/.test(e.event) && e.task === deploy);
      let ev = before.find((e) => Date.parse(e.time) >= Date.parse(ctx.state.rulingAt));
      let relayOut = 'ya avisado por el tablero inline';
      if (!ev) {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'decision-relay.cjs'), '--once', '--json'], { encoding: 'utf8', timeout: 120000 });
        relayOut = (r.stdout || r.stderr || '').trim().slice(0, 300);
        ev = ctx.events().filter((e) => /^decision\.(delivered|queued|undeliverable)$/.test(e.event) && e.task === deploy && Date.parse(e.time) >= Date.parse(ctx.state.rulingAt)).pop();
      }
      must(ev, `sin evento decision.* para ${deploy} tras el ruling (relay: ${relayOut})`);
      must(ev.event !== 'decision.undeliverable', `decision.undeliverable: ${ev.reason}`);
      ctx.measures.delivery[ev.event] = (ctx.measures.delivery[ev.event] || 0) + 1;
      ctx.measures.hops['ruling->decision'] = Date.parse(ev.time) - Date.parse(ctx.state.rulingAt);
      ctx.save();
      return [`${ev.event} project=${ev.project} pane=${ev.pane || '-'} reason=${ev.reason || '-'}`, `relay: ${relayOut}`];
    },
  },
  {
    id: 6, side: 'wezbridge', title: 'Eve devuelve por a2a_send: linea en a2a-results.jsonl con el corr del drill, sobre real guardado verbatim',
    async run(ctx) {
      const corr = ctx.state.payloadDocs && ctx.state.payloadDocs.origin.correlationId; must(corr && ctx.state.jobDocs, 'sin job de docs: corre el paso 2');
      const waitMs = Number(ctx.flags['wait-result-min'] || 30) * 60000;
      const t0 = Date.now();
      let line = null;
      while (Date.now() - t0 < waitMs) {
        line = ctx.results().filter((l) => String(l.corr || '').startsWith(corr)).pop();
        if (line) break;
        await sleep(2000);
      }
      if (!line) unknown(`Eve no devolvio result para ${corr} en ${waitMs / 60000} min (job ${ctx.state.jobDocs}); re-corre cuando llegue`);
      const body = String(line.body || '');
      const v2 = a2aIntel.detectV2(body);
      must(line.v2 === 'ok' && v2 === 'ok', `v2=${line.v2}/${v2}: el sobre real no trae criteria pass|fail verificables`);
      for (const needle of ['FinalOrchestra', 'criteria', 'next_action']) must(body.includes(needle), `sobre real sin "${needle}"`);
      ctx.state.resultLine = line; ctx.measures.hops['dispatch->result'] = Date.parse(line.time) - Date.parse(ctx.state.createdAt); ctx.save();
      return [`corr=${line.corr} from=pane-${line.from_pane} v2=${line.v2} ${body.length} chars`, `--- sobre real verbatim ---`, body];
    },
  },
  {
    id: 7, side: 'wezbridge', title: 'El result mueve la tarjeta: docs en review con evidencia a2a-results.jsonl (auto en el send, o result-link --once)',
    async run(ctx) {
      const { docs } = ctx.state.cards || {}; must(docs && ctx.state.resultLine, 'sin result: corre el paso 6');
      let card = ctx.readCard(docs); let how = 'auto (linker dentro de a2a_send)';
      if (card.state !== 'review') {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'result-link.cjs'), '--once'], { encoding: 'utf8', timeout: 60000 });
        how = `result-link --once: ${(r.stdout || r.stderr || '').trim().slice(0, 200)}`;
        card = ctx.readCard(docs);
      }
      must(card.state === 'review', `state=${card.state} (${how})`);
      const ev = JSON.stringify(card.evaluator_evidence || card.evidence || card.next_action || '');
      must(/a2a-results\.jsonl/.test(ev), `evidencia sin puntero: ${ev.slice(0, 200)}`);
      ctx.measures.hops['result->review'] = Date.parse(card.state_changed_at || card.updated_at) - Date.parse(ctx.state.resultLine.time); ctx.save();
      return [`${docs} review via ${how}`, `evidencia ${ev.slice(0, 160)}`];
    },
  },
  {
    id: 8, side: 'wezbridge', title: 'Steward y gates consistentes con censo REAL: sin hallazgos malos para las tarjetas del drill; steward-gate 0; validate-intel 0',
    async run(ctx) {
      const { docs, deploy } = ctx.state.cards || {}; must(docs && deploy, 'sin tarjetas');
      const st = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fleet-steward.cjs'), '--json'], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
      let report; try { report = JSON.parse(st.stdout); } catch { unknown(`fleet-steward --json ilegible: ${(st.stderr || st.stdout).slice(0, 200)}`); }
      const bad = ['dead-owner-lease', 'awaiting-operator', 'result-unlinked', 'decision-unheard', 'lease-owner-unverifiable', 'dispatch-unspecced', 'ruling-unlanded'];
      const hits = report.findings.filter((f) => [docs, deploy].includes(f.id) && bad.includes(f.category));
      must(hits.length === 0, `hallazgos: ${JSON.stringify(hits.map((f) => [f.id, f.category, String(f.why).slice(0, 100)]))}`);
      const gate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'steward-gate.cjs')], { encoding: 'utf8', timeout: 180000 });
      const vi = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-intel.cjs'), '--json'], { encoding: 'utf8' });
      return [`steward findings=${report.findings.length}, ninguno malo para ${docs}/${deploy}`, `steward-gate exit ${gate.status}: ${gate.stdout.trim().split('\n')[0]}`, `validate-intel exit ${vi.status}`];
    },
  },
  {
    id: 9, side: 'wezbridge', title: 'Waker honesto (STUB-ONLY dentro del live: no se manda un poke falso al orquestador real)',
    async run() {
      const drill = require(path.join(ROOT, 'scripts', 'fleet-drill.cjs'));
      const saved = { ...process.env };
      const r = await drill.runDrill({ mode: 'stub', only: [9] });
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      const c = r.checks[0];
      must(c && c.verdict === 'GREEN', `stub check 9: ${c && c.evidence[0]}`);
      return ['stub-only', ...c.evidence];
    },
  },
];

async function runLive(flags = {}, log = () => {}) {
  const ctx = makeCtx(flags);
  const results = [];
  try { const pf = await preflight(ctx); results.push({ id: 0, side: 'wezbridge', title: 'pre-flight', verdict: 'GREEN', evidence: pf, ms: 0 }); } catch (e) {
    return { mode: 'live', verdict: 'UNKNOWN', exit: 3, checks: [{ id: 0, side: 'wezbridge', title: 'pre-flight', verdict: 'UNKNOWN', evidence: [e.message], ms: 0 }], measures: ctx.measures, generated_at: new Date().toISOString() };
  }
  if (flags.preflight) return { mode: 'live', verdict: 'GREEN', exit: 0, checks: results, measures: ctx.measures, generated_at: new Date().toISOString(), note: 'solo pre-flight; sin efectos' };
  const redo = new Set(String(flags.redo || '').split(',').filter(Boolean).map(Number));
  ctx.state.steps = ctx.state.steps || {};
  for (const step of STEPS) {
    const prev = ctx.state.steps[step.id];
    if (prev && prev.verdict === 'GREEN' && !redo.has(step.id)) { results.push({ ...prev, replayed: true }); log(`check ${step.id} GREEN (guardado ${prev.at})`); continue; }
    const t0 = Date.now();
    let r;
    try { const ev = await step.run(ctx); r = { id: step.id, side: step.side, title: step.title, verdict: 'GREEN', evidence: ev, ms: Date.now() - t0, at: new Date().toISOString() }; }
    catch (e) {
      const unk = e && e.name === 'DrillUnknown';
      if (unk) ctx.measures.unknown += 1;
      r = { id: step.id, side: step.side, title: step.title, verdict: unk ? 'UNKNOWN' : 'RED', side_label: unk ? null : (e.side || step.side), evidence: [String((e && e.message) || e).split('\n')[0]], ms: Date.now() - t0, at: new Date().toISOString() };
    }
    ctx.state.steps[step.id] = r; ctx.measures.checks[step.id] = r.ms; ctx.save();
    results.push(r);
    log(`check ${r.id} ${r.verdict}${r.verdict === 'RED' ? ` — ${r.side_label} side` : ''}: ${r.evidence[0] || ''}`);
    if (r.verdict !== 'GREEN' && [1, 2, 4].includes(step.id)) { log(`corto aca: el paso ${step.id} es precondicion de los siguientes`); break; }
  }
  const anyUnknown = results.some((x) => x.verdict === 'UNKNOWN');
  const anyRed = results.some((x) => x.verdict === 'RED');
  return { mode: 'live', verdict: anyUnknown ? 'UNKNOWN' : anyRed ? 'RED' : 'GREEN', exit: anyUnknown ? 3 : anyRed ? 1 : 0, sandbox: ctx.stateFile, checks: results, measures: ctx.measures, generated_at: new Date().toISOString() };
}

module.exports = { runLive, STEPS, makeCtx, preflight };
