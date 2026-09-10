'use strict';
// Owned live-test PTY receiver: accepts data only, never executes received text.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');
const marker = path.join(process.cwd(), 'T0377-OWNED');
if (!fs.existsSync(marker)) throw new Error('not an owned T0377 probe directory');
fs.writeFileSync(path.join(process.cwd(), `ready-${process.pid}.json`), JSON.stringify({
  pid: process.pid, epoch: process.env.T0377_EPOCH, cwd: process.cwd() }));
process.stdout.write(`\x1b]7;${pathToFileURL(process.cwd()).href}\x07T0377 receiver ready\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  fs.appendFileSync(path.join(process.cwd(), `received-${process.pid}.jsonl`),
    JSON.stringify({ line, epoch: process.env.T0377_EPOCH }) + '\n');
  process.stdout.write('T0377 recorded\n');
});
lines.on('close', () => process.exit(0));
