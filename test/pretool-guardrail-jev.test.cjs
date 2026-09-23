'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  redactState,
  evaluateBashWithRegex,
  evaluateBashWithJev,
  handlePreToolUse
} = require('../scripts/pretool-guardrail-jev.cjs');

test('T-0498: redactState sanitizes tokens, passwords, private keys and truncates context', () => {
  const cmd = 'curl -H "Authorization: Bearer mySecretToken12345678" https://api.example.com?api_key=secret987654321';
  const cwd = 'C:\\Users\\pauol\\project';
  const context = 'line 1\nline 2\nline 3\nline 4\nline 5 with sk-proj1234567890abcdef123456';

  const redacted = redactState(cmd, cwd, context);

  assert.ok(!redacted.command.includes('mySecretToken12345678'), 'Bearer token must be redacted');
  assert.ok(!redacted.command.includes('secret987654321'), 'API key must be redacted');
  assert.ok(!redacted.context_tail.includes('sk-proj1234567890abcdef123456'), 'Secret key in context must be redacted');
  assert.ok(!redacted.cwd.includes('pauol'), 'User home directory must be masked');

  const contextLines = redacted.context_tail.split('\n');
  assert.ok(contextLines.length <= 3, 'Context tail must be at most 3 lines');
  assert.ok(redacted.context_tail.includes('line 3'), 'Context tail includes recent lines');
});

test('T-0498: evaluateBashWithRegex accurately flags dangerous patterns', () => {
  // Sudo blocked
  const resSudo = evaluateBashWithRegex('sudo systemctl restart nginx', { CC_ALLOW_SUDO: '0' });
  assert.equal(resSudo.decision, 'deny');
  assert.equal(resSudo.rule, 'G01');

  // Git push force blocked
  const resPushF = evaluateBashWithRegex('git push origin main -f', { CC_ALLOW_FORCE_PUSH: '0' });
  assert.equal(resPushF.decision, 'deny');
  assert.equal(resPushF.rule, 'G03');

  // Git push force with lease on feature branch allowed
  const resPushLease = evaluateBashWithRegex('git push origin feat/t-0498 --force-with-lease', { CC_ALLOW_FORCE_PUSH: '0' });
  assert.equal(resPushLease.decision, 'allow');

  // No verify blocked
  const resNoVerify = evaluateBashWithRegex('git commit -m "fix" --no-verify', { CC_ALLOW_NOVERIFY: '0' });
  assert.equal(resNoVerify.decision, 'deny');
  assert.equal(resNoVerify.rule, 'G04');

  // Reset hard main blocked
  const resReset = evaluateBashWithRegex('git reset --hard origin/main', { CC_ALLOW_RESET_MAIN: '0' });
  assert.equal(resReset.decision, 'deny');
  assert.equal(resReset.rule, 'G05');

  // Push main warns / asks
  const resPushMain = evaluateBashWithRegex('git push origin main', {});
  assert.equal(resPushMain.decision, 'ask');
  assert.equal(resPushMain.rule, 'G06');

  // Rm root blocked
  const resRmRoot = evaluateBashWithRegex('rm -rf /', {});
  assert.equal(resRmRoot.decision, 'deny');
  assert.equal(resRmRoot.rule, 'G07');

  // Rm normal directory asks
  const resRmTemp = evaluateBashWithRegex('rm -rf ./build_cache', {});
  assert.equal(resRmTemp.decision, 'ask');
  assert.equal(resRmTemp.rule, 'G07');

  // Harmless command allowed
  const resSafe = evaluateBashWithRegex('git status', {});
  assert.equal(resSafe.decision, 'allow');
  assert.equal(resSafe.rule, null);
});

test('T-0498: evaluateBashWithJev returns fallback on timeout (<400ms) without throwing', async () => {
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
    const result = await evaluateBashWithJev('ls -la', '/test', '', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150
    });
    const elapsed = Date.now() - start;

    assert.equal(result.fallback, true, 'Must flag fallback on timeout');
    assert.equal(result.error, 'timeout', 'Error must be timeout');
    assert.equal(result.decision, 'unknown');
    assert.ok(elapsed < 400, `Execution elapsed (${elapsed}ms) must be under 400ms`);
  } finally {
    clearTimeout(timerId);
    if (slowServer.closeAllConnections) slowServer.closeAllConnections();
    slowServer.close();
  }
});

test('T-0498: evaluateBashWithJev returns fallback on HTTP 429 rate limit', async () => {
  const rateLimitServer = http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Too Many Requests' }));
  });

  await new Promise(resolve => rateLimitServer.listen(0, '127.0.0.1', resolve));
  const port = rateLimitServer.address().port;

  try {
    const result = await evaluateBashWithJev('cat README.md', '/test', '', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, true);
    assert.equal(result.error, 'rate_limit_429');
    assert.equal(result.decision, 'unknown');
  } finally {
    if (rateLimitServer.closeAllConnections) rateLimitServer.closeAllConnections();
    rateLimitServer.close();
  }
});

