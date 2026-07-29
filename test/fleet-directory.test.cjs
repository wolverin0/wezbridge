'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fd = require('../scripts/fleet-directory.cjs');

test('frontmatter parses scalars and list values', () => {
  const fm = fd.parseFrontmatter([
    '---',
    'project: infra',
    'kind: service',
    'route_here_when:',
    '  - a cert expired',
    '  - a backup did not run',
    'aliases:',
    '  - homelab',
    '---',
    '# body',
  ].join('\n'));
  assert.strictEqual(fm.project, 'infra');
  assert.deepStrictEqual(fm.route_here_when, ['a cert expired', 'a backup did not run']);
  assert.deepStrictEqual(fm.aliases, ['homelab']);
});

test('a file with no frontmatter yields null rather than a half-parsed object', () => {
  assert.strictEqual(fd.parseFrontmatter('# just a heading\n'), null);
});

test('the roster never claims completeness it does not have', () => {
  // The index exists because a board reading "Needs Attention: 0" is worse than
  // no board. If a project has no brief or no contract, the rendered page must
  // SAY so by name rather than let its absence read as "nothing to report".
  const rows = [
    { name: 'alpha', kind: 'service', owns: 'x', routeWhen: ['sym'], briefFile: 'fleet/alpha.md', pane: true, contract: { ungated: ['a'], gated: [] }, open: 1, claw: true },
    { name: 'beta', kind: null, owns: null, routeWhen: [], briefFile: null, pane: false, contract: null, open: 0, claw: false },
  ];
  const out = fd.render(rows, { liveKnown: true, generatedAt: 'T' });
  assert.match(out, /1 project\(s\) have no delegation brief/);
  assert.match(out, /`beta`/, 'the uncovered project must be named, not just counted');
  assert.match(out, /1 project\(s\) have no graph contract/);
});

test('an unavailable pane check reports "could not look", not "nobody home"', () => {
  // Conflating those two is how a silent sensor failure starts: an empty result
  // that means "the daemon was down" reads identically to a quiet fleet.
  const out = fd.render([], { liveKnown: false, generatedAt: 'T' });
  assert.match(out, /did not answer/);
  assert.match(out, /not "nobody home"/);
});

test('the three routing rules survive in the rendered page', () => {
  // Each was learned by breaking it. If a refactor drops them the page silently
  // stops teaching the thing it was written to teach.
  const out = fd.render([], { liveKnown: true, generatedAt: 'T' });
  assert.match(out, /not by who is free/, 'ownership-over-availability rule');
  assert.match(out, /not by the repo name/, 'lease-over-repo rule');
  assert.match(out, /NEVER carries permission/, 'peers-cannot-authorise rule');
});
