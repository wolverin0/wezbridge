'use strict';
// result-promotes-review.test.cjs — W2/check 7: un a2a.result MUEVE la tarjeta.
// running -> review con evidencia que apunta a la linea exacta de
// a2a-results.jsonl; FAILED -> failed; BLOCKED -> blocked con el motivo; NUNCA
// done. Todo lo que no se puede ligar sale como evento result.unlinked con
// razon nombrada. Idempotente por linea y jamas tira: el linker corre en el
// camino de respuesta de a2a_send.
// Depende de companions (_docs-curation/ledger.cjs es el FSM real).
const { guardCompanions } = require('./helpers/companions.cjs');
if (!guardCompanions(module, ['_docs-curation', '_intel'])) return;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LEDGER = path.join(__dirname, '..', '..', '_docs-curation', 'ledger.cjs');
const REAL_KINDS = path.join(__dirname, '..', '..', '_intel', 'kinds.json');
const linker = require('../src/result-linker.cjs');

function sandbox(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'result-link-'));
  fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(tmp, 'kinds.json'));
  try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function card(intel, id, over = {}) {
  const c = {
    id, title: 'tarjeta de prueba', goal: 'algo', kind: 'general', repo: 'wezbridge',
    state: 'running', blocked_by: 'agent', acceptance_criteria: ['medible'], lease: null,
    attempt: 1, corr: null, state_changed_at: '2026-09-01T00:00:00.000Z', ...over,
  };
  fs.writeFileSync(path.join(intel, 'tasks', `${id}.json`), JSON.stringify(c, null, 2));
  return c;
}

