'use strict';

/**
 * daemon-probe.cjs — daemon liveness + services snapshot probes for bridge_health.
 *
 * Covers: probeDaemon (is the :4200 daemon alive?), probeDaemonServices (what
 * did it arm?). Key terms: /api/health, mux latency, false DAEMON DOWN, T-0190.
 * Read when: bridge_health reports the daemon wrong, or a liveness check needs
 * a probe. Extracted from mcp-server.cjs so tests can exercise the probes
 * without starting the stdio MCP server.
 *
 * Why this file exists (T-0190): probeDaemon decided liveness by hitting
 * /api/panes, which enumerates WezTerm panes and inherits mux latency
 * (measured 1.79–3.66s) against a 2.5s timeout. /api/health answers in ~2ms.
 * A busy mux therefore produced "DAEMON DOWN — run `npm run dashboard`" on a
 * healthy daemon, and that printed remedy tells agents to restart it — which
 * drops every armed service and the crash-restore watcher. Same defect class
 * as bc2d33c, which fixed probeMux but not probeDaemon a few lines away.
 */

function probeDaemonServices() {
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request(
      { host: '127.0.0.1', port: dashPort, method: 'GET', path: '/api/health' },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body).services || null); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function probeDaemon() {
  const dashPort = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
  return new Promise((resolve) => {
    const http = require('http');
    // Liveness is decided by /api/health, which never touches the WezTerm mux.
    // /api/panes latency is a MUX signal (probeMux owns that) — a fast daemon
    // with a slow mux must report "daemon up", never "daemon down". The
    // restart remedy below is therefore only ever printed when the health
    // endpoint itself is unreachable, which is the one case it is correct.
    const req = http.request(
      { host: '127.0.0.1', port: dashPort, method: 'GET', path: '/api/health' },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ up: res.statusCode < 500, port: dashPort, status: res.statusCode }));
      }
    );
    req.on('error', () => resolve({ up: false, port: dashPort, hint: 'daemon down — run `npm run dashboard` in the wezbridge repo' }));
    req.setTimeout(2500, () => { req.destroy(); resolve({ up: false, port: dashPort, hint: 'daemon /api/health did not respond within 2.5s (wedged or down)' }); });
    req.end();
  });
}

module.exports = { probeDaemon, probeDaemonServices };
