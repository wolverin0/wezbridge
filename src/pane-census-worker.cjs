'use strict';
/**
 * pane-census-worker.cjs — el proceso HIJO que ejecuta wezterm de forma
 * sincrona, para que el daemon :4200 nunca lo haga en su event loop (T-0321).
 *
 * POR QUE EXISTE. La medicion de T-0321 AC1 refuto la hipotesis "execFileSync
 * no vuelve": vuelve siempre, respetando el timeout. Lo que congelaba al daemon
 * era que BLOQUEA el event loop mientras espera: wezCmd usa 10 s + 1 reintento
 * por pane, o sea hasta 20 s por pane y 240 s por ciclo con 12 panes. Durante
 * esa ventana el proceso esta vivo, el puerto LISTENING, y ni HTTP ni heartbeat
 * contestan: la firma exacta de los tres episodios (02-09 00:29Z, 02-09 15:10Z,
 * 04-09 15:22Z). Aca ese bloqueo le pasa a ESTE proceso, que no atiende nada.
 *
 * Contrato con el padre (src/pane-census.cjs), por process.send:
 *   (la llamada wezterm en curso NO va por IPC: va por el beacon en archivo, ver abajo)
 *   {t:'census', at, panes}                     el discoverPanes() completo
 *   {t:'snapshot', at, entries}                 un tick de session-snapshot
 *   {t:'log', message} · {t:'error', where, message}
 * Si el padre nos ve colgados en una llamada mas de hangMs, nos mata el arbol
 * (taskkill /T) y relanza: la revival es OBSERVADA por el, no afirmada por nosotros.
 */
const wez = require('./wezterm.cjs');
const { discoverPanes } = require('./pane-discovery.cjs');
const sessionSnapshot = require('./session-snapshot.cjs');

let cfg = {};
try { cfg = JSON.parse(process.env.WEZBRIDGE_CENSUS_CFG || '{}'); } catch { cfg = {}; }
const intervalMs = Math.max(500, Number(cfg.intervalMs) || 5000);
const snapshotIntervalMs = Number(cfg.snapshotIntervalMs) || 0;

function send(msg) {
  try { if (process.send) process.send(msg); } catch { /* padre muerto: el exit lo arregla */ }
}

/**
 * Las llamadas que tocan wezterm se anuncian antes y despues (AC3: last_cli_call).
 * OJO: NO por IPC. process.send es asincrono y necesita el event loop de ESTE
 * proceso para vaciarse, y execFileSync lo bloquea: el padre recibiria "start" y
 * "end" juntos cuando la llamada ya volvio y nunca veria una llamada en curso
 * (medido: 0 kills con listSockets 10 s en vuelo). Se escribe un beacon con
 * writeFileSync, que no depende del loop, y el padre lo lee cada segundo.
 */
const fs = require('node:fs');
const BEACON = cfg.beaconPath || null;
function beacon(obj) {
  if (!BEACON) return;
  try { fs.writeFileSync(BEACON, JSON.stringify(obj)); } catch { /* fail-soft */ }
}
const REPORTED = new Set(['listPanes', 'getFullText', 'getText', 'listSockets', 'currentSocket', 'detectSocketDivergence']);
const wrapped = new Proxy(wez, {
  get(target, key) {
    const v = target[key];
    if (typeof v !== 'function' || !REPORTED.has(key)) return v;
    return (...args) => {
      const name = `wezterm ${key}`;
      const startedAt = Date.now();
      beacon({ name, startedAt, endedAt: null, pid: process.pid });
      try { return v.apply(target, args); }
      finally { beacon({ name, startedAt, endedAt: Date.now(), pid: process.pid }); }
    };
  },
});

let lastSnapshotAt = 0;

function cycle() {
  const started = Date.now();
  let panes = [];
  try {
    panes = discoverPanes({ wez: wrapped }) || [];
    send({ t: 'census', at: Date.now(), panes });
  } catch (err) {
    send({ t: 'error', where: 'discover', message: err.message });
  }
  if (snapshotIntervalMs > 0 && Date.now() - lastSnapshotAt >= snapshotIntervalMs) {
    lastSnapshotAt = Date.now();
    try {
      // Misma logica que tenia el daemon: los titulos de Claude/Codex no dicen
      // "claude"/"codex", asi que el agente detectado por discovery viaja como
      // cmdline_hint (gap del snapshot del 2026-07-02).
      const agentOf = new Map(panes.filter((d) => d && d.agent).map((d) => [d.paneId, d.agent]));
      const listPanes = () => (wrapped.listPanes() || [])
        .map((p) => (agentOf.has(p.pane_id) ? { ...p, cmdline_hint: agentOf.get(p.pane_id) } : p));
      const entries = sessionSnapshot.snapshotOnce({
        listPanes, logPath: cfg.snapshotLogPath || undefined,
        log: (message) => send({ t: 'log', message }),
      });
      send({ t: 'snapshot', at: Date.now(), entries });
    } catch (err) {
      send({ t: 'error', where: 'snapshot', message: err.message });
    }
  }
  const elapsed = Date.now() - started;
  setTimeout(cycle, Math.max(250, intervalMs - elapsed));
}

process.on('disconnect', () => process.exit(0)); // el padre murio: no quedar huerfano
send({ t: 'hello', pid: process.pid, at: Date.now(), intervalMs, snapshotIntervalMs });
cycle();
