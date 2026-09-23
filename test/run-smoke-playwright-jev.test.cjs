'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  isDestructiveLabelRegex,
  classifySafeButtonRegex,
  redactValidationText,
  evaluateElementWithJev,
  evaluateObservableChangeWithJev,
  evaluateRouteHealthWithJev,
  logShadowEntry
} = require('../scripts/run-smoke-playwright-jev.cjs');

test('T-0502: redactValidationText sanitizes tokens, passwords, private keys and windows paths', () => {
  const dirty = 'Submit with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID and ghp_0123456789abcdef0123456789 and password: secretPass123 on C:\\Users\\pauol\\repo';
  const clean = redactValidationText(dirty);

  assert.ok(!clean.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID'), 'JWT token must be masked');
  assert.ok(!clean.includes('ghp_0123456789abcdef0123456789'), 'GitHub token must be masked');
  assert.ok(!clean.includes('secretPass123'), 'Password must be masked');
  assert.ok(!clean.includes('pauol'), 'Username in path must be masked');
  assert.ok(clean.includes('C:\\Users\\[USER]'), 'Replaced with [USER]');
});

test('T-0502: deterministic regex helpers flag destructive and safe button patterns correctly', () => {
  assert.equal(isDestructiveLabelRegex('Eliminar cuenta'), true);
  assert.equal(isDestructiveLabelRegex('Borrar carrito'), true);
  assert.equal(isDestructiveLabelRegex('Ver detalles'), false);
  assert.equal(isDestructiveLabelRegex('Explorar catálogo'), false);

  const safeAction = classifySafeButtonRegex('Ver productos', 'button');
  assert.equal(safeAction.category, 'safe_action');

  const closeAction = classifySafeButtonRegex('Cerrar', 'button');
  assert.equal(closeAction.category, 'needs_open_state');

  const unknownAction = classifySafeButtonRegex('Hablar con asesor', 'button');
  assert.equal(unknownAction.category, 'unknown');
  assert.equal(unknownAction.reason, 'unsupported-safe-button-semantics');
});

test('T-0502: evaluateElementWithJev returns fallback on timeout (<400ms) without throwing', async () => {
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
    const result = await evaluateElementWithJev({ label: 'Test button', type: 'button', route: '/' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 150
    });
    const elapsed = Date.now() - start;

    assert.equal(result.fallback, true, 'Must trigger fallback');
    assert.equal(result.error, 'timeout', 'Error must be timeout');
    assert.equal(result.destructive_risk, 'allow');
    assert.equal(result.button_semantic, 'safe_action');
    assert.ok(elapsed < 400, `Execution (${elapsed}ms) must complete under 400ms`);
  } finally {
    clearTimeout(timerId);
    if (slowServer.closeAllConnections) slowServer.closeAllConnections();
    slowServer.close();
  }
});

test('T-0502: evaluateElementWithJev parses choices destructive_risk and button_semantic', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        destructive_risk: {
          type: 'choice',
          choice: 'allow',
          confidence: 0.94,
          probabilities: { allow: 0.94, ask: 0.05, deny: 0.01 }
        },
        button_semantic: {
          type: 'choice',
          choice: 'safe_action',
          confidence: 0.92,
          probabilities: { safe_action: 0.92, needs_open_state: 0.04, destructive: 0.01, unknown: 0.03 }
        }
      },
      usage: { input_tokens: 310 }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const result = await evaluateElementWithJev({ label: 'Ver catálogo', type: 'button', route: '/' }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, false);
    assert.equal(result.destructive_risk, 'allow');
    assert.equal(result.destructive_confidence, 0.94);
    assert.equal(result.button_semantic, 'safe_action');
    assert.equal(result.semantic_confidence, 0.92);
    assert.equal(result.input_tokens, 310);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
  }
});

test('T-0502: evaluateObservableChangeWithJev parses noul probability', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        observable_change: {
          type: 'noul',
          noul: 0.89
        }
      },
      usage: { input_tokens: 280 }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const result = await evaluateObservableChangeWithJev({
      label: 'Abrir carrito',
      url_before: 'http://localhost:3180/',
      url_after: 'http://localhost:3180/',
      url_changed: false,
      text_changed: true,
      dialog_visible: true,
      diff_snippet: 'Added modal drawer with cart summary'
    }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, false);
    assert.equal(result.observable_change, true);
    assert.equal(result.probability, 0.89);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
  }
});

test('T-0502: evaluateRouteHealthWithJev parses route health choice', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        route_health: {
          type: 'choice',
          choice: 'healthy',
          confidence: 0.97,
          probabilities: { healthy: 0.97, degraded: 0.02, broken: 0.01, unknown: 0.0 }
        }
      },
      usage: { input_tokens: 260 }
    }));
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;

  try {
    const result = await evaluateRouteHealthWithJev({
      path: '/?store=inpla',
      label: 'Catálogo Fábrica INPLA',
      status_code: 200,
      chars_rendered: 4500,
      console_errors_count: 0,
      responsive_issues_high: 0,
      summary_text: 'Rendered product catalog with 3D packaging simulation'
    }, {
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
      timeoutMs: 300
    });

    assert.equal(result.fallback, false);
    assert.equal(result.route_health, 'healthy');
    assert.equal(result.confidence, 0.97);
  } finally {
    if (mockServer.closeAllConnections) mockServer.closeAllConnections();
    mockServer.close();
  }
});

test('T-0502: logShadowEntry appends jsonl record to file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-log-test-'));
  const logFile = path.join(tmpDir, 'test-shadow.jsonl');

  try {
    const sampleRecord = {
      decision_type: 'element_candidate',
      label: 'Hablar con el asesor',
      regex_decision: 'unsupported-safe-button-semantics',
      jev_decision: 'safe_action',
      jev_confidence: 0.91
    };

    logShadowEntry(sampleRecord, logFile);

    assert.ok(fs.existsSync(logFile), 'File must exist');
    const content = fs.readFileSync(logFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.label, 'Hablar con el asesor');
    assert.equal(parsed.jev_decision, 'safe_action');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