test('T-0498: evaluateBashWithJev returns fallback on unexpected response shape', async () => {
  const weirdServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ unexpected_data: [1, 2, 3] }));
  });

  await new Promise(resolve => weirdServer.listen(0, '127.0.0.1', resolve));
  const port = weirdServer.address().port;

  try {
    const result = await evaluateBashWithJev('pwd', '/test', '', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, true);
    assert.equal(result.error, 'unexpected_shape');
    assert.equal(result.decision, 'unknown');
  } finally {
    if (weirdServer.closeAllConnections) weirdServer.closeAllConnections();
    weirdServer.close();
  }
});

test('T-0498: evaluateBashWithJev parses valid choice and noul answers correctly', async () => {
  const validServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        risk_decision: {
          type: 'choice',
          choice: 'deny',
          confidence: 0.94,
          probabilities: { allow: 0.01, ask: 0.05, deny: 0.94, unknown: 0.0 }
        },
        push_force: { type: 'noul', noul: 0.99 },
        pkill_substring: { type: 'noul', noul: 0.02 },
        systemctl_scope: { type: 'noul', noul: 0.01 },
        rm_boot_or_root: { type: 'noul', noul: 0.0 },
        exit_in_subshell: { type: 'noul', noul: 0.0 },
        credential_hunting: { type: 'noul', noul: 0.0 }
      }
    }));
  });

  await new Promise(resolve => validServer.listen(0, '127.0.0.1', resolve));
  const port = validServer.address().port;

  try {
    const result = await evaluateBashWithJev('git push --force origin main', '/test', '', {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, false);
    assert.equal(result.decision, 'deny');
    assert.equal(result.confidence, 0.94);
    assert.equal(result.noul_flags.push_force, 0.99);
    assert.equal(result.noul_flags.pkill_substring, 0.02);
  } finally {
    if (validServer.closeAllConnections) validServer.closeAllConnections();
    validServer.close();
  }
});

test('T-0498: handlePreToolUse operates strictly in shadow mode, returns {} and logs decisions', async () => {
  const tempLogFile = path.join(os.tmpdir(), `shadow-log-${Date.now()}.jsonl`);

  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        risk_decision: {
          type: 'choice',
          choice: 'allow',
          confidence: 0.99,
          probabilities: { allow: 0.99, ask: 0.01, deny: 0.0, unknown: 0.0 }
        },
        push_force: { type: 'noul', noul: 0.01 }
      }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const hookOutput = await handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'node --test' },
      cwd: '/home/user/repo'
    }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      logFile: tempLogFile,
      timeoutMs: 300
    });

    // Shadow mode MUST return {}
    assert.deepEqual(hookOutput, {});

    // Must log shadow record
    assert.ok(fs.existsSync(tempLogFile), 'Shadow log file must be created');
    const logLines = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    assert.equal(logLines.length, 1);
    const entry = JSON.parse(logLines[0]);
    assert.equal(entry.command, 'node --test');
    assert.equal(entry.decision_regex, 'allow');
    assert.equal(entry.decision_jev, 'allow');
    assert.equal(entry.confidence, 0.99);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
    try { fs.unlinkSync(tempLogFile); } catch (_) {}
  }
});

test('T-0498: regression — hook survives when Jev API hangs indefinitely and returns {} within budget', async () => {
  // A server that NEVER responds
  const blackHoleServer = http.createServer((req, res) => {
    // deliberately hanging request
  });

  await new Promise(resolve => blackHoleServer.listen(0, '127.0.0.1', resolve));
  const port = blackHoleServer.address().port;

  const tempLogFile = path.join(os.tmpdir(), `shadow-hang-${Date.now()}.jsonl`);
  const t0 = Date.now();

  try {
    const out = await handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git pull' },
      cwd: '/test'
    }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150,
      logFile: tempLogFile
    });

    const elapsed = Date.now() - t0;
    assert.deepEqual(out, {}, 'Must return {} even when remote endpoint hangs');
    assert.ok(elapsed < 400, `Execution must stay within budget, took ${elapsed}ms`);

    const logLines = fs.readFileSync(tempLogFile, 'utf8').trim().split('\n');
    const record = JSON.parse(logLines[0]);
    assert.equal(record.fallback, true);
    assert.equal(record.error, 'timeout');
  } finally {
    if (blackHoleServer.closeAllConnections) blackHoleServer.closeAllConnections();
    blackHoleServer.close();
    try { fs.unlinkSync(tempLogFile); } catch (_) {}
  }
});
