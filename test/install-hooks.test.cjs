'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { installHook, HOOKS_SRC_DIR } = require(path.resolve(__dirname, '..', 'scripts', 'install-hooks.cjs'));

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-hookrepo-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('installHook: dryRun reports src+dst without writing', () => {
  const repo = tmpRepo();
  const r = installHook('pre-push', { cwd: repo, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-push')), false);
});

test('installHook: writes hook into .git/hooks', () => {
  const repo = tmpRepo();
  const r = installHook('pre-push', { cwd: repo });
  assert.equal(r.ok, true);
  const dst = path.join(repo, '.git', 'hooks', 'pre-push');
  assert.equal(fs.existsSync(dst), true);
  const content = fs.readFileSync(dst, 'utf8');
  assert.match(content, /wezbridge-pre-push/);
});

test('installHook: refuses to overwrite a non-wezbridge hook without force', () => {
  const repo = tmpRepo();
  const dst = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, '#!/bin/sh\n# user-custom hook\necho hello\n', 'utf8');
  const r = installHook('pre-push', { cwd: repo });
  assert.equal(r.ok, false);
  assert.match(r.reason, /existing non-wezbridge/);
  // user content still there
  assert.match(fs.readFileSync(dst, 'utf8'), /user-custom hook/);
});

test('installHook: force overwrites existing hook', () => {
  const repo = tmpRepo();
  const dst = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, '#!/bin/sh\n# user-custom hook\n', 'utf8');
  const r = installHook('pre-push', { cwd: repo, force: true });
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(dst, 'utf8'), /wezbridge-pre-push/);
});

test('installHook: throws on missing source hook', () => {
  const repo = tmpRepo();
  assert.throws(() => installHook('nonexistent-hook', { cwd: repo }), /source hook not found/);
});

test('HOOKS_SRC_DIR contains pre-push', () => {
  const files = fs.readdirSync(HOOKS_SRC_DIR);
  assert.ok(files.includes('pre-push'));
});
