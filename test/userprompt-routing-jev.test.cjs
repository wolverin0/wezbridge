'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  SKILL_CATALOG,
  TIER_CATALOG,
  redactPromptState,
  evaluatePromptRoutingWithJev,
  handleUserPromptSubmit
} = require('../scripts/userprompt-routing-jev.cjs');

test('T-0499: redactPromptState sanitizes tokens, passwords, private keys and windows paths', () => {
  const prompt = 'Please review my token Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID and secret sk-proj998877665544332211aa for project';
  const cwd = 'C:\\Users\\pauol\\secret-project';

  const redacted = redactPromptState(prompt, cwd);

  assert.ok(!redacted.prompt.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID'), 'JWT token must be redacted');
  assert.ok(!redacted.prompt.includes('sk-proj998877665544332211aa'), 'OpenAI sk- key must be redacted');
  assert.ok(!redacted.cwd.includes('pauol'), 'Windows user path must be masked');
  assert.ok(redacted.cwd.includes('C:\\Users\\[USER]'), 'User path replaced with [USER]');
});

test('T-0499: SKILL_CATALOG and TIER_CATALOG contain mandatory options', () => {
  const expectedSkills = ['ui-ux-pro-max', 'tdd-workflow', 'codebase-investigator', 'security-review', 'sparc-methodology', 'pr-writer', 'none', 'other'];
  for (const s of expectedSkills) {
    assert.ok(Boolean(SKILL_CATALOG[s]), `SKILL_CATALOG must contain ${s}`);
  }

  const expectedTiers = ['haiku', 'sonnet', 'opus', 'codex', 'other'];
  for (const t of expectedTiers) {
    assert.ok(Boolean(TIER_CATALOG[t]), `TIER_CATALOG must contain ${t}`);
  }
});

test('T-0499: evaluatePromptRoutingWithJev returns fallback on timeout (<400ms) without throwing', async () => {
  let timerId;
  const slowServer = http.createServer((req, res) => {
    timerId = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, 1000);
  });

  await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve));
  const port = slowServer.address().port;

  try {
    const start = Date.now();
    const result = await evaluatePromptRoutingWithJev('Need a new login screen with Tailwind', '/test', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150
    });
    const elapsed = Date.now() - start;

    assert.equal(result.fallback, true, 'Must flag fallback on timeout');
    assert.equal(result.error, 'timeout', 'Error must be timeout');
    assert.equal(result.suggested_skill, 'none');
    assert.equal(result.suggested_tier, 'sonnet');
    assert.ok(elapsed < 400, `Execution elapsed (${elapsed}ms) must be under 400ms`);
  } finally {
    clearTimeout(timerId);
    if (slowServer.closeAllConnections) slowServer.closeAllConnections();
    slowServer.close();
  }
});

test('T-0499: evaluatePromptRoutingWithJev returns fallback on HTTP 429 rate limit', async () => {
  const rateLimitServer = http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Rate limit exceeded' }));
  });

  await new Promise(resolve => rateLimitServer.listen(0, '127.0.0.1', resolve));
  const port = rateLimitServer.address().port;

  try {
    const result = await evaluatePromptRoutingWithJev('Implement unit tests', '/test', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, true);
    assert.equal(result.error, 'rate_limit_429');
    assert.equal(result.suggested_skill, 'none');
    assert.equal(result.suggested_tier, 'sonnet');
  } finally {
    if (rateLimitServer.closeAllConnections) rateLimitServer.closeAllConnections();
    rateLimitServer.close();
  }
});

test('T-0499: evaluatePromptRoutingWithJev returns fallback on unexpected response shape', async () => {
  const weirdServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ unexpected: true }));
  });

  await new Promise(resolve => weirdServer.listen(0, '127.0.0.1', resolve));
  const port = weirdServer.address().port;

  try {
    const result = await evaluatePromptRoutingWithJev('Check git log', '/test', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, true);
    assert.equal(result.error, 'unexpected_shape');
    assert.equal(result.suggested_skill, 'none');
  } finally {
    if (weirdServer.closeAllConnections) weirdServer.closeAllConnections();
    weirdServer.close();
  }
});

