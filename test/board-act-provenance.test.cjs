'use strict';
/**
 * board-act-provenance.test.cjs — un enlace firmado NO es el operador (T-0349).
 *
 * EL AGUJERO (encontrado leyendo el codigo al rulear T-0334): /act se atiende
 * ANTES del chequeo de token porque "la firma es la credencial", handleAct arma
 * el body sin campo `by`, y validateRuling default-ea `by` a 'operator'. Como
 * quienes EMITEN esos enlaces son decision-push y el hub de avisos, cualquiera
 * que vea la URL podia acuñar una linea by=operator indistinguible de un tap
 * real — y `by=operator` es el campo del que cuelgan isOperatorRuling y todos
 * los gates de "esto no se hace sin el operador".
 *
 * Lo que estos tests fijan es PROCEDENCIA, no politica: las dos entradas tienen
 * que quedar distinguibles en la linea. Si el enlace firmado DEBE valer como el
 * operador es decision del operador, y hoy `isOperatorRuling` sigue diciendo que
 * si por `source: board-app` — eso se documenta en el result, no se decide aca.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_INTEL = fs.mkdtempSync(path.join(os.tmpdir(), 'act-prov-'));
process.env.WEZBRIDGE_INTEL_DIR = TMP_INTEL;

const srv = require('../board-app/server.cjs');
const { buildActionUrl } = require('../board-app/lib/action-links.cjs');
const { isOperatorRuling } = require('../src/rulings.cjs');

const TOKEN = 'prov-test-token';
let server;
let base;

function seedTask(id) {
  fs.writeFileSync(path.join(TMP_INTEL, 'tasks', `${id}.json`), JSON.stringify({
    id, title: `Task ${id}`, repo: 'wezbridge', state: 'blocked', corr: `corr-${id}`,
    contract: { gate: 'operator', _note: 'la pregunta' }, blocked_by: 'operator',
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  }));
}
const rulings = () => {
  try {
    return fs.readFileSync(path.join(TMP_INTEL, 'rulings.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
const form = (o) => new URLSearchParams(o).toString();

before(async () => {
  fs.mkdirSync(path.join(TMP_INTEL, 'tasks'), { recursive: true });
  seedTask('T-9301');
  seedTask('T-9302');
  server = srv.createServer(TOKEN);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// AC1 — el enlace firmado no acuña `by=operator`.
test('AC1: POST /act con firma valida y sin `by` NO escribe by=operator', async () => {
  const q = Object.fromEntries(new URL(buildActionUrl(base, TOKEN, { task: 'T-9301', verb: 'approved' })).searchParams);
  const res = await fetch(`${base}/act`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...q, note: 'tap desde el enlace de la bandeja' }),
  });
  const html = await res.text();
  assert.strictEqual(res.status, 200, html);

  const line = rulings().find((l) => l.task === 'T-9301');
  assert.ok(line, 'la decision se registra igual: el enlace sigue funcionando');
  assert.notStrictEqual(line.by, 'operator',
    'un enlace firmado NO puede quedar indistinguible de un tap del operador');
  assert.ok(line.by && line.by.length, '`by` no puede quedar vacio: la procedencia es obligatoria');
  assert.match(line.by, /link/i, '`by` debe NOMBRAR el canal (enlace firmado), no omitirlo');
});

// AC2 — el camino del tablero real no se rompe para tapar el agujero.
test('AC2: el tap real con x-board-token sigue escribiendo by=operator', async () => {
  const res = await fetch(`${base}/api/rulings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': TOKEN },
    body: JSON.stringify({ task: 'T-9302', verb: 'approved', note: 'tap real en el tablero' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));

  const line = rulings().find((l) => l.task === 'T-9302');
  assert.strictEqual(line.by, 'operator', 'el tablero autenticado ES el operador');
  assert.strictEqual(line.source, 'board-app');
  assert.strictEqual(isOperatorRuling(line), true, 'y sigue valiendo como decision del operador');
});

// Los dos caminos, en la misma corrida, tienen que poder distinguirse leyendo la linea.
test('AC1+AC2: las dos entradas son distinguibles en rulings.jsonl', () => {
  const porLink = rulings().find((l) => l.task === 'T-9301');
  const porTablero = rulings().find((l) => l.task === 'T-9302');
  assert.notStrictEqual(porLink.by, porTablero.by,
    'si `by` es igual en ambos, el gate no puede saber quien decidio');
});
