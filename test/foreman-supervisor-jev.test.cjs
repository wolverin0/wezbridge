'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  redactSupervisorState,
  buildSupervisorPayload,
  queryJevSystemOne,
  assembleTaskState,
  superviseTask
} = require('../scripts/foreman-supervisor-jev.cjs');

test('T-0500: redactSupervisorState sanitizes tokens, passwords, private keys and windows paths', () => {
  const rawState = {
    task_id: 'T-TEST',
    goal: 'Test goal with secret token ghp_abcdef1234567890123456 and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID',
    repo: 'wezbridge',
    lease: { owner: 'pane-5' },
    pane_tail: 'Error in C:\\Users\\pauol\\Desktop\\secret.txt with password: supersecret123\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
    git_status: ' M C:\\Users\\pauol\\repo\\file.js'
  };

  const redacted = redactSupervisorState(rawState);

  assert.ok(!redacted.goal.includes('ghp_abcdef1234567890123456'), 'GitHub token must be redacted');
  assert.ok(!redacted.goal.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID'), 'JWT must be redacted');
  assert.ok(!redacted.pane_tail.includes('supersecret123'), 'Password must be redacted');
  assert.ok(!redacted.pane_tail.includes('MIIEowIBAAKCAQEA0'), 'Private key must be redacted');
  assert.ok(!redacted.pane_tail.includes('pauol'), 'Windows user path must be masked');
  assert.ok(redacted.pane_tail.includes('C:\\Users\\[USER]'), 'User path replaced with [USER]');
  assert.ok(redacted.git_status.includes('C:\\Users\\[USER]'), 'Git status user path masked');
});

test('T-0500: buildSupervisorPayload formats 4 noul questions with true/false criteria', () => {
  const state = { task_id: 'T-100', goal: 'Build feature', repo: 'wezbridge' };
  const payload = buildSupervisorPayload(state, { model: 'jev-latest' });

  assert.equal(payload.model, 'jev-latest');
  assert.ok(payload.questions, 'Must contain questions');
  assert.ok(payload.questions.stuck, 'Must contain stuck');
  assert.ok(payload.questions.drifting, 'Must contain drifting');
  assert.ok(payload.questions.done, 'Must contain done');
  assert.ok(payload.questions.needs_operator, 'Must contain needs_operator');

  for (const k of ['stuck', 'drifting', 'done', 'needs_operator']) {
    const q = payload.questions[k];
    assert.equal(q.type, 'noul', `${k} must be type noul`);
    assert.ok(q.criteria && typeof q.criteria === 'object', `${k} criteria must be an object`);
    assert.ok(Boolean(q.criteria.true), `${k} criteria must define true condition`);
    assert.ok(Boolean(q.criteria.false), `${k} criteria must define false condition`);
  }
});

test('T-0500: queryJevSystemOne returns fallback on timeout (<400ms) without throwing', async () => {
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
    const result = await queryJevSystemOne({ task_id: 'T-TIMEOUT', goal: 'Long test' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150
    });
    const elapsed = Date.now() - start;

    assert.equal(result.fallback, true, 'Must flag fallback on timeout');
    assert.equal(result.verdict, 'timeout', 'Verdict must be timeout');
    assert.equal(result.probabilities.done, 0);
    assert.equal(result.probabilities.stuck, 0);
    assert.ok(elapsed < 400, `Execution elapsed (${elapsed}ms) must be under 400ms`);
  } finally {
    clearTimeout(timerId);
    if (slowServer.closeAllConnections) slowServer.closeAllConnections();
    slowServer.close();
  }
});

test('T-0500: queryJevSystemOne returns fallback on HTTP 429 rate limit', async () => {
  const rateLimitServer = http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Rate limit exceeded' }));
  });

  await new Promise(resolve => rateLimitServer.listen(0, '127.0.0.1', resolve));
  const port = rateLimitServer.address().port;

  try {
    const result = await queryJevSystemOne({ task_id: 'T-429' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, true, 'Must flag fallback on 429');
    assert.equal(result.verdict, 'rate_limited');
    assert.ok(result.error.includes('429'));
    assert.equal(result.probabilities.done, 0);
  } finally {
    if (rateLimitServer.closeAllConnections) rateLimitServer.closeAllConnections();
    rateLimitServer.close();
  }
});

