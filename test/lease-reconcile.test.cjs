'use strict';
/**
 * T-0272 — un pane puede tomar una lease y morir sin dejar rastro.
 *
 * MEDIDO, no hipotetico: T-0199 se despacho el 2026-08-25, pane-39 tomo una
 * lease de 1440 minutos y murio. Durante 22 horas el tablero dijo "running" y
 * el steward la dejo en paz JUSTO por eso. El unico detector era el vencimiento
 * de la lease, asi que el piso de deteccion es la duracion de la lease.
 *
 * La sutileza que estos tests fijan: comprobar que el pane "existe" NO alcanza,
 * porque los ids se reciclan — el mismo pane-39 sostuvo T-0067 el 2026-08-01 y
 * reaparecio el 08-25 siendo OTRA sesion en OTRO repo. La comprobacion honesta
 * es owner vivo Y cwd del pane coincidente con el repo de la tarjeta.
 *
 * Y la semantica que NO hay que fusionar (mismo error que T-0269): un pane
 * VIVO con una lease larga sin vencer es SANO. Ese caso tiene su test verde
 * explicito aca; el vencimiento es de abandoned-lease, no de este modulo.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileLeases } = require('../scripts/lease-reconcile.cjs');

const NOW = Date.parse('2026-09-01T04:00:00Z');
const H = 3600 * 1000;

function card(id, repo, state, owner, expiresMs) {
  return {
    id, repo, state, title: `card ${id}`,
    lease: { owner, expires_at: new Date(expiresMs).toISOString() },
  };
}

const CENSUS_OK = [
  { pane_id: 4, cwd: 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps/wezbridge/' },
  { pane_id: 9, cwd: 'G:\\_OneDrive\\OneDrive\\Desktop\\Py Apps\\whatsappbot-prod - Copy - Copy\\whatsappbot-final' },
];

test('AC2-rojo: una lease sobre un pane INEXISTENTE produce hallazgo que nombra tarjeta y owner', () => {
  const tasks = [card('T-0999', 'wezbridge', 'running', 'pane-33 (wezbridge)', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.match(out[0].why, /pane-33/);
  assert.strictEqual(out[0].id, 'T-0999');
  assert.match(out[0].why, /no existe|censo/i);
});

test('AC2-verde: owners vivos y cwd coincidente => cero hallazgos', () => {
  const tasks = [
    card('T-0272', 'wezbridge', 'running', 'pane-4 (wezbridge)', NOW + 24 * H),
    card('T-0254', 'whatsappbot-prod - Copy - Copy/whatsappbot-final', 'running', 'pane-9 (whatsappbot-final)', NOW + 2 * H),
  ];
  assert.deepStrictEqual(reconcileLeases(tasks, CENSUS_OK, NOW), []);
});

test('AC4 (semantica separada): pane VIVO con lease LARGA sin vencer NO es hallazgo', () => {
  // 30 dias de lease: es asunto de nadie mientras el owner este vivo y en su repo.
  const tasks = [card('T-0100', 'wezbridge', 'running', 'pane-4 (wezbridge)', NOW + 720 * H)];
  assert.deepStrictEqual(reconcileLeases(tasks, CENSUS_OK, NOW), []);
});

test('AC5 (regresion T-0199/pane-39): el id reciclado — pane vivo pero en OTRO repo — es hallazgo', () => {
  // pane-39 existe, pero su cwd es otra sesion en otro proyecto. "Existe" no alcanza.
  const census = [...CENSUS_OK, { pane_id: 39, cwd: 'G:/_OneDrive/OneDrive/Desktop/Py Apps/brlite' }];
  const tasks = [card('T-0199', 'memorymaster', 'running', 'pane-39 (memorymaster)', NOW + 10 * H)];
  const out = reconcileLeases(tasks, census, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.match(out[0].why, /pane-39/);
  assert.match(out[0].why, /cwd|repo/i);
  assert.match(out[0].why, /brlite/);
});

test('punto (4) del despacho: estados NO-running con lease escrita tambien se reconcilian', () => {
  // T-0229 y compania: tarjetas blocked/review con lease vencida y owner muerto.
  // Un reconciliador que solo barra "running" no limpia ninguna.
  const tasks = [
    card('T-0229', 'wezbridge', 'blocked', 'pane-77 (wezbridge)', NOW - 50 * H),
    card('T-0253', 'memorymaster', 'review', 'pane-78 (memorymaster)', NOW - 2 * H),
  ];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 2);
  for (const f of out) assert.strictEqual(f.category, 'dead-owner-lease');
});

test('estados terminales quedan afuera: una lease vieja en done/cancelled no es hallazgo', () => {
  const tasks = [
    card('T-0001', 'wezbridge', 'done', 'pane-99 (wezbridge)', NOW - 100 * H),
    card('T-0002', 'wezbridge', 'cancelled', 'pane-98 (wezbridge)', NOW - 100 * H),
  ];
  assert.deepStrictEqual(reconcileLeases(tasks, CENSUS_OK, NOW), []);
});

test('censo caido => UN hallazgo ruidoso, nunca silencio', () => {
  // La trampa clasica: si el censo falla y el modulo devuelve [], el fallo de
  // medicion se disfraza de "todo sano". Silencio es la unica direccion en la
  // que este detector no puede fallar.
  const tasks = [card('T-0999', 'wezbridge', 'running', 'pane-4 (wezbridge)', NOW + 1 * H)];
  const out = reconcileLeases(tasks, null, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'lease-census-unavailable');
});

test('cwd VACIO en el censo => unverifiable, NUNCA "id reciclado" (medido en la primera corrida real)', () => {
  // Un pane con cwd vacio puede ser un muerto residual o una lectura
  // transitoria (leccion Monitor v3). Afirmar "reciclado" seria decir mas que
  // la evidencia; callarse seria el silencio de siempre. Se dice lo medible.
  const census = [...CENSUS_OK, { pane_id: 55, cwd: '' }];
  const tasks = [card('T-0555', 'wezbridge', 'running', 'pane-55 (wezbridge)', NOW + 5 * H)];
  const out = reconcileLeases(tasks, census, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'lease-owner-unverifiable');
  assert.match(out[0].why, /vacío|vacio/);
  assert.match(out[0].why, /pane-55/);
});

test('owner sin forma pane-N se reporta como ilegible, no se salta en silencio', () => {
  const tasks = [card('T-0500', 'wezbridge', 'running', 'el orquestador', NOW + 1 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.match(out[0].why, /ilegible|sin pane/i);
});

// ── W5: owners de Eve (`eve:<jobId>`) ───────────────────────────────────────
//
// Un job de FinalOrchestra no tiene pane: su lease se escribe `eve:<jobId>` y
// hasta hoy `parseOwner` la reportaba "ilegible" — un hallazgo falso por cada
// tarjeta despachada a Eve, que es como se entrena a ignorar al steward. La
// vivacidad no se adivina: se INYECTA (`executorLiveness`), y sin inyeccion se
// dice "no se pudo verificar", nunca "sano".

const { parseOwner } = require('../scripts/lease-reconcile.cjs');

const eveCard = (id, expiresMs) => card(id, 'wezbridge', 'running', 'eve:JOB-77', expiresMs);

test('W5: parseOwner entiende eve:<jobId>', () => {
  assert.deepStrictEqual(parseOwner('eve:JOB-77'), { executor: 'eve', jobId: 'JOB-77' });
  assert.deepStrictEqual(parseOwner('pane-33 (wezbridge)'), { paneId: 33 });
  assert.strictEqual(parseOwner('quien sabe'), null);
});

test('W5: owner eve VIVO (liveness true) => cero hallazgos, aunque no exista pane', () => {
  const tasks = [eveCard('T-0301', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW, { executorLiveness: () => true });
  assert.deepStrictEqual(out, [], 'un job sano no puede producir hallazgo por no tener pane');
});

test('W5: owner eve MUERTO (liveness false) => dead-owner-lease que nombra el job', () => {
  const tasks = [eveCard('T-0302', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW, { executorLiveness: () => false });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'dead-owner-lease');
  assert.strictEqual(out[0].id, 'T-0302');
  assert.match(out[0].why, /JOB-77/, 'sin el jobId nadie puede ir a mirar el job');
  assert.match(out[0].why, /no vive/);
});

test('W5: sin funcion de liveness => lease-owner-unverifiable, JAMAS "sano"', () => {
  const tasks = [eveCard('T-0303', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].category, 'lease-owner-unverifiable');
  assert.match(out[0].why, /JOB-77/);
});

test('W5: liveness que devuelve undefined tampoco es vida', () => {
  const tasks = [eveCard('T-0304', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW, { executorLiveness: () => undefined });
  assert.strictEqual(out[0].category, 'lease-owner-unverifiable');
});

test('W5: una liveness que EXPLOTA no puede tumbar el barrido — unverifiable', () => {
  const tasks = [eveCard('T-0305', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW, { executorLiveness: () => { throw new Error('FO caido'); } });
  assert.strictEqual(out[0].category, 'lease-owner-unverifiable');
});

test('W5: el owner eve se reconcilia aunque el censo de WezTerm no exista', () => {
  const tasks = [eveCard('T-0306', NOW + 20 * H)];
  const out = reconcileLeases(tasks, CENSUS_OK, NOW, { executorLiveness: (job) => job === 'JOB-77' });
  assert.deepStrictEqual(out, []);
});

// ---------------------------------------------------------------------------
// T31 check 8 (live, 2026-09-01): el steward en produccion no tenia forma de saber
// si un job de Eve vive y clasificaba TODA lease eve:<job> como unverifiable. El
// control plane expone GET /api/jobs/<id> sin auth: de ahi sale la vivacidad.
// ---------------------------------------------------------------------------
test('T31: classifyEveStatus — vivo mientras el job esta en curso; muerto en terminal; undefined si no se sabe', () => {
  const { classifyEveStatus } = require('../scripts/lease-reconcile.cjs');
  for (const s of ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_INPUT', 'APPROVED']) assert.equal(classifyEveStatus(s), true, s);
  for (const s of ['BLOCKED', 'FAILED', 'CANCELLED', 'SUCCEEDED', 'COMPLETED']) assert.equal(classifyEveStatus(s), false, s);
  assert.equal(classifyEveStatus(undefined), undefined);
  assert.equal(classifyEveStatus('WHATEVER_NEW'), undefined, 'un estado desconocido no es vida ni muerte');
});

test('T31: eveLivenessFromControlPlane — usa el fetcher inyectado; control plane mudo o JSON roto => undefined (unverifiable), nunca "sano"', () => {
  const { eveLivenessFromControlPlane } = require('../scripts/lease-reconcile.cjs');
  const seen = [];
  const fetcher = (url) => { seen.push(url); if (url.endsWith('JOB-live')) return JSON.stringify({ job: { status: 'RUNNING' } }); if (url.endsWith('JOB-dead')) return JSON.stringify({ job: { status: 'BLOCKED' } }); if (url.endsWith('JOB-garbage')) return '<html>'; throw new Error('ECONNREFUSED'); };
  const liveness = eveLivenessFromControlPlane({ baseUrl: 'http://cp:3100', fetcher });
  assert.equal(liveness('JOB-live'), true);
  assert.equal(liveness('JOB-dead'), false);
  assert.equal(liveness('JOB-garbage'), undefined);
  assert.equal(liveness('JOB-down'), undefined);
  assert.ok(seen.every((u) => u.startsWith('http://cp:3100/api/jobs/JOB-')), JSON.stringify(seen));
});
