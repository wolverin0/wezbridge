'use strict';
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const [mode, record] = process.argv.slice(2);
const log = data => fs.appendFileSync(record, JSON.stringify({ ...data, pid: process.pid }) + '\n');

if (mode === 'holder') {
  log({ event: 'pipe-holder' });
  if (process.send) process.send('ready');
  setInterval(() => {}, 1000);
} else if (mode === 'cli') {
  const child = spawn(process.execPath, [__filename, 'holder', record], {
    stdio: ['ignore', 1, 2, 'ipc'], windowsHide: true,
  });
  child.on('message', () => {
    log({ event: 'cli-ready', child_pid: child.pid });
    if (process.env.PIPE_CLI_EXIT === '1') process.exit(0);
  });
} else if (mode === 'probe') {
  const started = Date.now();
  log({ event: 'probe-start', timeout_ms: 10000 });
  try {
    execFileSync(process.execPath, [__filename, 'cli', record], {
      timeout: 10000, stdio: 'pipe', windowsHide: true,
    });
    log({ event: 'probe-return', elapsed_ms: Date.now() - started, code: 'OK' });
  } catch (error) {
    log({ event: 'probe-return', elapsed_ms: Date.now() - started, code: error.code });
  }
}
