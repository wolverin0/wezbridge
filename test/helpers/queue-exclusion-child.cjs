'use strict';
const fs = require('node:fs');
const path = require('node:path');
const q = require('../../src/project-queue.cjs');
const base = process.argv[2];
const mode = process.argv[3];
const consumer = q.createConsumer({ base, project: 'wezbridge', cooldownMs: 0,
  discoverPanes: () => [{ paneId: 7, agent: 'codex', status: 'idle', project: 'G:/test/wezbridge' }],
  logAction: () => {}, send: {
    sendPromptDeferredEnter: async () => {
      fs.appendFileSync(path.join(base, 'receiver.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
      if (mode === 'crash') process.exit(27);
      await new Promise(resolve => setTimeout(resolve, 250));
      return 'ok';
    }, verifyPromptSubmission: async () => 'submitted',
  } });
process.on('message', async () => {
  const result = await consumer.drain();
  process.send(result, () => process.disconnect());
});
process.send({ ready: true });
