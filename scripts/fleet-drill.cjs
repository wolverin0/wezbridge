#!/usr/bin/env node
'use strict';
/**
 * fleet-drill.cjs — el drill e2e del loop wezbridge <-> Eve <-> graph (T31).
 * Nueve checks, cada uno un veredicto GREEN | RED — <lado> | UNKNOWN, sobre un _intel
 * DESCARTABLE (modo stub) con la copia REAL de ledger.cjs y kinds.json. Exit 0/1/3 como
 * steward-gate y waker-gate. Modo live corre sobre el _intel real y pide al operador el
 * tap en el tablero. Uso: node scripts/fleet-drill.cjs [--mode stub|live] [--keep]
 * [--report <path>] [--json] [--only <id,id>]. Cada check siembra su propia precondicion:
 * el reporter muestra nueve filas independientes, no una cascada. Lee el plan T31 antes de tocarlo.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp-server.cjs');
const WEZTERM_MOCK = path.join(ROOT, 'test', 'mocks', 'wezterm-mock.cjs');

class DrillUnknown extends Error { constructor(msg) { super(msg); this.name = 'DrillUnknown'; } }
class DrillRed extends Error { constructor(msg, side) { super(msg); this.name = 'DrillRed'; this.side = side; } }

function must(cond, msg) { if (!cond) throw new DrillRed(msg); }
function unknown(msg) { throw new DrillUnknown(msg); }
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function readJsonl(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function tryRequire(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(rel.split('/').pop())) return null;
    throw e;
  }
}

function findCompanion(name) {
  const root = process.env.WEZBRIDGE_COMPANIONS_DIR || path.join(ROOT, '..');
  const p = path.join(root, name);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------
function buildSandbox({ keep = false, log = () => {} } = {}) {
  const ledgerSrc = findCompanion(path.join('_docs-curation', 'ledger.cjs'));
  const kindsSrc = findCompanion(path.join('_intel', 'kinds.json'));
  if (!ledgerSrc || !kindsSrc) unknown(`companions ausentes: ${!ledgerSrc ? '_docs-curation/ledger.cjs ' : ''}${!kindsSrc ? '_intel/kinds.json' : ''}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-drill-'));
  const intel = path.join(tmp, '_intel');
  const ledgerDir = path.join(tmp, '_docs-curation');
  const repoDir = path.join(tmp, 'drillrepo');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.agent-workflow'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
  fs.copyFileSync(kindsSrc, path.join(intel, 'kinds.json'));
  fs.writeFileSync(path.join(intel, 'repos.json'), JSON.stringify({ version: 1, base: tmp, repos: { drillrepo: { path: 'drillrepo', status: 'active' } } }, null, 2));
  fs.writeFileSync(path.join(intel, 'rulings.jsonl'), '');
  fs.writeFileSync(path.join(intel, 'pane-events.jsonl'), '');
  fs.copyFileSync(ledgerSrc, path.join(ledgerDir, 'ledger.cjs'));
  fs.writeFileSync(path.join(ledgerDir, 'sweeper-config.json'), JSON.stringify({ root: tmp, repos: [{ name: 'drillrepo', path: 'drillrepo' }] }));
  fs.writeFileSync(path.join(repoDir, '.agent-workflow', 'graph.json'), JSON.stringify({
    version: 1, repo: 'drillrepo',
    // Mismo esquema que los 8 graphs reales: por kind mode/gate/allowed_paths/evidence_required/_note.
    _why: 'sandbox del drill T31',
    defaults: { mode: 'scoped_write', gate: null, evidence_required: ['full suite green with counts stated (node --test test/*.test.cjs)'] },
    kinds: {
      docs: { mode: 'scoped_write', gate: null, allowed_paths: ['docs/**', '*.md'], evidence_required: ['header present in the first 7 lines'] },
      deploy: { mode: 'none', gate: 'operator', _note: 'nace bloqueada: el graph decide, no el llamador' },
    },
  }, null, 2));
  fs.writeFileSync(path.join(repoDir, 'monitoring.md'), '---\nproject: drillrepo\n---\n# drillrepo\n\n| signal | action_level |\n|---|---|\n| tests | fix_and_pr |\n');
  fs.writeFileSync(path.join(repoDir, 'docs', 'README.md'), '# drillrepo\n');
  const env = {
    ...process.env,
    WEZBRIDGE_INTEL_DIR: intel,
    WEZBRIDGE_LEDGER_DIR: ledgerDir,
    WEZBRIDGE_WEZTERM_BIN: WEZTERM_MOCK,
    WEZBRIDGE_BOARD_URL: 'http://127.0.0.1:0/',
    WEZBRIDGE_ROOT: ROOT,
  };
  // Las constantes INTEL de require-time (board, fleet-board, board-fresh-gate,
  // steward-gate, ledger) leen el env del PROCESO: se fija antes del primer require.
  Object.assign(process.env, { WEZBRIDGE_INTEL_DIR: intel, WEZBRIDGE_LEDGER_DIR: ledgerDir, WEZBRIDGE_WEZTERM_BIN: WEZTERM_MOCK, WEZBRIDGE_ROOT: ROOT });
  const ctx = {
    mode: 'stub', tmp, intel, ledgerDir, ledgerBin: path.join(ledgerDir, 'ledger.cjs'), repoDir, repo: 'drillrepo', env, keep, log,
    cards: {}, measures: { checks: {}, hops: {}, delivery: {}, verification: {}, unknown: 0 }, stub: null,
  };
  ctx.runLedger = (args) => {
    const out = execFileSync(process.execPath, [ctx.ledgerBin, ...args], { env: ctx.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try { return JSON.parse(out); } catch { return out; }
  };
  ctx.readCard = (id) => readJson(path.join(intel, 'tasks', `${id}.json`), null);
  ctx.readTasks = () => fs.readdirSync(path.join(intel, 'tasks')).filter((f) => /^T-\d{4}\.json$/.test(f)).map((f) => readJson(path.join(intel, 'tasks', f), null)).filter(Boolean);
  ctx.writeCard = (card) => fs.writeFileSync(path.join(intel, 'tasks', `${card.id}.json`), JSON.stringify(card, null, 2));
  ctx.events = () => readJsonl(path.join(intel, 'events.jsonl'));
  ctx.rulings = () => readJsonl(path.join(intel, 'rulings.jsonl'));
  ctx.results = () => readJsonl(path.join(intel, 'a2a-results.jsonl'));
  return ctx;
}

function teardown(ctx) {
  if (!ctx || ctx.keep || ctx.mode === 'live') return;
  try { fs.rmSync(ctx.tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// preconditions (idempotentes: cada check siembra lo que necesita)
// ---------------------------------------------------------------------------
function ensureCards(ctx) {
  if (ctx.cards.docs && ctx.cards.deploy) return ctx.cards;
  const found = ctx.readTasks();
  const byOrigin = (o) => found.find((t) => t.origin_key === o);
  const docs = byOrigin('drill:docs') || ctx.runLedger(['create', '--title', '[DRILL] docs header', '--goal', 'Agregar el header de 7 lineas a docs/README.md', '--kind', 'docs', '--repo', ctx.repo, '--criteria', 'header present;tests pass', '--blocked-by', 'agent', '--origin', 'drill:docs']);
  const deploy = byOrigin('drill:deploy') || ctx.runLedger(['create', '--title', '[DRILL] deploy probe', '--goal', 'Reportar WEZBRIDGE_BIND; no cambiar nada', '--kind', 'deploy', '--repo', ctx.repo, '--criteria', 'value reported', '--origin', 'drill:deploy']);
  must(docs && docs.id, `ledger create docs no devolvio id: ${JSON.stringify(docs).slice(0, 200)}`);
  must(deploy && deploy.id, `ledger create deploy no devolvio id: ${JSON.stringify(deploy).slice(0, 200)}`);
  ctx.cards = { docs: docs.id, deploy: deploy.id };
  return ctx.cards;
}

function ensureStub(ctx) {
  if (ctx.stub) return ctx.stub;
  const { createEveStub } = require(path.join(ROOT, 'test', 'mocks', 'eve-stub.cjs'));
  ctx.stub = createEveStub({ reposRoot: ctx.tmp, now: () => Date.now(), sendResult: ctx.sendResult || null, standingPolicy: true });
  return ctx.stub;
}

/** Tarjeta docs en running con corr y lease de Eve, sembrada a mano (no es lo que se prueba). */
function ensureDocsRunning(ctx, jobId = 'JOB-drill-seed') {
  const { docs } = ensureCards(ctx);
  const card = ctx.readCard(docs);
  if (card.state === 'running' && card.corr && card.lease && card.lease.owner) return card;
  const corr = `${docs}:docs-header:20260901`;
  if (card.state === 'queued') ctx.runLedger(['update', docs, '--state', 'ready', '--note', 'drill seed']);
  if (ctx.readCard(docs).state !== 'running') ctx.runLedger(['update', docs, '--state', 'running', '--corr', corr, '--note', 'drill seed']);
  ctx.runLedger(['lease', docs, '--owner', `eve:${jobId}`, '--minutes', '240']);
  return ctx.readCard(docs);
}

