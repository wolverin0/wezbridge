'use strict';
// a2a-queue-records-result.test.cjs — W2/checks 6b y 6c: un result que viaja por
// la COLA (sin pane vivo) tiene que pasar por los mismos controles que uno
// entregado. Hasta W2 la rama `to_project` sin pane retornaba ANTES de
// checkResultShape y de recordResultBody: un result encolado nunca llegaba a
// a2a-results.jsonl y ningun sobre malformado era rechazado por ese camino.
// Maneja el mcp-server REAL como subproceso JSON-RPC con el mock de wezterm
// (ningun pane tiene agente, asi que to_project siempre toma la rama de cola).
// Depende de companions (_docs-curation/ledger.cjs es el FSM real).
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, '..', 'src', 'mcp-server.cjs');
const MOCK = path.join(__dirname, 'mocks', 'wezterm-mock.cjs');
const CURATION = path.join(__dirname, '..', '..', '_docs-curation');
const REAL_KINDS = path.join(__dirname, '..', '..', '_intel', 'kinds.json');

// Mismo idioma que mcp-server-v35-tools.test.cjs:22-47 — cada llamada levanta un
// servidor fresco, asi que el presupuesto por llamada es generoso a proposito.
function callTool(name, args, env = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; stderr=${stderr}`)); }, timeoutMs);
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      stdout += c;
      const nl = stdout.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      const line = stdout.slice(0, nl).trim();
      child.stdin.end();
      child.kill('SIGTERM');
      try { resolve(JSON.parse(line)); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}; stdout=${stdout}; stderr=${stderr}`)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

const resultText = (res) => res.result.content[0].text;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-queue-'));
  const intel = path.join(root, '_intel');
  const curation = path.join(root, '_docs-curation');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  fs.mkdirSync(curation, { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(intel, 'kinds.json'));
  fs.copyFileSync(path.join(CURATION, 'ledger.cjs'), path.join(curation, 'ledger.cjs'));
  fs.copyFileSync(path.join(CURATION, 'sweeper-config.json'), path.join(curation, 'sweeper-config.json'));
  return { root, intel };
}

const envFor = (intel) => ({
  WEZBRIDGE_INTEL_DIR: intel,
  WEZBRIDGE_WEZTERM_BIN: MOCK,
  WEZBRIDGE_SAFETY_OVERRIDE: '1',
});

function card(intel, id, over = {}) {
  fs.writeFileSync(path.join(intel, 'tasks', `${id}.json`), JSON.stringify({
    id, title: 'tarjeta encolada', goal: 'algo', kind: 'general', repo: 'wezbridge',
    state: 'running', blocked_by: 'agent', acceptance_criteria: ['medible'], lease: null,
    attempt: 1, corr: null, state_changed_at: '2026-09-01T00:00:00.000Z', ...over,
  }, null, 2));
}