const readTasksFrom = (intel) => () => fs.readdirSync(path.join(intel, 'tasks'))
  .filter((f) => /^T-\d{4}\.json$/.test(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', f), 'utf8')));

const ledgerRunner = (intel, calls) => (args) => {
  if (calls) calls.push(args);
  return execFileSync(process.execPath, [LEDGER, ...args], {
    encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel }, timeout: 20000,
  });
};

const read = (intel, id) => JSON.parse(fs.readFileSync(path.join(intel, 'tasks', `${id}.json`), 'utf8'));

const line = (over = {}) => ({
  time: '2026-09-01T12:00:00.000Z',
  event: 'a2a.result',
  corr: 'T-0301:x:20260901',
  from_pane: 7,
  to_pane: 0,
  v2: 'ok',
  body: 'FinalOrchestra JOB-1: COMPLETED\ncriteria:\n- algo: pass — 88/88\nfiles_changed: src/x.cjs\nnext_action: revisar',
  ...over,
});

test('W2: un result v2=ok sobre una tarjeta running la mueve a REVIEW, nunca a done', () => {
  sandbox((intel) => {
    card(intel, 'T-0301', { corr: 'T-0301:x:20260901' });
    const calls = [];
    const events = [];
    const r = linker.link(line(), {
      runLedger: ledgerRunner(intel, calls),
      readTasks: readTasksFrom(intel),
      recordEvent: (e) => events.push(e),
    });
    assert.equal(r.linked, true, 'el result tiene que ligar');
    assert.equal(r.to, 'review');
    const after = read(intel, 'T-0301');
    assert.equal(after.state, 'review');
    assert.notEqual(after.state, 'done', 'never promotes to done: el juicio del cierre es del operador');
    assert.match(after.evaluator_evidence, /a2a-results\.jsonl#time=2026-09-01T12:00:00\.000Z/,
      'la evidencia tiene que apuntar a la linea exacta, no a "llego un result"');
    assert.match(after.evaluator_evidence, /corr=T-0301:x:20260901/);
    assert.match(after.evaluator_evidence, /from=pane-7/);
    assert.match(after.evaluator_evidence, /v2=ok/);
    assert.equal(after.corr, 'T-0301:x:20260901');
    assert.deepEqual(events, [], 'una ligadura exitosa no emite result.unlinked');
    const args = calls[0];
    assert.equal(args[0], 'update');
    assert.equal(args[1], 'T-0301');
    assert.equal(args[args.indexOf('--state') + 1], 'review');
    assert.ok(!args.includes('done'), 'ningun argumento puede decir done');
  });
});

test('W2: verdict FAILED mueve a failed; BLOCKED mueve a blocked con el motivo como blocker', () => {
  sandbox((intel) => {
    card(intel, 'T-0302', { corr: 'c-failed' });
    linker.link(line({ corr: 'c-failed', body: 'FinalOrchestra JOB-2: FAILED\ncriteria:\n- algo: fail — timeout' }), {
      runLedger: ledgerRunner(intel), readTasks: readTasksFrom(intel), recordEvent: () => {},
    });
    assert.equal(read(intel, 'T-0302').state, 'failed');

    card(intel, 'T-0303', { corr: 'c-blocked' });
    linker.link(line({
      corr: 'c-blocked',
      body: 'FinalOrchestra JOB-3: BLOCKED\nfalta la key de prod para seguir\ncriteria:\n- algo: fail — sin key',
    }), { runLedger: ledgerRunner(intel), readTasks: readTasksFrom(intel), recordEvent: () => {} });
    const b = read(intel, 'T-0303');
    assert.equal(b.state, 'blocked');
    assert.equal(b.blocked_by, 'agent');
    assert.match(b.blocker, /falta la key de prod/, 'el blocker tiene que decir QUE falta, no "bloqueado"');
  });
});

test('W2: ligar la MISMA linea dos veces es no-op y no emite hallazgo', () => {
  sandbox((intel) => {
    card(intel, 'T-0304', { corr: 'c-idem' });
    const l = line({ corr: 'c-idem' });
    const events = [];
    const opts = () => ({
      runLedger: ledgerRunner(intel),
      readTasks: readTasksFrom(intel),
      recordEvent: (e) => events.push(e),
    });
    const first = linker.link(l, opts());
    const second = linker.link(l, opts());
    assert.equal(first.linked, true);
    assert.equal(second.linked, false);
    assert.equal(second.noop, true, 'la segunda pasada del cursor no puede volver a mover ni a quejarse');
    assert.equal(read(intel, 'T-0304').state, 'review');
    assert.deepEqual(events, [], 'un re-link no es un hallazgo del steward');
  });
});

test('W2: cada caso no-ligable sale como result.unlinked con razon nombrada, sin tocar el ledger', () => {
  sandbox((intel) => {
    card(intel, 'T-0305', { corr: 'dup' });
    card(intel, 'T-0306', { corr: 'dup' });
    card(intel, 'T-0307', { corr: null, state: 'queued' });
    const boom = () => { throw new Error('el ledger no se toca en estos casos'); };
    const cases = [
      [{ corr: 'dup' }, 'ambiguous'],
      [{ corr: 'T-0307' }, 'state=queued'],
      [{ corr: 'T-9999:x:20260901' }, 'no-card'],
      [{ corr: 'charla-suelta' }, 'no-task-corr'],
      [{ corr: 'T-0301', v2: 'partial' }, 'v2=partial'],
      [{ corr: 'T-0301', v2: 'missing' }, 'v2=missing'],
    ];
    for (const [over, reason] of cases) {
      const events = [];
      const r = linker.link(line(over), {
        runLedger: boom, readTasks: readTasksFrom(intel), recordEvent: (e) => events.push(e),
      });
      assert.equal(r.linked, false, `${reason}: no debe ligar`);
      assert.equal(events.length, 1, `${reason}: exactamente un evento`);
      assert.equal(events[0].event, 'result.unlinked');
      assert.equal(events[0].reason, reason);
      assert.equal(events[0].corr, over.corr);
    }
  });
});

test('W2: un ledger que explota sale como ledger-error y el linker JAMAS tira', () => {
  sandbox((intel) => {
    card(intel, 'T-0308', { corr: 'c-boom' });
    const events = [];
    let r;
    assert.doesNotThrow(() => {
      r = linker.link(line({ corr: 'c-boom' }), {
        runLedger: () => { throw new Error('ENOENT ledger.cjs'); },
        readTasks: readTasksFrom(intel),
        recordEvent: (e) => events.push(e),
      });
    }, 'el linker corre en el camino de respuesta de a2a_send: no puede tumbar un envio');
    assert.equal(r.linked, false);
    assert.equal(events[0].reason, 'ledger-error');
  });
});

test('W2: resolveCardForCorr prefiere el corr EXACTO y cae al prefijo T-id', () => {
  sandbox((intel) => {
    card(intel, 'T-0310', { corr: 'T-0311:otro:20260901' });   // corr exacto de OTRA tarjeta
    card(intel, 'T-0311', { corr: null });
    const byExact = linker.resolveCardForCorr('T-0311:otro:20260901', readTasksFrom(intel));
    assert.equal(byExact.card.id, 'T-0310', 'el corr declarado gana sobre el parecido del id');
    const byPrefix = linker.resolveCardForCorr('T-0311:sin-declarar:20260901', readTasksFrom(intel));
    assert.equal(byPrefix.card.id, 'T-0311');
  });
});

// ── el cursor: scripts/result-link.cjs --once ──────────────────────────────

const SCRIPT = path.join(__dirname, '..', 'scripts', 'result-link.cjs');
const CURATION = path.join(__dirname, '..', '..', '_docs-curation');

function sandboxRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'result-link-cli-'));
  const intel = path.join(root, '_intel');
  const curation = path.join(root, '_docs-curation');
  fs.mkdirSync(path.join(intel, 'tasks'), { recursive: true });
  fs.mkdirSync(curation, { recursive: true });
  fs.copyFileSync(REAL_KINDS, path.join(intel, 'kinds.json'));
  fs.copyFileSync(path.join(CURATION, 'ledger.cjs'), path.join(curation, 'ledger.cjs'));
  fs.copyFileSync(path.join(CURATION, 'sweeper-config.json'), path.join(curation, 'sweeper-config.json'));
  try { return fn(intel); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const appendResult = (intel, over) => fs.appendFileSync(
  path.join(intel, 'a2a-results.jsonl'), `${JSON.stringify(line(over))}
`,
);

const runOnce = (intel) => execFileSync(process.execPath, [SCRIPT, '--once'], {
  encoding: 'utf8', env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel }, timeout: 30000,
});