/**
 * Tarjeta NUEVA en running con corr y lease de Eve, una por check: el check 6 la
 * promueve a review (el linker corre dentro de a2a_send), asi que reusar la de
 * docs entre checks arrastra estado y una lease viva con otro owner.
 */
function seedRunningCard(ctx, label, jobId) {
  const c = ctx.runLedger(['create', '--title', `[DRILL] ${label}`, '--goal', `drill ${label}`, '--kind', 'docs', '--repo', ctx.repo, '--criteria', 'header present;tests pass', '--blocked-by', 'agent', '--origin', `drill:${label}:${Date.now()}`]);
  must(c && c.id, `ledger create ${label} no devolvio id`);
  const corr = `${c.id}:${label}:20260901`;
  ctx.runLedger(['update', c.id, '--state', 'ready', '--note', 'drill seed']);
  ctx.runLedger(['update', c.id, '--state', 'running', '--corr', corr, '--note', 'drill seed']);
  ctx.runLedger(['lease', c.id, '--owner', `eve:${jobId}`, '--minutes', '240']);
  return ctx.readCard(c.id);
}

/** Tarjeta deploy aprobada a mano (ready, sin gate) — para checks posteriores al 4. */
function ensureDeployApproved(ctx) {
  const { deploy } = ensureCards(ctx);
  const card = ctx.readCard(deploy);
  if (card.state === 'ready') return card;
  const now = new Date().toISOString();
  const next = { ...card, state: 'ready', blocked_by: 'agent', gate: null, contract: { ...(card.contract || {}), gate: null }, updated_at: now, state_changed_at: now };
  ctx.writeCard(next);
  return next;
}

