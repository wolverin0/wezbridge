'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv[2] === 'holder') {
  fs.appendFileSync(process.argv[3], JSON.stringify({ pid: process.pid, role: 'grandchild' }) + '\n');
  setInterval(() => {}, 1000);
} else {
  process.once('message', message => {
    const [mode, file] = message.args;
    if (mode === 'echo') return process.send({ type: 'result', value: 'worker result' }, () => process.exit(0));
    fs.appendFileSync(file, JSON.stringify({ pid: process.pid, role: 'worker' }) + '\n');
    spawn(process.execPath, [__filename, 'holder', file], { stdio: ['ignore', 1, 2], windowsHide: true });
  });
}
