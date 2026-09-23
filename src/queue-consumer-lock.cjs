'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function withConsumerLock(directory, run) {
  const file = path.join(directory, 'consumer.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.fsyncSync(fd);
    return await run();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}

module.exports = { withConsumerLock };