// ---------------------------------------------------------------------------
// helpers de transporte
// ---------------------------------------------------------------------------
function callTool(ctx, name, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_ENTRY], { cwd: ROOT, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new DrillUnknown(`mcp subprocess >${timeoutMs}ms; stderr=${stderr.slice(0, 300)}`)); }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      child.stdin.end(); child.kill('SIGTERM');
      try { resolve(JSON.parse(stdout.slice(0, nl).trim())); } catch (err) { reject(new DrillUnknown(`mcp invalid JSON: ${err.message}`)); }
    });
    child.on('error', (e) => reject(new DrillUnknown(`mcp spawn: ${e.message}`)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

function postJson(base, token, route, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, base);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': token, 'content-length': Buffer.byteLength(data) } }, (res) => {
      let txt = ''; res.on('data', (c) => { txt += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(txt) }); } catch { resolve({ status: res.statusCode, text: txt }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function getJson(base, token, route) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, base);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'x-board-token': token } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function withBoard(ctx, fn) {
  const srv = require(path.join(ROOT, 'board-app', 'server.cjs'));
  must(typeof srv.createServer === 'function', 'board-app/server.cjs no exporta createServer');
  const token = 'drill-token-' + sha1(ctx.tmp).slice(0, 8);
  const server = srv.createServer(token, { censusCache: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  try { return await fn({ base, token, srv }); } finally { await new Promise((r) => server.close(r)); }
}

function paneWithComposer(composerLine, project, paneId = 0) {
  const BORDE = '─'.repeat(70);
  return { paneId, project, title: 'drill', status: 'idle', lastLines: ['  ● algo que el pane hizo antes', BORDE, composerLine, BORDE, '   Model: Opus 5  Thinking: high', '   Ctx Used: 21.0%  Context: [███░░░░░] 208k/1.0M (21%)'].join('\n') };
}

const CRITERIA_OK = (job) => [
  { name: 'header present', pass: true, evidence: `docs/README.md:1-7 (E=${job}-1)` },
  { name: 'tests pass', pass: true, evidence: `node --test 12/12 (E=${job}-2)` },
];

const BAD_CATEGORIES = ['dead-owner-lease', 'awaiting-operator', 'result-unlinked', 'decision-unheard', 'lease-owner-unverifiable', 'dispatch-unspecced', 'ruling-unlanded'];

// ---------------------------------------------------------------------------
// los nueve checks
// ---------------------------------------------------------------------------
const CHECKS = [
  {
    id: 1, side: 'wezbridge', title: 'Nacimiento desde el graph: docs queued/gate null; deploy blocked/blocked_by operator',
    async run(ctx) {
      const { docs, deploy } = ensureCards(ctx);
      const d = ctx.readCard(docs); const p = ctx.readCard(deploy);
      must(d.state === 'queued', `docs state=${d.state}, esperado queued`);
      must(d.contract && d.contract.gate === null, `docs contract.gate=${JSON.stringify(d.contract && d.contract.gate)}, esperado null`);
      must(Array.isArray(d.contract.allowed_paths) && d.contract.allowed_paths.includes('docs/**'), 'docs allowed_paths no copiados del graph');
      must(p.state === 'blocked', `deploy state=${p.state}, esperado blocked`);
      must(p.blocked_by === 'operator', `deploy blocked_by=${p.blocked_by}, esperado operator`);
      must(p.contract && p.contract.gate === 'operator', 'deploy contract.gate != operator');
      must(/operator gate/i.test(String(p.blocker || '')) && /deploy/.test(String(p.blocker || '')), `deploy blocker no nombra el graph: ${p.blocker}`);
      const created = ctx.events().filter((e) => e.event === 'task.created');
      must(created.length >= 2, `events.jsonl task.created=${created.length}, esperado >=2`);
      return [`${docs} queued gate=null paths=${d.contract.allowed_paths.join(',')}`, `${deploy} blocked blocked_by=operator blocker="${String(p.blocker).slice(0, 80)}"`];
    },
  },
  {
    id: 2, side: 'wezbridge', title: 'Dispatch a Eve: payload con corr T-NNNN:, origin, doneMeans; tarjeta running + corr + lease eve:<job>',
    async run(ctx) {
      const { docs } = ensureCards(ctx);
      const bin = path.join(ROOT, 'scripts', 'eve-dispatch.cjs');
      must(fs.existsSync(bin), 'scripts/eve-dispatch.cjs ausente (W2)');
      const out = spawnSync(process.execPath, [bin, docs, '--project-id', 'drillrepo', '--slug', 'docs-header', '--date', '20260901'], { env: ctx.env, encoding: 'utf8' });
      must(out.status === 0, `eve-dispatch exit ${out.status}: ${(out.stderr || out.stdout).slice(0, 300)}`);
      let payload; try { payload = JSON.parse(out.stdout); } catch { must(false, `eve-dispatch no imprimio JSON: ${out.stdout.slice(0, 200)}`); }
      const o = payload.origin || {};
      must(/^T-\d{4}:/.test(String(o.correlationId)), `correlationId=${o.correlationId}`);
      must(o.originProject === 'wezbridge', `originProject=${o.originProject}`);
      must(o.returnPreference === 'WEZBRIDGE', `returnPreference=${o.returnPreference}`);
      must(payload.mode === 'CHANGE', `mode=${payload.mode} (docs es scoped_write => CHANGE)`);
      must(Array.isArray(payload.doneMeans) && payload.doneMeans.length === 2, `doneMeans=${JSON.stringify(payload.doneMeans)}`);
      must(/(^|\n)kind=docs(\n|$)/.test(String(payload.objective)), 'objective sin linea kind=docs');
      const stub = ensureStub(ctx);
      const sub = stub.submit({ ...payload, repo: ctx.repo, kind: 'docs' });
      must(!sub.error, `stub rechazo el payload: ${sub.error}`);
      ctx.jobs = { ...(ctx.jobs || {}), docs: sub.jobId };
      const ap = spawnSync(process.execPath, [bin, docs, '--project-id', 'drillrepo', '--slug', 'docs-header', '--date', '20260901', '--apply', '--job-id', sub.jobId], { env: ctx.env, encoding: 'utf8' });
      must(ap.status === 0, `eve-dispatch --apply exit ${ap.status}: ${(ap.stderr || ap.stdout).slice(0, 300)}`);
      const card = ctx.readCard(docs);
      must(card.state === 'running', `card state=${card.state}, esperado running`);
      must(card.corr === o.correlationId, `card.corr=${card.corr} != ${o.correlationId}`);
      must(card.lease && card.lease.owner === `eve:${sub.jobId}`, `lease.owner=${card.lease && card.lease.owner}`);
      const again = spawnSync(process.execPath, [bin, docs, '--project-id', 'drillrepo', '--apply', '--job-id', sub.jobId], { env: ctx.env, encoding: 'utf8' });
      must(again.status !== 0, '--apply sobre una tarjeta running debe rehusar');
      ctx.measures.hops['create->dispatch'] = Date.now() - Date.parse(card.created_at);
      return [`payload corr=${o.correlationId} mode=${payload.mode} doneMeans=${payload.doneMeans.length}`, `${docs} running lease=${card.lease.owner}`, 're-apply rehusado'];
    },
  },
  {
    id: 3, side: 'finalorchestra', title: 'Eve honra el gate: deploy => AWAITING citando graph.json; docs => QUEUED aun con politica activa',
    async run(ctx) {
      const { docs, deploy } = ensureCards(ctx);
      const stub = ensureStub(ctx);
      const mk = (id, kind, mode) => ({ projectId: 'drillrepo', mode, objective: `drill\nkind=${kind}`, doneMeans: ['x'], repo: ctx.repo, kind, origin: { originProject: 'wezbridge', correlationId: `${id}:${kind}:20260901`, returnPreference: 'WEZBRIDGE', clientKind: 'wezbridge' } });
      const d = stub.submit(mk(deploy, 'deploy', 'CHANGE'));
      must(d.status === 'AWAITING_APPROVAL', `deploy status=${d.status}`);
      must(/graph\.json kinds\.deploy\.gate=operator/.test(d.reason), `deploy reason=${d.reason}`);
      const s = stub.submit(mk(docs, 'docs', 'CHANGE'));
      must(s.status === 'QUEUED', `docs status=${s.status}`);
      const u = stub.submit(mk(docs, 'nonexistent', 'CHANGE'));
      must(u.status === 'AWAITING_APPROVAL' && /unknown kind/.test(u.reason), `unknown kind => ${u.status} ${u.reason}`);
      ctx.jobs = { ...(ctx.jobs || {}), deploy: d.jobId };
      return [`deploy ${d.jobId} ${d.status} (${d.reason})`, `docs ${s.jobId} ${s.status}`, `nonexistent => ${u.status} (${u.reason})`, ctx.mode === 'stub' ? 'stub: contrato de T-0308; live lo mide contra FINALORCHESTRA_URL' : 'live'];
    },
  },
  {
    id: 4, side: 'operator', title: 'Decision sin teclado: POST /api/rulings approved => ruling con source, tarjeta ready des-gateada, blocked_by != operator',
    async run(ctx) {
      const { deploy } = ensureCards(ctx);
      const before = ctx.readCard(deploy);
      must(before.state === 'blocked', `precondicion: deploy state=${before.state}`);
      const { gateOf } = require(path.join(ROOT, 'scripts', 'fleet-board.cjs'));
      const nRul = ctx.rulings().length;
      const nAct = readJsonl(path.join(ctx.intel, 'operator-actions.jsonl')).length;
      const t0 = Date.now();
      const res = await withBoard(ctx, ({ base, token }) => postJson(base, token, '/api/rulings', { task: deploy, verb: 'approved', note: 'drill: dale' }));
      ctx.measures.hops['ruling->transition'] = Date.now() - t0;
      must(res.status === 200, `HTTP ${res.status}: ${JSON.stringify(res.json || res.text).slice(0, 200)}`);
      const lines = ctx.rulings();
      must(lines.length === nRul + 1, `rulings.jsonl +${lines.length - nRul}, esperado +1`);
      const line = lines[lines.length - 1];
      must(line.task === deploy && line.ruling === 'approved' && line.why && line.at, `ruling line=${JSON.stringify(line)}`);
      must(res.json.transition && res.json.transition.ungated === true, `transition=${JSON.stringify(res.json.transition)}`);
      const after = ctx.readCard(deploy);
      must(after.state === 'ready', `state=${after.state}`);
      must(gateOf(after) !== 'operator', `gateOf() sigue operator: gate=${after.gate} contract.gate=${after.contract && after.contract.gate}`);
      const acts = readJsonl(path.join(ctx.intel, 'operator-actions.jsonl'));
      must(acts.length === nAct + 1 && acts[acts.length - 1].kind === 'approval', `operator-actions +${acts.length - nAct}, esperado +1 approval`);
      must(line.source === 'board-app', `4c: ruling sin provenance (source=${line.source})`);
      must(after.blocked_by !== 'operator', '4d: blocked_by sigue operator en una tarjeta ready');
      return [`ruling ${JSON.stringify(line)}`, `${deploy} ready gateOf=${gateOf(after)} blocked_by=${after.blocked_by}`, `operator-actions +1 (${acts[acts.length - 1].source})`];
    },
  },
  {
    id: 5, side: 'wezbridge', title: 'El dueño se entera: cola + decision.queued/delivered/undeliverable; lease Eve => cola finalorchestra; steward decision-unheard',
    async run(ctx) {
      const { deploy } = ensureCards(ctx);
      ensureDeployApproved(ctx);
      const relayMod = tryRequire('src/decision-relay.cjs');
      must(relayMod && typeof relayMod.createRelay === 'function', 'src/decision-relay.cjs ausente (W3)');
      const at = new Date().toISOString();
      if (!ctx.rulings().some((r) => r.task === deploy && r.ruling === 'approved')) {
        fs.appendFileSync(path.join(ctx.intel, 'rulings.jsonl'), JSON.stringify({ task: deploy, category: 'awaiting-operator', ruling: 'approved', why: 'drill: dale', at, source: 'drill' }) + '\n');
      }
      const sent = [];
      const idle = { paneId: 7, project: ctx.repoDir, title: 'drill', status: 'idle', lastLines: '❯' };
      const mkRelay = (send, panes) => relayMod.createRelay({ intelDir: ctx.intel, discoverPanes: () => panes, send, runLedger: ctx.runLedger, now: () => Date.now(), log: ctx.log });
      // 5a: pane ocupado => queued, nada entregado
      let r = mkRelay({ sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' }, [{ ...idle, status: 'working' }]);
      let out = await r.relayOnce();
      const qf = path.join(ctx.intel, 'queues', 'drillrepo.jsonl');
      must(fs.existsSync(qf), 'queues/drillrepo.jsonl no creado');
      const q = readJsonl(qf).filter((e) => e.corr === deploy);
      must(q.length >= 1 && /^\[decision\]/.test(String(q[q.length - 1].body)), `cola sin envelope [decision]: ${JSON.stringify(q.slice(-1)).slice(0, 200)}`);
      must(ctx.events().some((e) => e.event === 'decision.queued' && e.task === deploy), 'sin decision.queued');
      // 5b: send 'unknown' => no cuenta como entregado
      r = mkRelay({ sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'unknown' }, [idle]);
      out = await r.relayOnce();
      must(!ctx.events().some((e) => e.event === 'decision.delivered' && e.task === deploy), 'un send unknown se conto como delivered');
      // 5c: steward a +7h sin delivered => decision-unheard; steward-gate RED
      const steward = require(path.join(ROOT, 'scripts', 'fleet-steward.cjs'));
      const later = Date.parse(at) + 7 * 3600000;
      let report = steward.audit(ctx.readTasks(), later, ctx.intel, { census: [{ pane_id: 7, cwd: ctx.repoDir }] });
      must(report.findings.some((f) => f.id === deploy && f.category === 'decision-unheard'), `steward sin decision-unheard: ${JSON.stringify(report.findings.map((f) => [f.id, f.category]))}`);
      // Solo el hallazgo que este check mide: a +7h la lease de 240 min tambien vence
      // (abandoned-lease) y pondria el gate RED por otra razon, que no es la que se prueba.
      const rep = path.join(ctx.tmp, 'report-5.json');
      fs.writeFileSync(rep, JSON.stringify({ ...report, findings: report.findings.filter((f) => f.category === 'decision-unheard') }));
      const gate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'steward-gate.cjs'), '--from', rep], { env: ctx.env, encoding: 'utf8' });
      must(gate.status === 1 && /decision-unheard/.test(gate.stdout), `steward-gate exit ${gate.status} (esperado 1 RED por decision-unheard): ${gate.stdout.slice(0, 200)}`);
      // 5d: entrega verificada => decision.delivered; steward calla
      r = mkRelay({ sendPromptDeferredEnter: async (p, t) => { sent.push(t); return 'ok'; }, verifyPromptSubmission: async () => 'submitted' }, [idle]);
      out = await r.relayOnce();
      must(ctx.events().some((e) => e.event === 'decision.delivered' && e.task === deploy), `sin decision.delivered tras send verificado (relayOnce=${JSON.stringify(out).slice(0, 200)})`);
      report = steward.audit(ctx.readTasks(), later, ctx.intel, { census: [{ pane_id: 7, cwd: ctx.repoDir }] });
      must(!report.findings.some((f) => f.id === deploy && f.category === 'decision-unheard'), 'decision-unheard sigue disparando con delivered (ruido)');
      // 5e: tarjeta con lease de Eve => cola finalorchestra con la llamada exacta
      const docsCard = ensureDocsRunning(ctx);
      fs.appendFileSync(path.join(ctx.intel, 'rulings.jsonl'), JSON.stringify({ task: docsCard.id, category: 'awaiting-operator', ruling: 'approved', why: 'drill: eve', at: new Date().toISOString(), source: 'drill' }) + '\n');
      r = mkRelay({ sendPromptDeferredEnter: async () => 'ok', verifyPromptSubmission: async () => 'submitted' }, [idle]);
      await r.relayOnce();
      const fq = readJsonl(path.join(ctx.intel, 'queues', 'finalorchestra.jsonl')).filter((e) => e.corr === docsCard.id);
      must(fq.length >= 1 && /task_answer .*approved/.test(String(fq[fq.length - 1].body)), `cola finalorchestra sin task_answer: ${JSON.stringify(fq.slice(-1)).slice(0, 200)}`);
      must(/task_answer/.test(String(ctx.readCard(docsCard.id).next_action || '')), 'next_action de la tarjeta no nombra la llamada');
      ctx.measures.delivery = { direct: sent.length, queue: q.length };
      return ['pane ocupado => queued', 'send unknown => no delivered', 'steward +7h => decision-unheard, gate RED', 'send verificado => delivered, steward calla', 'lease eve => queues/finalorchestra.jsonl task_answer'];
    },
  },
  {
    id: 6, side: 'wezbridge', title: 'Eve devuelve por a2a_send: sobre <=1200 con criteria; sin criteria se rechaza aun por cola; la linea llega a a2a-results.jsonl aunque quede en cola',
    async run(ctx) {
      const card = seedRunningCard(ctx, 'check6', 'JOB-drill-6');
      const stub = ensureStub(ctx);
      const a2a = require(path.join(ROOT, 'src', 'a2a-intel.cjs'));
      const sub = stub.submit({ projectId: 'drillrepo', mode: 'CHANGE', objective: 'x\nkind=docs', doneMeans: ['a', 'b'], repo: ctx.repo, kind: 'docs', origin: { originProject: 'wezbridge', correlationId: card.corr, returnPreference: 'WEZBRIDGE', clientKind: 'wezbridge' } });
      must(sub.status === 'QUEUED', `stub docs status=${sub.status}`);
      const t0 = Date.now();
      const done = await stub.complete(sub.jobId, { verdict: 'COMPLETED', summary: 'header agregado', criteria: CRITERIA_OK(sub.jobId), filesChanged: ['docs/README.md'], prUrl: 'https://github.com/x/drillrepo/pull/1' });
      const body = done.body;
      must(body.length <= 1200, `body ${body.length} chars > 1200`);
      for (const needle of [`FinalOrchestra ${sub.jobId}: COMPLETED`, 'criteria:', 'pass —', 'evidence: E=', 'files_changed:', `next_action: factory result ${sub.jobId} --detail full`, 'pull/1']) must(body.includes(needle), `sobre sin "${needle}"`);
      must(a2a.detectV2(body) === 'ok', `detectV2=${a2a.detectV2(body)}`);
      must(a2a.weakPasses(body).length === 0, `weakPasses=${JSON.stringify(a2a.weakPasses(body))}`);
      // 6a: por a2a_send real (subproceso), bajo el mock => rama de cola
      const res = await callTool(ctx, 'a2a_send', { to_project: 'drillrepo', from_pane: 9, corr: card.corr, type: 'result', body });
      ctx.measures.hops['result->a2a_send'] = Date.now() - t0;
      const txt = (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || '';
      must(res.result && res.result.isError !== true, `a2a_send isError: ${txt.slice(0, 200)}`);
      let parsed = {}; try { parsed = JSON.parse(txt); } catch { /* texto plano */ }
      must(parsed.queued === true, `esperaba queued=true bajo el mock: ${txt.slice(0, 200)}`);
      // 6c: la linea existe en a2a-results.jsonl aunque quedo en cola
      const rec = ctx.results().filter((l) => l.corr === card.corr);
      must(rec.length === 1, `6c: a2a-results.jsonl con corr=${card.corr}: ${rec.length} lineas (esperado 1)`);
      // 6b: sin criteria se rechaza aun por cola
      const bad = await callTool(ctx, 'a2a_send', { to_project: 'drillrepo', from_pane: 9, corr: card.corr, type: 'result', body: `FinalOrchestra ${sub.jobId}: COMPLETED\nlisto, confia en mi` });
      const badTxt = (bad.result && bad.result.content && bad.result.content[0] && bad.result.content[0].text) || '';
      must(bad.result && bad.result.isError === true && /result-shape: BLOCKED/.test(badTxt), `6b: result sin criteria NO fue rechazado por la cola: ${badTxt.slice(0, 200)}`);
      ctx.measures.verification.a2a = { delivered: parsed.delivered, submitted: parsed.submitted };
      return [`sobre ${body.length} chars v2=ok`, `a2a_send queued=true ${parsed.note ? parsed.note.slice(0, 60) : ''}`, `6c a2a-results.jsonl +1 corr=${card.corr}`, '6b sin criteria => result-shape: BLOCKED'];
    },
  },
  {
    id: 7, side: 'wezbridge', title: 'El result mueve la tarjeta: running => review con evidencia; FAILED/BLOCKED mapean; corr sin tarjeta => result.unlinked; idempotente',
    async run(ctx) {
      const linker = tryRequire('src/result-linker.cjs');
      must(linker && typeof linker.link === 'function', 'src/result-linker.cjs ausente (W2)');
      const a2a = require(path.join(ROOT, 'src', 'a2a-intel.cjs'));
      const card = seedRunningCard(ctx, 'check7', 'JOB-drill-7');
      const { buildEnvelope } = require(path.join(ROOT, 'test', 'mocks', 'eve-stub.cjs'));
      const body = buildEnvelope({ jobId: 'JOB-drill-7', kind: 'docs', repo: ctx.repo }, { verdict: 'COMPLETED', criteria: CRITERIA_OK('JOB-drill-7'), filesChanged: ['docs/README.md'], prUrl: 'https://github.com/x/drillrepo/pull/1' });
      a2a.recordResultBody({ corr: `${card.corr}:r2`, fromPane: 9, toPane: null, v2: a2a.detectV2(body), body });
      const line = ctx.results().find((l) => l.corr === `${card.corr}:r2`);
      must(line, 'recordResultBody no dejo linea');
      const deps = { runLedger: ctx.runLedger, readTasks: ctx.readTasks, recordEvent: (e) => fs.appendFileSync(path.join(ctx.intel, 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...e }) + '\n'), now: () => Date.now() };
      const t0 = Date.now();
      const r1 = linker.link(line, deps);
      ctx.measures.hops['result->review'] = Date.now() - t0;
      const after = ctx.readCard(card.id);
      must(after.state === 'review', `state=${after.state} (link=${JSON.stringify(r1).slice(0, 200)})`);
      const ev = JSON.stringify(after.evaluator_evidence || after.evidence || after.next_action || '');
      must(/a2a-results\.jsonl/.test(ev), `evidencia no apunta a a2a-results.jsonl: ${ev.slice(0, 200)}`);
      const r2 = linker.link(line, deps);
      must(ctx.readCard(card.id).state === 'review', 'segunda pasada cambio el estado');
      // corr sin tarjeta
      const orphan = { ...line, corr: 'T-9999:nada:20260901' };
      linker.link(orphan, deps);
      must(ctx.events().some((e) => e.event === 'result.unlinked' && e.corr === orphan.corr), 'sin result.unlinked para corr huerfano');
      const steward = require(path.join(ROOT, 'scripts', 'fleet-steward.cjs'));
      const report = steward.audit(ctx.readTasks(), Date.now(), ctx.intel, { census: [] });
      must(report.findings.some((f) => f.category === 'result-unlinked'), 'steward sin hallazgo result-unlinked');
      // FAILED
      const c2 = ctx.runLedger(['create', '--title', '[DRILL] failing', '--goal', 'x', '--kind', 'docs', '--repo', ctx.repo, '--criteria', 'a', '--blocked-by', 'agent', '--origin', `drill:fail:${Date.now()}`]);
      ctx.runLedger(['update', c2.id, '--state', 'ready']); ctx.runLedger(['update', c2.id, '--state', 'running', '--corr', `${c2.id}:f:20260901`]);
      const fbody = `FinalOrchestra JOB-f: FAILED\nrompio\ncriteria:\n- a: fail — E=JOB-f-1\nevidence: E=JOB-f-1\nnext_action: factory result JOB-f --detail full`;
      a2a.recordResultBody({ corr: `${c2.id}:f:20260901`, fromPane: 9, toPane: null, v2: a2a.detectV2(fbody), body: fbody });
      linker.link(ctx.results().find((l) => l.corr === `${c2.id}:f:20260901`), deps);
      must(ctx.readCard(c2.id).state === 'failed', `FAILED => ${ctx.readCard(c2.id).state}`);
      return [`${card.id} running => review evidencia=${ev.slice(0, 60)}`, 'segunda pasada no-op', 'corr huerfano => result.unlinked + hallazgo steward', `${c2.id} FAILED => failed`, `link r1=${JSON.stringify(r1).slice(0, 80)} r2=${JSON.stringify(r2).slice(0, 80)}`];
    },
  },
  {
    id: 8, side: 'wezbridge', title: 'Steward y gates consistentes: sin hallazgos malos para las tarjetas del drill; steward-gate 0; validate-intel 0; tablero muestra la aprobada en fleet',
    async run(ctx) {
      const docsCard = seedRunningCard(ctx, 'check8', 'JOB-drill-8');
      ensureDeployApproved(ctx);
      const stub = ensureStub(ctx);
      const jobId = String(docsCard.lease.owner).replace(/^eve:/, '');
      const steward = require(path.join(ROOT, 'scripts', 'fleet-steward.cjs'));
      const liveness = (j) => (j === jobId ? true : (stub.isAlive(j) || false));
      const report = steward.audit(ctx.readTasks(), Date.now(), ctx.intel, { census: [{ pane_id: 9, cwd: ctx.repoDir }], executorLiveness: liveness });
      const ids = [docsCard.id, ctx.cards.deploy];
      const hits = report.findings.filter((f) => ids.includes(f.id) && BAD_CATEGORIES.includes(f.category));
      must(hits.length === 0, `hallazgos: ${JSON.stringify(hits.map((f) => [f.id, f.category, String(f.why).slice(0, 80)]))}`);
      const rep = path.join(ctx.tmp, 'report-8.json'); fs.writeFileSync(rep, JSON.stringify(report));
      const gate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'steward-gate.cjs'), '--from', rep], { env: ctx.env, encoding: 'utf8' });
      must(gate.status === 0, `steward-gate exit ${gate.status}: ${gate.stdout.slice(0, 300)}`);
      const vi = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-intel.cjs'), '--json'], { env: ctx.env, encoding: 'utf8' });
      must(vi.status === 0, `validate-intel exit ${vi.status}: ${vi.stdout.slice(0, 300)}`);
      const boardState = await withBoard(ctx, ({ base, token }) => getJson(base, token, '/api/state'));
      const inDecisions = JSON.stringify(boardState.decisions || boardState.waiting || []).includes(ctx.cards.deploy);
      must(!inDecisions, 'la tarjeta aprobada sigue en DECISIONES del tablero');
      return [`steward findings=${report.findings.length}, ninguno malo para ${ids.join('/')}`, gate.stdout.trim().split('\n')[0], 'validate-intel exit 0', 'tablero: aprobada fuera de decisiones'];
    },
  },
  {
    id: 9, side: 'wezbridge', title: 'Waker honesto: send unknown => pendiente unverified, no entregado; composer ajeno persistido en held-composer.jsonl sin duplicar',
    async run(ctx) {
      const { createWaker } = require(path.join(ROOT, 'src', 'orchestrator-waker.cjs'));
      const dir = path.join(ctx.tmp, 'waker'); fs.mkdirSync(dir, { recursive: true });
      const eventsPath = path.join(ctx.intel, 'pane-events.jsonl');
      const calls = [];
      const orch = paneWithComposer('❯', path.join(ctx.tmp, 'wezbridge'), 0);
      const held = paneWithComposer('❯ dale, hacelo vos', ctx.repoDir, 3);
      const mk = (submitted) => createWaker({ eventsPath, stateDir: path.join(dir, submitted), intelDir: ctx.intel, discoverPanes: () => [orch, held], send: { sendPromptDeferredEnter: async (p, t) => { calls.push(t); return 'ok'; }, verifyPromptSubmission: async () => submitted }, settleTicks: 1, cooldownMs: 0, maxAttempts: 3, now: () => Date.now(), log: ctx.log, watchRepos: ['drillrepo'], targetProject: 'wezbridge' });
      const w = mk('unknown');
      await w.tick();
      fs.appendFileSync(eventsPath, JSON.stringify({ time: new Date().toISOString(), repo: 'drillrepo', session: 'drill', event: 'turn-end' }) + '\n');
      await w.tick(); await w.tick(); await w.tick();
      const st = w.status();
      must(calls.length >= 1, 'el waker no intento ningun poke');
      const pending = Object.values(w._state.pending || {});
      const delivered = w._state.delivered || [];
      must(delivered.length === 0, `un send unknown se conto como entregado (delivered=${delivered.length})`);
      must(typeof st.unverified === 'number' && st.unverified >= 1, `status().unverified=${st.unverified}`);
      const hc = path.join(ctx.intel, 'held-composer.jsonl');
      must(fs.existsSync(hc), 'held-composer.jsonl no existe');
      const lines = readJsonl(hc).filter((l) => l.repo === 'drillrepo');
      must(lines.length === 1 && /dale, hacelo vos/.test(String(lines[0].held)), `held-composer.jsonl lineas=${lines.length}: ${JSON.stringify(lines).slice(0, 200)}`);
      // control positivo: con submitted entrega
      const w2 = mk('submitted');
      fs.appendFileSync(eventsPath, JSON.stringify({ time: new Date().toISOString(), repo: 'drillrepo', session: 'drill2', event: 'turn-end' }) + '\n');
      await w2.tick(); await w2.tick();
      must((w2._state.delivered || []).length >= 1, 'con submitted el intento no se entrego');
      ctx.measures.verification.waker = { unknown: st.unverified, delivered: (w2._state.delivered || []).length };
      ctx.measures.unknown += st.unverified;
      return [`pokes=${calls.length} delivered=0 unverified=${st.unverified} pending=${pending.length}`, 'held-composer.jsonl 1 linea (dedupe ok)', 'control positivo submitted => delivered'];
    },
  },
];

