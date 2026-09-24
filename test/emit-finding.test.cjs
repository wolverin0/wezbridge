'use strict';
/**
 * emit-finding.test.cjs — T-0598 Fase A. Proves bin/emit-finding.cjs writes a
 * finding the router accepts, and refuses (nonzero, no file) an invalid one —
 * so a Fase B migration (curador WISP, DaemonSentinel, gmail-recordatorios)
 * can rely on it as a one-liner.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main } = require('../bin/emit-finding.cjs');
const { validateFinding } = require('../src/automation-finding-schema.cjs');

function sandboxDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'emit-finding-')); }

test('emit-finding writes a valid finding file the schema accepts', () => {
  const outDir = sandboxDir();
  try {
    const code = main([
      '--task', 'daemon-sentinel', '--repo', 'wezbridge', '--actionable', 'true',
      '--summary', 'daemon down', '--evidence', 'deadman stale 20min', '--severity', 'high', '--out-dir', outDir,
    ]);
    assert.equal(code, 0);
    const files = fs.readdirSync(outDir);
    assert.equal(files.length, 1);
    const finding = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf8'));
    assert.equal(validateFinding(finding).ok, true);
    assert.equal(finding.task, 'daemon-sentinel');
    assert.equal(finding.actionable, true);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('emit-finding refuses an invalid finding (missing evidence) and writes nothing', () => {
  const outDir = sandboxDir();
  try {
    const code = main([
      '--task', 'daemon-sentinel', '--repo', 'wezbridge', '--actionable', 'true',
      '--summary', 'daemon down', '--severity', 'high', '--out-dir', outDir,
    ]);
    assert.notEqual(code, 0);
    assert.equal(fs.readdirSync(outDir).length, 0);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
