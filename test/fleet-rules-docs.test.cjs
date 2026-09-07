'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render } = require('../scripts/fleet-directory.cjs');

test('T-0327 AC1: protocol and generated fleet contain all three executable rules and compact headers', () => {
  const protocol = fs.readFileSync(path.resolve(__dirname, '../docs/a2a-protocol.md'), 'utf8');
  const fleet = render([], { liveKnown: false, generatedAt: 'fixture' });
  for (const doc of [protocol, fleet]) {
    const head = doc.split(/\r?\n/).slice(0, 8);
    assert.match(head[0], /^<!-- doc-head:/);
    assert.ok(head.includes('<!-- /doc-head -->'));
    assert.match(doc, /## Reglas de flota/);
    for (const term of ['900', 'allow_long', 'cross-repo-unticketed', 'routine-void',
      'a2a-length-guard.cjs', 'cross-repo-audit.cjs', 'routine-registry.cjs']) assert.ok(doc.includes(term), term);
  }
});
