'use strict';

/**
 * spawn-env.test.cjs — M3 (2026-08-24): a spawned claude pane must not inherit
 * CLAUDE_CODE_CHILD_SESSION from a poisoned mux (transcript saving OFF — cost
 * a whole session on 2026-08-23, nearly a second one today). The typed command
 * is the one choke point we control, so it carries the sanitizer.
 */

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeAgentCmd, SANITIZE_PREFIX } = require('../src/spawn-env.cjs');

test('M3: a claude command gets the env sanitizer prefix', () => {
  const out = sanitizeAgentCmd("claude --model opus", 'claude', {});
  assert.strictEqual(out, SANITIZE_PREFIX + "claude --model opus");
  assert.match(out, /env -u CLAUDE_CODE_CHILD_SESSION/);
  assert.match(out, /CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1/);
});

test('M3: codex and shell commands are untouched — the marker means nothing to them', () => {
  assert.strictEqual(sanitizeAgentCmd('codex --model gpt', 'codex', {}), 'codex --model gpt');
  assert.strictEqual(sanitizeAgentCmd(null, 'shell', {}), null);
});

test('M3: WEZBRIDGE_NO_SPAWN_ENV_SANITIZE=1 opts out (cmd/pwsh default shells)', () => {
  assert.strictEqual(sanitizeAgentCmd('claude', 'claude', { WEZBRIDGE_NO_SPAWN_ENV_SANITIZE: '1' }), 'claude');
});