const results = (intel) => {
  const f = path.join(intel, 'a2a-results.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const queueLines = (intel, project) => {
  const f = path.join(intel, 'queues', `${project}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
};

const GOOD_BODY = [
  'FinalOrchestra JOB-77: COMPLETED',
  'criteria:',
  '- el gate se respeta: pass — graph.json kinds.deploy.gate=operator',
  'files_changed: src/x.cjs',
  'next_action: revisar',
].join('\n');

test('6b: un type=result SIN bloque criteria se rechaza AUN por la cola', async () => {
  const { root, intel } = sandbox();
  try {
    const res = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'result',
      corr: 'T-0501:x:20260901', body: 'quedo todo listo, saludos',
    }, envFor(intel));
    assert.equal(res.result.isError, true, 'la cola no puede ser el camino sin control');
    assert.match(resultText(res), /result-shape: BLOCKED/);
    assert.equal(results(intel).length, 0, 'un sobre rechazado no se persiste como resultado');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('6c: un result bien formado llega a a2a-results.jsonl aunque la entrega quede ENCOLADA', async () => {
  const { root, intel } = sandbox();
  try {
    const res = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'result',
      corr: 'T-0502:x:20260901', body: GOOD_BODY,
    }, envFor(intel));
    assert.equal(res.result.isError, false);
    const payload = JSON.parse(resultText(res));
    assert.equal(payload.queued, true, 'sin pane vivo la entrega se encola: esa es la precondicion del check');
    assert.equal(payload.ok, false);
    const lines = results(intel);
    assert.equal(lines.length, 1, 'exactamente UNA linea: registrado una vez por envio, no dos');
    assert.equal(lines[0].corr, 'T-0502:x:20260901');
    assert.equal(lines[0].v2, 'ok');
    assert.match(lines[0].body, /FinalOrchestra JOB-77: COMPLETED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('W2: el result encolado MUEVE la tarjeta y la respuesta lo dice en el note', async () => {
  const { root, intel } = sandbox();
  try {
    card(intel, 'T-0503', { corr: 'T-0503:x:20260901' });
    const res = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'result',
      corr: 'T-0503:x:20260901', body: GOOD_BODY,
    }, envFor(intel));
    const payload = JSON.parse(resultText(res));
    assert.match(payload.note, /Ledger: T-0503 running → review/, 'el emisor tiene que ver que la tarjeta se movio');
    const after = JSON.parse(fs.readFileSync(path.join(intel, 'tasks', 'T-0503.json'), 'utf8'));
    assert.equal(after.state, 'review');
    assert.match(after.evaluator_evidence, /a2a-results\.jsonl#time=/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('W2: un result sin tarjeta lo DICE en el note y deja el hallazgo, en vez de callarse', async () => {
  const { root, intel } = sandbox();
  try {
    const res = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'result',
      corr: 'T-9999:x:20260901', body: GOOD_BODY,
    }, envFor(intel));
    const payload = JSON.parse(resultText(res));
    assert.match(payload.note, /Ledger: result NOT linked \(no-card\)/);
    const events = fs.readFileSync(path.join(intel, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const unlinked = events.filter((e) => e.event === 'result.unlinked');
    assert.equal(unlinked.length, 1);
    assert.equal(unlinked[0].reason, 'no-card');
    assert.equal(unlinked[0].corr, 'T-9999:x:20260901');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── W2-j/W2-m: el charset del corr y el handshake con la cola ──────────────

test('W2-j: un corr con `:` se acepta; uno con espacio sigue refusado', async () => {
  const { root, intel } = sandbox();
  try {
    const ok = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'result',
      corr: 'T-0504:docs-header:20260901:r2', body: GOOD_BODY,
    }, envFor(intel));
    assert.equal(ok.result.isError, false,
      'sin `:` la convencion de Eve entera es indespachable: su result se rechaza antes de llegar al linker');
    assert.equal(results(intel)[0].corr, 'T-0504:docs-header:20260901:r2');

    const bad = await callTool('a2a_send', {
      to_project: 'proyecto-sin-pane-vivo', from_pane: 5, type: 'result',
      corr: 'T-0505 con espacio', body: GOOD_BODY,
    }, envFor(intel));
    assert.equal(bad.result.isError, true, 'el charset sigue cerrado: el corr llega a formar nombres de archivo');
    assert.match(resultText(bad), /corr must be/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('W2-m: la linea encolada del result lleva recorded:true — el drain no lo registra dos veces', async () => {
  const { root, intel } = sandbox();
  try {
    await callTool('a2a_send', {
      to_project: 'drillrepo', from_pane: 5, type: 'result',
      corr: 'T-0506:x:20260901', body: GOOD_BODY,
    }, envFor(intel));
    const queued = queueLines(intel, 'drillrepo');
    const line = queued.find((q) => q.corr === 'T-0506:x:20260901');
    assert.ok(line, 'el envelope tiene que quedar en la cola durable');
    assert.equal(line.recorded, true,
      'sin la marca, deliverPending vuelve a registrar el cuerpo y a2a-results.jsonl cuenta dos veces el mismo result');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('W2-m: un type=request encolado NO lleva la marca — solo los results se registran', async () => {
  const { root, intel } = sandbox();
  try {
    await callTool('a2a_send', {
      to_project: 'drillrepo', from_pane: 5, type: 'request', corr: 'charla-1', body: 'hace X',
    }, envFor(intel));
    const line = queueLines(intel, 'drillrepo').find((q) => q.corr === 'charla-1');
    assert.equal(line.recorded, undefined, 'marcar un request como registrado le mentiria al drain');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
