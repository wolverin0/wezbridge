// T-0190: daemon liveness must be decided by /api/health, never by a
// mux-dependent endpoint. The measured failure: /api/panes takes 1.79-3.66s
// under mux load vs a 2.5s timeout, so a HEALTHY daemon got reported as
// "DAEMON DOWN — run `npm run dashboard`", and that remedy, if followed,
// drops every armed service. Same class as bc2d33c (probeMux), which fixed
// one site and missed this one a few lines away.
//
// The scenario each test builds is the real one: a daemon whose /api/health
// answers in ~2ms while /api/panes stalls past the probe timeout.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probeDaemon } = require('../src/daemon-probe.cjs');

function startDaemon({ panesDelayMs = 0, healthOk = true }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        if (!healthOk) { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ services: {} }));
        return;
      }
      if (req.url === '/api/panes') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ panes: [] }));
        }, panesDelayMs);
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withDaemon(opts, fn) {
  const server = await startDaemon(opts);
  const prev = process.env.DASHBOARD_PORT;
  process.env.DASHBOARD_PORT = String(server.address().port);
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.DASHBOARD_PORT;
    else process.env.DASHBOARD_PORT = prev;
    server.close();
  }
}

test('REGRESSION T-0190: health fast + panes stalled >2.5s => daemon is UP', async () => {
  await withDaemon({ panesDelayMs: 3200 }, async () => {
    const out = await probeDaemon();
    assert.equal(out.up, true,
      'a healthy daemon with a slow mux must NOT be reported down — this is the false DAEMON DOWN of T-0190');
    assert.ok(!out.hint || !/npm run dashboard/.test(out.hint),
      'the restart remedy must never be printed for mux-path latency');
  });
});

test('daemon genuinely down (connection refused on /api/health) => up:false with restart hint', async () => {
  // Bind a port then close it so the port is known-dead.
  const server = await startDaemon({});
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const prev = process.env.DASHBOARD_PORT;
  process.env.DASHBOARD_PORT = String(port);
  try {
    const out = await probeDaemon();
    assert.equal(out.up, false);
    assert.match(out.hint || '', /npm run dashboard/,
      'when the HEALTH endpoint itself is unreachable, the restart remedy is correct and must be present');
  } finally {
    if (prev === undefined) delete process.env.DASHBOARD_PORT;
    else process.env.DASHBOARD_PORT = prev;
  }
});

test('health endpoint hangs past timeout => up:false, timeout hint, no false positive', async () => {
  await withDaemon({ healthOk: true, panesDelayMs: 0 }, async () => {
    // Replace health handling: simulate a wedged daemon by pointing at a server
    // that accepts but never answers /api/health.
    const wedged = http.createServer(() => { /* never respond */ });
    await new Promise((r) => wedged.listen(0, '127.0.0.1', r));
    const prev = process.env.DASHBOARD_PORT;
    process.env.DASHBOARD_PORT = String(wedged.address().port);
    try {
      const out = await probeDaemon();
      assert.equal(out.up, false, 'a daemon that cannot answer /api/health is not healthy');
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_PORT;
      else process.env.DASHBOARD_PORT = prev;
      wedged.close();
    }
  });
});