test('T-0500: queryJevSystemOne returns fallback on unexpected response shape', async () => {
  const malformedServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ something_unexpected: 123 }));
  });

  await new Promise(resolve => malformedServer.listen(0, '127.0.0.1', resolve));
  const port = malformedServer.address().port;

  try {
    const result = await queryJevSystemOne({ task_id: 'T-MALFORMED' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, true, 'Must flag fallback on malformed response');
    assert.equal(result.verdict, 'missing_answers');
    assert.equal(result.probabilities.done, 0);
  } finally {
    if (malformedServer.closeAllConnections) malformedServer.closeAllConnections();
    malformedServer.close();
  }
});

test('T-0500: queryJevSystemOne parses valid 4-noul response and computes dominant verdict', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        stuck: { type: 'noul', noul: 0.05 },
        drifting: { type: 'noul', noul: 0.10 },
        done: { type: 'noul', noul: 0.88 },
        needs_operator: { type: 'noul', noul: 0.02 }
      },
      usage: { input_tokens: 350 }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const result = await queryJevSystemOne({ task_id: 'T-VALID' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, false, 'Should not trigger fallback');
    assert.equal(result.verdict, 'done', 'Verdict should be done');
    assert.equal(result.probabilities.done, 0.88);
    assert.equal(result.probabilities.stuck, 0.05);
    assert.equal(result.probabilities.drifting, 0.10);
    assert.equal(result.probabilities.needs_operator, 0.02);
    assert.equal(result.input_tokens, 350);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
  }
});

test('T-0500: superviseTask operates in shadow mode, logs to disk and returns record', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
  const shadowFile = path.join(tmpDir, 'panes.jsonl');

  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        stuck: { type: 'noul', noul: 0.12 },
        drifting: { type: 'noul', noul: 0.08 },
        done: { type: 'noul', noul: 0.04 },
        needs_operator: { type: 'noul', noul: 0.05 }
      },
      usage: { input_tokens: 280 }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const fakeCard = {
      id: 'T-FAKE',
      title: 'Fake running task',
      goal: 'Investigate problem',
      repo: 'wezbridge',
      state: 'running',
      lease: { owner: 'pane-99', expires_at: '2026-09-20T23:00:00Z' }
    };

    const record = await superviseTask(fakeCard, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      shadowFile,
      timeoutMs: 300,
      pane_tail: 'Working on solution...',
      git_status: 'M file.js'
    });

    assert.equal(record.task_id, 'T-FAKE');
    assert.equal(record.verdict, 'active');
    assert.equal(record.probabilities.stuck, 0.12);
    assert.equal(record.fallback, false);

    assert.ok(fs.existsSync(shadowFile), 'Shadow log file must be created');
    const lines = fs.readFileSync(shadowFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]);
    assert.equal(logged.task_id, 'T-FAKE');
    assert.equal(logged.probabilities.stuck, 0.12);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('T-0500: regression — hook survives when Jev API hangs indefinitely and returns fallback within budget', async () => {
  const hangingServer = http.createServer((req, res) => {
    // Intentionally never respond or close
  });

  await new Promise(resolve => hangingServer.listen(0, '127.0.0.1', resolve));
  const port = hangingServer.address().port;

  try {
    const start = Date.now();
    const result = await queryJevSystemOne({ task_id: 'T-HANG', goal: 'Hang test' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150
    });
    const elapsed = Date.now() - start;

    assert.equal(result.fallback, true, 'Must return fallback without uncaught error');
    assert.equal(result.verdict, 'timeout');
    assert.ok(elapsed < 400, `Must abort within 400ms budget, took ${elapsed}ms`);
  } finally {
    if (hangingServer.closeAllConnections) hangingServer.closeAllConnections();
    hangingServer.close();
  }
});