// ---------------------------------------------------------------------------
// runner + reporte
// ---------------------------------------------------------------------------
async function runCheck(ctx, check) {
  const t0 = Date.now();
  try {
    const evidence = await check.run(ctx);
    return { id: check.id, side: check.side, title: check.title, verdict: 'GREEN', evidence: evidence || [], ms: Date.now() - t0 };
  } catch (e) {
    const unknownV = e && e.name === 'DrillUnknown';
    if (unknownV) ctx.measures.unknown += 1;
    return { id: check.id, side: check.side, title: check.title, verdict: unknownV ? 'UNKNOWN' : 'RED', side_label: unknownV ? null : (e.side || check.side), evidence: [String((e && e.message) || e).split('\n')[0]], ms: Date.now() - t0 };
  }
}

async function runDrill({ mode = 'stub', only = null, keep = false, log = () => {}, flags = {} } = {}) {
  if (mode === 'live') return require('./fleet-drill-live.cjs').runLive(flags, log);
  if (mode !== 'stub') unknown(`modo desconocido: ${mode}`);
  let ctx;
  try { ctx = buildSandbox({ keep, log }); } catch (e) { return { mode, verdict: 'UNKNOWN', exit: 3, checks: [], error: String(e.message), measures: {} }; }
  const results = [];
  for (const check of CHECKS) {
    if (only && !only.includes(check.id)) continue;
    const r = await runCheck(ctx, check);
    ctx.measures.checks[r.id] = r.ms;
    results.push(r);
    log(`check ${r.id} ${r.verdict}${r.verdict === 'RED' ? ` — ${r.side_label} side` : ''}: ${r.evidence[0] || ''}`);
  }
  const anyUnknown = results.some((r) => r.verdict === 'UNKNOWN');
  const anyRed = results.some((r) => r.verdict === 'RED');
  const out = { mode, verdict: anyUnknown ? 'UNKNOWN' : anyRed ? 'RED' : 'GREEN', exit: anyUnknown ? 3 : anyRed ? 1 : 0, sandbox: ctx.tmp, checks: results, measures: ctx.measures, generated_at: new Date().toISOString() };
  teardown(ctx);
  return out;
}

