'use strict';
/**
 * pane-census.cjs — lado DAEMON del censo de panes fuera del event loop (T-0321).
 *
 * Arranca src/pane-census-worker.cjs como hijo, guarda el ultimo censo que el
 * hijo manda, y lo vigila: si una llamada wezterm lleva mas de hangMs sin
 * volver, o el hijo se calla del todo, mata el ARBOL de procesos (taskkill /T en
 * Windows, SIGKILL en el resto) y lo relanza con backoff. Cuenta los reinicios y
 * expone `last_cli_call` {name, started_at, age_ms, in_flight} para que el
 * heartbeat diga "colgado en wezterm listPanes desde hace 240 s" en vez de
 * "DAEMON DOWN" (AC3).
 *
 * Config POR ARCHIVO (template service-work: un valor que vive en la sesion
 * muere con ella): `<intel>/pane-census.json` {intervalMs, hangMs}; el env
 * WEZBRIDGE_CENSUS_INTERVAL_MS / WEZBRIDGE_CENSUS_HANG_MS pisa al archivo.
 *
 * Nunca lanza: todo error queda en status().last_error y en el log.
 */
const path = require('node:path');
const fs = require('node:fs');
const { fork, spawnSync } = require('node:child_process');

const DEFAULTS = Object.freeze({
  intervalMs: 20000,  // cada 20 s. Con 9 panes un censo son ~11 procesos wezterm; a 5 s eran ~130/min sobre el mux (medido 04/09: la suite dejo de terminar en 10 min con el daemon vivo al lado). El waker tickea a 60 s y el watchdog a 30 s: 20 s alcanza y sobra.
  hangMs: 45000,      // > 20 s (10 s + 1 reintento de wezCmd) y < los 95 s de heartbeat stale
  silentMs: 120000,   // hijo vivo pero mudo (sin mensajes): tambien se relanza
});
const WORKER = path.join(__dirname, 'pane-census-worker.cjs');
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

function loadCensusConfig({ intelDir, env = process.env } = {}) {
  let file = {};
  if (intelDir) {
    try { file = JSON.parse(fs.readFileSync(path.join(intelDir, 'pane-census.json'), 'utf8')) || {}; }
    catch { file = {}; }
  }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    intervalMs: num(env.WEZBRIDGE_CENSUS_INTERVAL_MS, num(file.intervalMs, DEFAULTS.intervalMs)),
    hangMs: num(env.WEZBRIDGE_CENSUS_HANG_MS, num(file.hangMs, DEFAULTS.hangMs)),
    silentMs: num(env.WEZBRIDGE_CENSUS_SILENT_MS, num(file.silentMs, DEFAULTS.silentMs)),
    source: Object.keys(file).length ? 'file+env' : 'defaults+env',
  };
}

function defaultKillTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ya muerto */ }
  }
}

