'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const POKE = path.join(__dirname, '../scripts/poke-pane.cjs');
const SOURCE = fs.readFileSync(POKE, 'utf8').replace(/^#![^\n]*\n/, '');
const LIVE = fs.readFileSync(path.join(__dirname, 'fixtures/wabot-askuserquestion-20260909.txt'), 'utf8');

function runPoke(tail) {
  const writes = [];
  const logs = [];
  const module = { exports: {} };
  const localRequire = createRequire(POKE);
  const fakeRequire = name => {
    if (name === 'fs') return { ...fs, readdirSync: () => [] };
    if (name !== 'child_process') return localRequire(name);
    return { execFileSync: (file, args, options) => {
      assert.equal(file, 'fixture-wezterm');
      if (args.includes('list')) return JSON.stringify([{ pane_id: 10, cwd: '/fixture/wabot', tab_title: 'wabot' }]);
      if (args.includes('get-text')) return tail;
      if (args.includes('send-text')) {
        writes.push({ args, input: options.input });
        throw new Error('stop after recording attempted write; no real terminal');
      }
      throw new Error(`unexpected terminal operation: ${args}`);
    } };
  };
  fakeRequire.main = module;
  const process = { platform: 'linux', env: { WEZTERM_BIN: 'fixture-wezterm' },
    argv: ['node', POKE, '--project', 'wabot', '--text', 'fixture prompt'],
    exit: status => { throw Object.assign(new Error('fixture process exit'), { status }); },
  };
  const run = vm.runInNewContext(`(function(require, module, __dirname) {\n${SOURCE}\n})`, {
    process, console: { log: text => logs.push(text) },
  }, { filename: POKE });
  let status;
  try { run(fakeRequire, module, path.dirname(POKE)); } catch (error) {
    if (error.status === undefined) throw error;
    status = error.status;
  }
  return { status, writes, logs: logs.join('\n') };
}

test('T-0401 AC4 killer: actual poke CLI refuses the Wabot question with exit 10 and zero writes', () => {
  const result = runPoke(LIVE);
  assert.equal(result.status, 10);
  assert.deepEqual(result.writes, [], 'neither paste nor Enter may reach the terminal');
  assert.match(result.logs, /operator-question.*nothing written/i);
});

test('T-0401 AC4 control: actual poke CLI still refuses retained composer text', () => {
  const result = runPoke('\u276f texto del operador sin enviar');
  assert.equal(result.status, 10);
  assert.deepEqual(result.writes, []);
  assert.match(result.logs, /composer already holds unsent text/);
});

test('T-0401 AC4 control: an old question followed by an empty composer reaches the write boundary', () => {
  const result = runPoke(LIVE + '\n\u276f');
  assert.notEqual(result.status, 10);
  assert.equal(result.writes.length, 1, 'the harness must detect an unguarded paste');
});