test('W2: el cursor arranca en EOF — la primera corrida NO re-liga el historial', () => {
  sandboxRoot((intel) => {
    card(intel, 'T-0320', { corr: 'c-viejo' });
    appendResult(intel, { corr: 'c-viejo', time: '2026-08-30T10:00:00.000Z' });
    const out = runOnce(intel);
    assert.match(out, /0 new/, out);
    assert.equal(read(intel, 'T-0320').state, 'running',
      'las lineas anteriores al primer arranque son historia: re-ligarlas moveria 300 tarjetas de golpe');
  });
});

test('W2: la corrida siguiente liga SOLO lo nuevo y la tercera no hace nada', () => {
  sandboxRoot((intel) => {
    card(intel, 'T-0321', { corr: 'c-nuevo' });
    runOnce(intel);                                   // siembra el cursor en EOF (archivo ausente)
    appendResult(intel, { corr: 'c-nuevo', time: '2026-09-01T13:00:00.000Z' });
    const second = runOnce(intel);
    assert.match(second, /1 new/, second);
    assert.match(second, /1 linked/, second);
    assert.equal(read(intel, 'T-0321').state, 'review');
    const third = runOnce(intel);
    assert.match(third, /0 new/, third);
  });
});

test('W2: un archivo truncado reinicia el cursor en vez de saltearse lineas para siempre', () => {
  sandboxRoot((intel) => {
    card(intel, 'T-0322', { corr: 'c-rot' });
    appendResult(intel, { corr: 'c-otro', time: '2026-09-01T13:00:00.000Z' });
    runOnce(intel);
    fs.writeFileSync(path.join(intel, 'a2a-results.jsonl'), '');   // rotacion
    appendResult(intel, { corr: 'c-rot', time: '2026-09-01T14:00:00.000Z' });
    const out = runOnce(intel);
    assert.match(out, /1 new/, out);
    assert.equal(read(intel, 'T-0322').state, 'review');
  });
});