test('T-0499: evaluatePromptRoutingWithJev parses valid skill and tier choices correctly', async () => {
  const validServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        suggested_skill: {
          type: 'choice',
          choice: 'ui-ux-pro-max',
          confidence: 0.97,
          probabilities: { 'ui-ux-pro-max': 0.97, 'none': 0.03 }
        },
        suggested_tier: {
          type: 'choice',
          choice: 'sonnet',
          confidence: 0.92,
          probabilities: { 'sonnet': 0.92, 'haiku': 0.08 }
        }
      },
      usage: { input_tokens: 820, output_tokens: 150 }
    }));
  });

  await new Promise(resolve => validServer.listen(0, '127.0.0.1', resolve));
  const port = validServer.address().port;

  try {
    const result = await evaluatePromptRoutingWithJev('Design a responsive dashboard with modern cards', '/test', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, false);
    assert.equal(result.suggested_skill, 'ui-ux-pro-max');
    assert.equal(result.skill_confidence, 0.97);
    assert.equal(result.suggested_tier, 'sonnet');
    assert.equal(result.tier_confidence, 0.92);
    assert.equal(result.usage.input_tokens, 820);
  } finally {
    if (validServer.closeAllConnections) validServer.closeAllConnections();
    validServer.close();
  }
});

test('T-0499: handleUserPromptSubmit operates strictly in shadow mode, returns {} and logs', async () => {
  const tempLogFile = path.join(os.tmpdir(), `userprompt-shadow-${Date.now()}.jsonl`);

  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        suggested_skill: { type: 'choice', choice: 'tdd-workflow', confidence: 0.95, probabilities: { 'tdd-workflow': 0.95 } },
        suggested_tier: { type: 'choice', choice: 'sonnet', confidence: 0.90, probabilities: { 'sonnet': 0.90 } }
      },
      usage: { input_tokens: 750, output_tokens: 140 }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const output = await handleUserPromptSubmit({
      prompt: 'Write failing tests first to reproduce the edge case',
      cwd: '/home/user/project'
    }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      logFile: tempLogFile,
      timeoutMs: 300
    });

    // Shadow mode guarantee: must return empty object
    assert.deepEqual(output, {});

    assert.ok(fs.existsSync(tempLogFile));
    const lines = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.suggested_skill, 'tdd-workflow');
    assert.equal(entry.suggested_tier, 'sonnet');
    assert.equal(entry.skill_confidence, 0.95);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
    try { fs.unlinkSync(tempLogFile); } catch (_) {}
  }
});

test('T-0499: regression — hook survives when Jev hangs and returns {} within budget', async () => {
  const hangingServer = http.createServer((req, res) => {
    // deliberately hanging
  });

  await new Promise(resolve => hangingServer.listen(0, '127.0.0.1', resolve));
  const port = hangingServer.address().port;

  const tempLogFile = path.join(os.tmpdir(), `userprompt-hang-${Date.now()}.jsonl`);
  const t0 = Date.now();

  try {
    const out = await handleUserPromptSubmit({
      prompt: 'Refactor the data layer',
      cwd: '/test'
    }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150,
      logFile: tempLogFile
    });

    const elapsed = Date.now() - t0;
    assert.deepEqual(out, {}, 'Must return {} even when remote endpoint hangs');
    assert.ok(elapsed < 400, `Execution elapsed (${elapsed}ms) must stay under 400ms`);

    const logLines = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    const record = JSON.parse(logLines[0]);
    assert.equal(record.fallback, true);
    assert.equal(record.error, 'timeout');
  } finally {
    if (hangingServer.closeAllConnections) hangingServer.closeAllConnections();
    hangingServer.close();
    try { fs.unlinkSync(tempLogFile); } catch (_) {}
  }
});
