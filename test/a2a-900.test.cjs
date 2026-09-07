'use strict';
require('./setup.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function send(t, overrides) {
  const intel = fs.mkdtempSync(path.join(os.tmpdir(), 't0327-a2a-'));
  t.after(() => { assert.equal(path.dirname(intel), os.tmpdir()); fs.rmSync(intel, { recursive: true, force: true }); });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/mcp-server.cjs')], {
      env: { ...process.env, WEZBRIDGE_INTEL_DIR: intel, WEZBRIDGE_A2A_SOFT_LIMIT: '' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP response timeout')); }, 15000);
    t.after(() => { clearTimeout(timer); child.kill(); });
    child.on('error', reject);
    child.stderr.resume();
    child.stdout.on('data', data => {
      output += data;
      if (!output.includes('\n')) return;
      clearTimeout(timer); child.stdin.end(); child.kill();
      try { resolve({ result: JSON.parse(output.split('\n')[0]).result, intel }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'a2a_send', arguments: { from_pane: 1, to_project: 't0327-fixture',
        type: 'request', corr: 'T-0327-boundary', ...overrides },
    } }) + '\n');
  });
}

for (const allow_long of [undefined, false, 'true', 1]) {
  test(`T-0327 AC2 killer: 901 chars refuses before queue/spill, allow_long=${allow_long}`, async t => {
    const { result, intel } = await send(t, { body: 'x'.repeat(901), allow_long });
    assert.equal(result.isError, true);
    const message = result.content.map(x => x.text || '').join('\n');
    assert.match(message, /a2a_send REFUSED/);
    assert.match(message, /900/);
    assert.match(message, /_intel\/briefs/);
    assert.equal(fs.existsSync(path.join(intel, 'queues/t0327-fixture.jsonl')), false);
    assert.equal(fs.existsSync(path.join(intel, 'spill')), false);
  });
}

for (const args of [{ body: 'x'.repeat(900) }, { body: 'x'.repeat(901), allow_long: true }]) {
  test(`T-0327 AC2 control: ${args.body.length} chars, allow_long=${args.allow_long}`, async t => {
    const { result, intel } = await send(t, args);
    assert.notEqual(result.isError, true);
    const queued = JSON.parse(result.content[0].text);
    assert.equal(queued.queued, true);
    const row = JSON.parse(fs.readFileSync(path.join(intel, 'queues/t0327-fixture.jsonl'), 'utf8').trim());
    assert.equal(row.body, args.body, 'explicit long opt-in and boundary preserve the submitted body');
  });
}

test('T-0327 AC2: inherited environment cannot weaken the 900-character ceiling', () => {
  const script = "const g=require('./src/a2a-length-guard.cjs');console.log(JSON.stringify({limit:g.A2A_BODY_SOFT_LIMIT,refused:!!g.a2aLengthRefusal('x'.repeat(901))}))";
  const output = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8', windowsHide: true, env: { ...process.env, WEZBRIDGE_A2A_SOFT_LIMIT: '5000' } });
  assert.deepEqual(JSON.parse(output), { limit: 900, refused: true });
});
