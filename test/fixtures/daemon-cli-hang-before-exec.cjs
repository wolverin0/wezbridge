'use strict';
// Loaded before daemon-cli-worker.cjs registers its operation handler. These
// four reads stop BEFORE execFile/execFileSync can arm a native timeout.
const path = require('node:path');
const fs = require('node:fs');
if (path.basename(process.argv[1] || '') === 'daemon-cli-worker.cjs') {
  process.on('message', message => {
    const pane = Number(message.args?.[0]);
    if (message.operation !== 'wez.getFullText' || ![8701, 8702, 8703, 8704].includes(pane)) return;
    fs.appendFileSync(process.env.WEZBRIDGE_TEST_HUNG_WORKERS,
      JSON.stringify({ pid: process.pid, pane, before_native_exec: true }) + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}
