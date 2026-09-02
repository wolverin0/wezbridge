'use strict';
/**
 * T-0322 — identidad de panes por ROL (opcion A): registro por sesion + poke-pane --role.
 * (La tarjeta pedia test/pane-identity.test.cjs; ese archivo ya existe y prueba OTRO modulo,
 *  pane-identity.cjs = proyecto -> pane por cwd/alias. El registro por rol vive en
 *  src/pane-registry.cjs y sus tests aca.)
 *  AC1 el hook SessionStart escribe <registro>/<WEZTERM_PANE>.json con los 6 campos (env falso).
 *  AC2 unicidad: un segundo role igual en el mismo cwd desde OTRO pane vivo falla con mensaje y no pisa.
 *  AC3 resolveRole valida contra el mux y falla cerrado: pane muerto, cwd distinto, pid muerto, ambiguo;
 *      poke-pane --role mapea eso a exit 11 (contrato leido del fuente).
 *  AC5 vivo (se salta sin wezterm): un pane real registra su rol desde adentro, poke-pane --role le
 *      entrega verificado, y al morir el pane el registro se limpia solo.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const reg = require('../src/pane-registry.cjs');
const REPO = path.join(__dirname, '..');
const HOOK = path.join(REPO, 'scripts', 'pane-register-hook.cjs');
const POKE = path.join(REPO, 'scripts', 'poke-pane.cjs');

const tmpReg = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pane-reg-'));
const CWD_URL = 'file:///G:/_OneDrive/OneDrive/Desktop/Py%20Apps/whatsappbot-prod%20-%20Copy%20-%20Copy/whatsappbot-final/';
const CWD_WIN = 'G:\\_OneDrive\\OneDrive\\Desktop\\Py Apps\\whatsappbot-prod - Copy - Copy\\whatsappbot-final';
const alive = () => true;
const dead = () => false;

function runHook(env, payload, extra = []) {
  return spawnSync(process.execPath, [HOOK, ...extra], {
    input: payload === undefined ? '' : JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '1', ...env },
  });
}
const readEntry = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));

test('normalizeCwd: la URL file:// del mux y la ruta Windows del hook son el mismo cwd; projectOf saca la ruta bajo Py Apps', () => {
  assert.equal(reg.normalizeCwd(CWD_URL), reg.normalizeCwd(CWD_WIN));
  assert.equal(reg.projectOf(CWD_WIN), 'whatsappbot-prod - Copy - Copy/whatsappbot-final');
  assert.equal(reg.projectOf('C:/x/doctor'), 'doctor');
});

test('AC1 hook SessionStart con env falso escribe <WEZTERM_PANE>.json con role, project, cwd, pid, agent, started_at; SessionEnd lo borra', () => {
  const dir = tmpReg();
  const list = JSON.stringify([{ pane_id: 77, cwd: CWD_URL }]);
  const r = runHook({ WEZTERM_PANE: '77', WEZBRIDGE_PANE_REGISTRY: dir, WEZBRIDGE_ROLE: 'wabotclaude', WEZBRIDGE_PANE_LIST_JSON: list },
    { cwd: CWD_WIN, hook_event_name: 'SessionStart', source: 'startup', session_id: 'abc' });
  assert.equal(r.status, 0, r.stderr);
  const e = readEntry(dir, 77);
  for (const f of reg.FIELDS) assert.ok(f in e, `falta el campo ${f}`);
  assert.equal(e.role, 'wabotclaude');
  assert.equal(e.project, 'whatsappbot-prod - Copy - Copy/whatsappbot-final');
  assert.equal(e.cwd, CWD_WIN);
  assert.equal(e.agent, 'claude');
  assert.ok(Number.isInteger(e.pid) && e.pid > 0, 'pid = la sesion (ppid del hook)');
  assert.ok(Number.isFinite(Date.parse(e.started_at)));
  const again = runHook({ WEZTERM_PANE: '77', WEZBRIDGE_PANE_REGISTRY: dir, WEZBRIDGE_ROLE: 'wabotclaude', WEZBRIDGE_PANE_LIST_JSON: list },
    { cwd: CWD_WIN, hook_event_name: 'SessionStart', source: 'resume' });
  assert.equal(again.status, 0, `resume re-registra el MISMO pane sin quejarse: ${again.stderr}`);
  const none = runHook({ WEZTERM_PANE: '', WEZBRIDGE_PANE_REGISTRY: dir }, { cwd: CWD_WIN, hook_event_name: 'SessionStart' });
  assert.equal(none.status, 0, 'sin WEZTERM_PANE no es un pane: no escribe y no falla');
  const end = runHook({ WEZTERM_PANE: '77', WEZBRIDGE_PANE_REGISTRY: dir }, { cwd: CWD_WIN, hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(end.status, 0);
  assert.equal(fs.existsSync(path.join(dir, '77.json')), false, 'SessionEnd limpia el registro');
});

test('AC1 rol: --role > $WEZBRIDGE_ROLE > .wezbridge-role > basename(cwd)', () => {
  const { roleFor } = require('../scripts/pane-register-hook.cjs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'role-'));
  const saved = process.env.WEZBRIDGE_ROLE; delete process.env.WEZBRIDGE_ROLE;
  try {
    assert.equal(roleFor(d, 'explicito'), 'explicito');
    assert.equal(roleFor(d), path.basename(d).toLowerCase());
    fs.writeFileSync(path.join(d, '.wezbridge-role'), 'infra\n');
    assert.equal(roleFor(d), 'infra');
    process.env.WEZBRIDGE_ROLE = 'porenv';
    assert.equal(roleFor(d), 'porenv');
  } finally { if (saved === undefined) delete process.env.WEZBRIDGE_ROLE; else process.env.WEZBRIDGE_ROLE = saved; }
});

test('AC2 unicidad: registrar el mismo role+cwd desde OTRO pane vivo falla con mensaje y NO pisa el registro anterior; un competidor muerto se limpia y deja pasar', () => {
  const dir = tmpReg();
  const list = [{ pane_id: 77, cwd: CWD_URL }, { pane_id: 78, cwd: CWD_URL }];
  const first = reg.register({ role: 'wabotclaude', cwd: CWD_WIN, pid: process.pid, agent: 'claude', paneId: 77, list, dir });
  assert.equal(first.ok, true);
  assert.throws(() => reg.register({ role: 'wabotclaude', cwd: CWD_WIN, pid: process.pid, agent: 'claude', paneId: 78, list, dir }),
    /already held by a LIVE pane 77/);
  assert.equal(readEntry(dir, 77).role, 'wabotclaude', 'el registro anterior sigue intacto');
  assert.equal(fs.existsSync(path.join(dir, '78.json')), false, 'el segundo no se escribio');
  const r = runHook({ WEZTERM_PANE: '78', WEZBRIDGE_PANE_REGISTRY: dir, WEZBRIDGE_ROLE: 'wabotclaude', WEZBRIDGE_PANE_LIST_JSON: JSON.stringify(list) },
    { cwd: CWD_WIN, hook_event_name: 'SessionStart', source: 'startup' });
  assert.notEqual(r.status, 0, 'por el hook: exit != 0');
  assert.match(r.stderr, /already held by a LIVE pane 77/);
  assert.equal(fs.existsSync(path.join(dir, '78.json')), false);
  const other = reg.register({ role: 'wabotclaude', cwd: 'C:/otro', pid: process.pid, agent: 'claude', paneId: 79, list: [...list, { pane_id: 79, cwd: 'file:///C:/otro' }], dir });
  assert.equal(other.ok, true, 'otro cwd con el mismo role no compite');
  fs.writeFileSync(path.join(dir, '77.json'), JSON.stringify({ role: 'wabotclaude', project: 'x', cwd: CWD_WIN, pid: 999999, agent: 'claude', started_at: '2026-09-01T00:00:00Z' }));
  const replaced = reg.register({ role: 'wabotclaude', cwd: CWD_WIN, pid: process.pid, agent: 'claude', paneId: 78, list, dir });
  assert.equal(replaced.ok, true, 'competidor con pid muerto: se limpia solo y el nuevo entra');
  assert.equal(fs.existsSync(path.join(dir, '77.json')), false, 'el registro del pane muerto se borro');
});

test('AC3 resolveRole valida contra el mux y falla CERRADO con causa: pane muerto, cwd distinto, pid muerto, ambiguo; los muertos se limpian solos', () => {
  const dir = tmpReg();
  const entry = { role: 'infra', project: 'infra', cwd: 'G:/Py Apps/infra', pid: process.pid, agent: 'claude', started_at: '2026-09-02T20:00:00Z' };
  fs.writeFileSync(path.join(dir, '9.json'), JSON.stringify(entry));
  const ok = reg.resolveRole('infra', { list: [{ pane_id: 9, cwd: 'file:///G:/Py%20Apps/infra/' }], dir, pidAlive: alive });
  assert.equal(ok.ok, true); assert.equal(ok.paneId, 9);
  const missing = reg.resolveRole('infra', { list: [{ pane_id: 10, cwd: 'file:///G:/Py%20Apps/infra/' }], dir, pidAlive: alive });
  assert.equal(missing.ok, false); assert.equal(missing.reason, 'pane-missing');
  assert.equal(fs.existsSync(path.join(dir, '9.json')), false, 'pane muerto => registro borrado');
  fs.writeFileSync(path.join(dir, '9.json'), JSON.stringify(entry));
  const moved = reg.resolveRole('infra', { list: [{ pane_id: 9, cwd: 'file:///G:/Py%20Apps/' }], dir, pidAlive: alive });
  assert.equal(moved.ok, false); assert.equal(moved.reason, 'cwd-mismatch');
  assert.equal(fs.existsSync(path.join(dir, '9.json')), true, 'cwd distinto con pane vivo: se reporta, no se borra');
  const deadPid = reg.resolveRole('infra', { list: [{ pane_id: 9, cwd: 'file:///G:/Py%20Apps/infra/' }], dir, pidAlive: dead });
  assert.equal(deadPid.ok, false); assert.equal(deadPid.reason, 'pid-dead');
  assert.equal(fs.existsSync(path.join(dir, '9.json')), false, 'pid muerto (shell huerfano) => registro borrado');
  fs.writeFileSync(path.join(dir, '9.json'), JSON.stringify(entry));
  fs.writeFileSync(path.join(dir, '12.json'), JSON.stringify({ ...entry, cwd: 'G:/Py Apps/infra2' }));
  const amb = reg.resolveRole('infra', { list: [{ pane_id: 9, cwd: 'file:///G:/Py%20Apps/infra/' }, { pane_id: 12, cwd: 'file:///G:/Py%20Apps/infra2/' }], dir, pidAlive: alive });
  assert.equal(amb.ok, false); assert.equal(amb.reason, 'ambiguous');
  assert.equal(reg.resolveRole('nadie', { list: [], dir }).reason, 'no-registry');
  assert.equal(reg.resolveRole('infra', { list: null, dir, pidAlive: alive }).reason, 'unverifiable', 'sin listado del mux no se afirma nada');
});

test('AC3 poke-pane --role: resuelve por registro contra el listado mux y muere con 11 si no valida (contrato leido del fuente)', () => {
  const src = fs.readFileSync(POKE, 'utf8');
  assert.match(src, /require\('\.\.\/src\/pane-registry\.cjs'\)/);
  assert.match(src, /resolveRole\(role, \{ list: mux\.map/, 'valida contra los panes del espacio mux, no de la GUI');
  assert.match(src, /if \(!res\.ok\) die\(11,/);
  assert.match(src, /\(!project && !tabTitle && !role\)/, '--role alcanza como selector');
});

// ---------------------------------------------------------------- AC5 live
const WEZTERM = process.env.WEZTERM_BIN || 'wezterm';
function muxEnv() {
  try {
    const sock = require('../src/wezterm.cjs').muxSocketPath();
    if (!sock) return null;
    const env = { ...process.env, WEZTERM_UNIX_SOCKET: sock }; delete env.WEZTERM_PANE; return env;
  } catch { return null; }
}
const cli = (env, a, input) => execFileSync(WEZTERM, ['cli', '--prefer-mux', '--no-auto-start', ...a], { env, encoding: 'utf8', timeout: 20000, windowsHide: true, ...(input !== undefined ? { input } : {}) });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function live() { const env = muxEnv(); if (!env) return null; try { JSON.parse(cli(env, ['list', '--format', 'json'])); return env; } catch { return null; } }

test('AC5 live: un pane real registra su rol desde ADENTRO (hook), poke-pane --role le entrega verificado, y al morir el pane el registro se limpia solo', { skip: !live() && 'wezterm mux no alcanzable' }, () => {
  const env = live();
  const dir = tmpReg();
  const role = `t0322r${Date.now().toString(36)}`;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 't0322live-'));
  fs.copyFileSync(path.join(REPO, 'test', 'fixtures', 'tui-double.cjs'), path.join(proj, 'tui-double.cjs'));
  // Medido: `cmd /k` via wezterm spawn ejecuta un comando INLINE pero no un
  // .cmd (ni relativo ni absoluto), y comillas ADENTRO del argumento (la ruta
  // del hook lleva "Py Apps") hacen que cmd conserve las comillas externas y no
  // ejecute nada. Un shim .cjs en el cwd del pane evita las dos cosas: la ruta
  // con espacios vive dentro del JS, no en la linea de comandos.
  fs.writeFileSync(path.join(proj, 'hook.cjs'), `process.exit(require(${JSON.stringify(HOOK.replace(/\\/g, '/'))}).main());\n`);
  const inline = `set WEZBRIDGE_ROLE=${role}&& set WEZBRIDGE_PANE_REGISTRY=${dir}&& node hook.cjs --agent shell 2> hook.err && node tui-double.cjs`;
  assert.doesNotMatch(inline, /[" ]Py Apps/, 'la linea de comandos no puede llevar rutas con espacios');
  const paneId = cli(env, ['spawn', '--cwd', proj, '--', 'cmd', '/k', inline]).trim();
  assert.match(paneId, /^\d+$/);
  try {
    let entry = null;
    for (let i = 0; i < 30 && !entry; i += 1) { sleep(300); try { entry = readEntry(dir, paneId); } catch { /* not yet */ } }
    assert.ok(entry, `el hook dentro del pane ${paneId} no registro nada en ${dir}`);
    assert.equal(entry.role, role);
    assert.equal(reg.normalizeCwd(entry.cwd), reg.normalizeCwd(proj), 'el cwd registrado es el del pane');
    for (let i = 0; i < 20; i += 1) { if (/❯/.test(cli(env, ['get-text', '--pane-id', paneId, '--start-line', '-8']))) break; sleep(300); }
    const r = spawnSync(process.execPath, [POKE, '--role', role, '--text', 'hola por rol'], { env: { ...env, WEZBRIDGE_PANE_REGISTRY: dir }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `poke-pane --role fallo: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`-> pane ${paneId} `), 'entrego al pane del registro');
    sleep(600);
    const submits = fs.readFileSync(path.join(proj, 'submits.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(submits.length, 1); assert.equal(submits[0].text, 'hola por rol');
    cli(env, ['kill-pane', '--pane-id', paneId]);
    sleep(800);
    const list = JSON.parse(cli(env, ['list', '--format', 'json'])).map((p) => ({ pane_id: p.pane_id, cwd: p.cwd }));
    const after = reg.resolveRole(role, { list, dir });
    assert.equal(after.ok, false);
    assert.ok(['pane-missing', 'pid-dead'].includes(after.reason), after.reason);
    assert.equal(fs.existsSync(path.join(dir, `${paneId}.json`)), false, 'registro de pane muerto limpiado');
    const again = spawnSync(process.execPath, [POKE, '--role', role, '--text', 'x'], { env: { ...env, WEZBRIDGE_PANE_REGISTRY: dir }, encoding: 'utf8', timeout: 60000 });
    assert.equal(again.status, 11, `sin registro valido poke-pane tiene que salir 11: ${again.stdout}`);
  } finally {
    try { cli(env, ['kill-pane', '--pane-id', paneId]); } catch { /* ya muerto */ }
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