function startCensus({
  intervalMs = DEFAULTS.intervalMs, hangMs = DEFAULTS.hangMs, silentMs = DEFAULTS.silentMs,
  snapshotIntervalMs = 0, snapshotLogPath = null,
  beaconPath = path.join(require('node:os').tmpdir(), `wezbridge-census-cli-${process.pid}.json`),
  log = () => {}, now = Date.now, forkFn = fork, killTree = defaultKillTree, workerPath = WORKER,
} = {}) {
  const state = {
    worker: null, workerPid: null, startedAt: null,
    panes: [], censusAt: 0, snapshotAt: 0, lastMessageAt: 0,
    restarts: 0, kills: 0, lastError: null, lastKillReason: null,
    stopping: false, respawnTimer: null, watchTimer: null,
  };

  // La llamada CLI en curso NO llega por IPC: process.send necesita el event
  // loop del hijo, y execFileSync lo bloquea, asi que "start" y "end" llegarian
  // juntos cuando ya volvio. El hijo la escribe con writeFileSync en un beacon
  // y aca se lee en frio. `lastCli` = ultimo beacon leido.
  function readBeacon() {
    try {
      const b = JSON.parse(fs.readFileSync(beaconPath, 'utf8'));
      return b && typeof b === 'object' && b.name ? b : null;
    } catch { return null; }
  }
  function currentCli() {
    const b = readBeacon();
    if (!b) return null;
    // Un beacon de un worker anterior ya no dice nada de este.
    if (state.workerPid && b.pid && b.pid !== state.workerPid && !b.endedAt) return { ...b, endedAt: b.startedAt };
    return b;
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    state.lastMessageAt = now();
    switch (msg.t) {
      case 'census':
        state.panes = Array.isArray(msg.panes) ? msg.panes : [];
        state.censusAt = msg.at || now();
        break;
      case 'snapshot': state.snapshotAt = msg.at || now(); break;
      case 'log': log(`pane-census worker: ${msg.message}`); break;
      case 'error': state.lastError = `${msg.where}: ${msg.message}`; log(`pane-census worker error (${msg.where}): ${msg.message}`); break;
      case 'hello': log(`pane-census worker up (pid ${msg.pid}, censo cada ${msg.intervalMs} ms, snapshot cada ${msg.snapshotIntervalMs || 'off'} ms)`); break;
      default: break;
    }
  }

  function spawnWorker() {
    if (state.stopping) return;
    const cfg = { intervalMs, snapshotIntervalMs, snapshotLogPath, beaconPath };
    try { fs.unlinkSync(beaconPath); } catch { /* no habia beacon */ }
    let w;
    try {
      // stderr 'ignore': un pipe abierto es un handle que mantiene vivo al padre;
      // los errores del hijo ya viajan por IPC ({t:'error'}).
      w = forkFn(workerPath, [], {
        env: { ...process.env, WEZBRIDGE_CENSUS_CFG: JSON.stringify(cfg) },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      });
      // El hijo NO debe mantener vivo al padre: un test que carga el daemon en
      // proceso (daemon-liveness, orch-waker-arming) no salia nunca porque el
      // fork y su canal IPC quedaban referenciados (medido 04/09: la suite dejo
      // de terminar). Con unref, el padre sale cuando termina lo suyo y el hijo
      // se va solo al ver 'disconnect'.
      if (typeof w.unref === 'function') w.unref();
      if (w.channel && typeof w.channel.unref === 'function') w.channel.unref();
    } catch (err) {
      state.lastError = `fork: ${err.message}`;
      log(`pane-census: no pude lanzar el worker: ${err.message}`);
      scheduleRespawn();
      return;
    }
    state.worker = w;
    state.workerPid = w.pid;
    state.startedAt = now();
    state.lastMessageAt = now();
    w.on('message', onMessage);
    w.on('error', (err) => { state.lastError = `worker: ${err.message}`; });
    w.on('exit', (code, signal) => {
      if (state.worker !== w) return; // un worker viejo que termino tarde
      state.worker = null;
      if (state.stopping) return;
      log(`pane-census: worker pid ${w.pid} termino (code=${code} signal=${signal}) — relanzo`);
      scheduleRespawn();
    });
  }

  function scheduleRespawn() {
    if (state.stopping || state.respawnTimer) return;
    const delay = BACKOFF_MS[Math.min(state.restarts, BACKOFF_MS.length - 1)];
    state.restarts += 1;
    state.respawnTimer = setTimeout(() => { state.respawnTimer = null; spawnWorker(); }, delay);
    if (state.respawnTimer.unref) state.respawnTimer.unref();
  }

  function killWorker(reason) {
    const w = state.worker;
    if (!w) return;
    state.kills += 1;
    state.lastKillReason = reason;
    log(`pane-census: worker pid ${w.pid} COLGADO (${reason}) — mato el arbol y relanzo`);
    state.worker = null; // el handler de exit del viejo ya no cuenta
    try { killTree(w.pid); } catch (err) { log(`pane-census: killTree fallo: ${err.message}`); }
    scheduleRespawn();
  }

  function watch() {
    if (state.stopping || !state.worker) return;
    const t = now();
    const cli = currentCli();
    if (cli && !cli.endedAt && t - cli.startedAt > hangMs) {
      killWorker(`${cli.name} lleva ${Math.round((t - cli.startedAt) / 1000)} s sin volver`);
      return;
    }
    if (state.lastMessageAt && t - state.lastMessageAt > silentMs) {
      killWorker(`sin mensajes hace ${Math.round((t - state.lastMessageAt) / 1000)} s`);
    }
  }

  function status() {
    const t = now();
    const cli = currentCli();
    return {
      armed: true,
      worker_pid: state.worker ? state.workerPid : null,
      worker_up_ms: state.worker && state.startedAt ? t - state.startedAt : null,
      restarts: state.restarts,
      kills: state.kills,
      last_kill_reason: state.lastKillReason,
      census_panes: state.panes.length,
      census_age_ms: state.censusAt ? t - state.censusAt : null,
      snapshot_age_ms: state.snapshotAt ? t - state.snapshotAt : null,
      last_cli_call: cli ? {
        name: cli.name,
        started_at: new Date(cli.startedAt).toISOString(),
        age_ms: (cli.endedAt || t) - cli.startedAt,
        in_flight: !cli.endedAt,
      } : null,
      last_error: state.lastError,
      config: { intervalMs, hangMs, silentMs, snapshotIntervalMs, beaconPath },
    };
  }

  function stop() {
    state.stopping = true;
    if (state.watchTimer) clearInterval(state.watchTimer);
    if (state.respawnTimer) clearTimeout(state.respawnTimer);
    if (state.worker) { try { killTree(state.worker.pid); } catch { /* best effort */ } }
    state.worker = null;
  }

  spawnWorker();
  state.watchTimer = setInterval(watch, 1000);
  if (state.watchTimer.unref) state.watchTimer.unref();

  return {
    getPanes: () => state.panes,
    status,
    stop,
    _state: state, // tests
  };
}

module.exports = { DEFAULTS, WORKER, loadCensusConfig, startCensus, defaultKillTree };