function renderMd(r) {
  const rows = r.checks.map((c) => `| ${c.id} | ${c.verdict}${c.verdict === 'RED' ? ` — ${c.side_label}` : ''} | ${c.side} | ${c.ms} ms | ${c.title} |`).join('\n');
  const ev = r.checks.map((c) => `### Check ${c.id} — ${c.verdict}\n\`\`\`\n${(c.evidence || []).join('\n')}\n\`\`\``).join('\n\n');
  return `# fleet-drill — ${r.verdict} (${r.mode}) — ${r.generated_at}\n<!-- DRILL T31. Nueve checks del loop wezbridge<->Eve<->graph; veredicto por check con lado y salida pegada.\n     Un check sin salida pegada es UNKNOWN, no GREEN. Exit ${r.exit}. -->\n\n| # | veredicto | lado | ms | check |\n|---|---|---|---|---|\n${rows}\n\n## Salidas\n\n${ev}\n\n## Mediciones\n\`\`\`json\n${JSON.stringify(r.measures, null, 2)}\n\`\`\`\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
  const mode = flag('--mode') || 'stub';
  const only = flag('--only') ? flag('--only').split(',').map(Number) : null;
  const keep = argv.includes('--keep');
  const report = flag('--report');
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    flags[k] = v;
  }
  const r = await runDrill({ mode, only, keep, flags, log: (m) => console.error(m) });
  if (report) {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, renderMd(r));
    fs.writeFileSync(report.replace(/\.md$/, '') + '.json', JSON.stringify(r, null, 2));
  }
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`fleet-drill ${r.verdict}: ${r.checks.filter((c) => c.verdict === 'GREEN').length}/${r.checks.length} GREEN` + (r.error ? ` — ${r.error}` : ''));
    for (const c of r.checks) console.log(`  ${String(c.id).padStart(2)} ${c.verdict.padEnd(7)} ${c.verdict === 'RED' ? `(${c.side_label}) ` : ''}${c.evidence[0] || ''}`);
    if (keep) console.log(`sandbox: ${r.sandbox}`);
  }
  process.exit(r.exit);
}

if (require.main === module) main().catch((e) => { console.error(`fleet-drill UNKNOWN: ${e.message}`); process.exit(3); });
module.exports = { buildSandbox, CHECKS, runDrill, renderMd, ensureCards, ensureDocsRunning, ensureDeployApproved, DrillRed, DrillUnknown };
