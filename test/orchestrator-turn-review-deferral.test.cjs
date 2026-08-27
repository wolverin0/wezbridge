'use strict';
/**
 * T-0288 — el trigger de `review` tiene que respetar los rulings.
 *
 * QUE CORRIGE. `reviewCount()` contaba tarjetas en state=review y nunca abria
 * rulings.jsonl, asi que una deferral vigente —el mecanismo que la propia
 * rutina define para parkear algo a proposito— no suprimia nada. Medido: los
 * turnos de 22:00Z, 00:00Z, 02:00Z y 04:00Z del 27-08 fueron despertados los
 * cuatro por T-0207, deferred hasta las 12:30Z desde las 20:12Z.
 *
 * LA ASIMETRIA ERA EL BUG: steward-gate SI lee rulings y daba GREEN sobre el
 * mismo ledger. Dos autoridades sobre un mismo archivo, y el orquestador
 * obedecia a la que no lo leia.
 *
 * DIRECCION DE FALLA (doctrina T-0268): ante cualquier duda, DESPERTAR. La
 * supresion solo ocurre con un `until` explicito en el futuro; todo lo demas
 * —archivo ausente, corrupto, ruling desconocido, until vencido— poquea.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reviewWakeTargets, reviewTargetsIn, classifyWake } = require('../scripts/orchestrator-turn.cjs');

const NOW = Date.parse('2026-08-27T04:00:00Z');
const FUTURE = '2026-08-27T12:30:00Z';
const PAST = '2026-08-27T02:00:00Z';

const review = (id) => ({ id, state: 'review' });
const deferral = (task, until, category = 'review') => ({
  task, category, ruling: 'deferred', until, at: '2026-08-26T20:12:00Z',
});

// --- AC1: deferral vigente => NO despierta (fail-first) ---------------------
test('AC1: una tarjeta en review con deferral vigente no genera wake', () => {
  const targets = reviewWakeTargets({
    tasks: [review('T-0207')],
    rulings: [deferral('T-0207', FUTURE)],
    now: NOW,
  });
  assert.deepStrictEqual(targets, [], 'una deferral con until en el futuro tiene que silenciar el trigger');

  const { wake, classes } = classifyWake({ gateExit: 0, reviewTasks: targets });
  assert.strictEqual(wake, false, 'sin otra razon, no hay que gastar un turno');
  assert.deepStrictEqual(classes, []);
});

// --- AC2: la supresion caduca sola -----------------------------------------
test('AC2: la misma tarjeta con el until vencido si genera wake', () => {
  assert.deepStrictEqual(
    reviewWakeTargets({ tasks: [review('T-0207')], rulings: [deferral('T-0207', PAST)], now: NOW }),
    ['T-0207'],
    'nadie tiene que acordarse de levantar la supresion: vence sola',
  );
});

// --- AC3: trabajo no juzgado nunca se suprime ------------------------------
test('AC3: una tarjeta en review sin ningun ruling genera wake siempre', () => {
  assert.deepStrictEqual(
    reviewWakeTargets({ tasks: [review('T-0299')], rulings: [], now: NOW }),
    ['T-0299'],
  );
  // Un ruling de OTRA tarjeta no la cubre.
  assert.deepStrictEqual(
    reviewWakeTargets({ tasks: [review('T-0299')], rulings: [deferral('T-0207', FUTURE)], now: NOW }),
    ['T-0299'],
  );
});

// --- AC4: FAIL-OPEN (doctrina T-0268) --------------------------------------
test('AC4: rulings ilegibles => despierta igual (fail-open)', () => {
  for (const broken of [null, undefined, 'no soy un array', 42]) {
    assert.deepStrictEqual(
      reviewWakeTargets({ tasks: [review('T-0207')], rulings: broken, now: NOW }),
      ['T-0207'],
      `rulings=${JSON.stringify(broken)} tiene que poquear, no silenciar`,
    );
  }
});

test('AC4: una deferral sin until, o con until impresentable, no silencia nada', () => {
  for (const until of [undefined, '', 'manana', 'NaN']) {
    assert.deepStrictEqual(
      reviewWakeTargets({ tasks: [review('T-0207')], rulings: [deferral('T-0207', until)], now: NOW }),
      ['T-0207'],
      `until=${JSON.stringify(until)} es un encogimiento de hombros, no una deferral`,
    );
  }
});

test('AC4: un ruling que no es deferred no silencia el trigger de review', () => {
  for (const word of ['dispatched', 'resolved', 'cancelled', 'operator-gated', 'inventado']) {
    assert.deepStrictEqual(
      reviewWakeTargets({
        tasks: [review('T-0207')],
        rulings: [{ task: 'T-0207', category: 'review', ruling: word, at: '2026-08-27T03:00:00Z' }],
        now: NOW,
      }),
      ['T-0207'],
      `${word} no es una deferral: si la tarjeta sigue en review, hay algo que juzgar`,
    );
  }
});

test('AC4: la deferral tiene que ser de la categoria review', () => {
  assert.deepStrictEqual(
    reviewWakeTargets({ tasks: [review('T-0207')], rulings: [deferral('T-0207', FUTURE, 'idle')], now: NOW }),
    ['T-0207'],
    'una deferral escrita para otra situacion no cubre esta',
  );
  // Sin categoria: cubre, mismo criterio laxo que steward-gate.
  assert.deepStrictEqual(
    reviewWakeTargets({
      tasks: [review('T-0207')],
      rulings: [{ task: 'T-0207', ruling: 'deferred', until: FUTURE }],
      now: NOW,
    }),
    [],
  );
});

/**
 * ESPEJA A steward-gate, A PROPOSITO — y esto lo escribo porque mi primera
 * version del test asumia otra cosa y estaba mal.
 *
 * Asumi "la ultima linea gana" en sentido estricto: que una deferral vencida
 * apendeada despues de una vigente la revocaba. No es lo que hace el gate.
 * `evaluate()` toma las lineas aplicables y busca la ULTIMA QUE TODAVIA CUBRE
 * (`.reverse().find(rulingCovers)`), asi que una deferral viva sigue cubriendo
 * aunque haya lineas posteriores que no cubran.
 *
 * Copiar esa semantica no es pereza: AC6 dice que el gate es la autoridad sobre
 * rulings, y T-0288 existe JUSTAMENTE porque habia dos autoridades leyendo el
 * mismo archivo con criterios distintos. Endurecer aca —aunque despertaria mas,
 * que es la direccion segura— reintroduce la asimetria con otro signo.
 */
test('espeja al gate: una deferral viva cubre aunque haya lineas posteriores', () => {
  assert.deepStrictEqual(
    reviewWakeTargets({
      tasks: [review('T-0207')],
      rulings: [deferral('T-0207', FUTURE), deferral('T-0207', PAST)],
      now: NOW,
    }),
    [],
    'mismo criterio que rulingCovers: alcanza con que UNA linea aplicable siga cubriendo',
  );
  // Y una deferral vencida que despues se extiende vuelve a silenciar.
  assert.deepStrictEqual(
    reviewWakeTargets({
      tasks: [review('T-0207')],
      rulings: [deferral('T-0207', PAST), deferral('T-0207', FUTURE)],
      now: NOW,
    }),
    [],
  );
  // Con TODAS vencidas no hay nada que cubra: despierta.
  assert.deepStrictEqual(
    reviewWakeTargets({
      tasks: [review('T-0207')],
      rulings: [deferral('T-0207', PAST), deferral('T-0207', '2026-08-27T03:00:00Z')],
      now: NOW,
    }),
    ['T-0207'],
  );
});

test('solo mira tarjetas en review: otros estados no entran al trigger', () => {
  assert.deepStrictEqual(
    reviewWakeTargets({
      tasks: [{ id: 'T-0300', state: 'ready' }, { id: 'T-0301', state: 'done' }, review('T-0302')],
      rulings: [],
      now: NOW,
    }),
    ['T-0302'],
  );
});

// --- AC5: el motivo nombra QUE tarjetas ------------------------------------
test('AC5: el motivo del wake nombra las tarjetas, no solo un conteo', () => {
  const { reasons, wake } = classifyWake({ gateExit: 0, reviewTasks: ['T-0207', 'T-0299'] });
  assert.strictEqual(wake, true);
  assert.strictEqual(reasons.length, 1);
  assert.match(reasons[0], /T-0207/, 'el turno no tiene que redescubrir cual tarjeta lo desperto');
  assert.match(reasons[0], /T-0299/);
  // El board clasifica por esta subcadena; si se pierde, el histograma se rompe.
  assert.match(reasons[0], /in review with finished work/);
});

test('classifyWake sigue aceptando reviewCount numerico (records viejos)', () => {
  const r = classifyWake({ gateExit: 0, reviewCount: 2 });
  assert.deepStrictEqual(r.classes, ['results-directed']);
  assert.match(r.reasons[0], /2 task\(s\) in review with finished work/);
});

// --- AC7: fixtures propias en tmp, nunca una tarjeta viva ------------------
test('AC7: el trigger completo corre contra un _intel de tmp, no contra el ledger real', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't0288-'));
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 'A-1.json'), JSON.stringify({ id: 'A-1', state: 'review' }));
  fs.writeFileSync(path.join(dir, 'tasks', 'A-2.json'), JSON.stringify({ id: 'A-2', state: 'review' }));
  fs.writeFileSync(path.join(dir, 'tasks', 'A-3.json'), JSON.stringify({ id: 'A-3', state: 'ready' }));
  fs.writeFileSync(
    path.join(dir, 'rulings.jsonl'),
    JSON.stringify(deferral('A-1', FUTURE)) + '\n{ esto no es json }\n',
  );

  // A-1 silenciada por su deferral; A-2 no; A-3 no esta en review.
  // La linea corrupta se saltea sin tumbar la lectura: las demas siguen valiendo.
  assert.deepStrictEqual(reviewTargetsIn(dir, NOW), ['A-2']);

  // Sin rulings.jsonl: fail-open, las dos despiertan.
  fs.unlinkSync(path.join(dir, 'rulings.jsonl'));
  assert.deepStrictEqual(reviewTargetsIn(dir, NOW), ['A-1', 'A-2']);

  fs.rmSync(dir, { recursive: true, force: true });
});
