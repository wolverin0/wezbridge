#!/usr/bin/env node
'use strict';
/**
 * scripts/foreman-supervisor-jev.cjs
 *
 * Foreman JEV Supervisor for active task panes.
 *
 * In each orchestrator tick:
 *   state = goal + lease + pane_tail (from wez.getFullText or recent transcript) + git status
 *   Evaluates 4 typed boolean noul criteria:
 *     - stuck: agent repeating errors or frozen without progress
 *     - drifting: agent editing unrelated files or diverging from card goal
 *     - done: task finished, tests passing or acceptance criteria met
 *     - needs_operator: agent requiring human operator approval/intervention
 *
 * Operates in strict SHADOW mode:
 *   - Logs telemetry to _intel/jev-shadow/panes.jsonl
 *   - Emits alerts/verdicts without mutating orchestrator decisions or tasks
 *   - Hard latency budget (<400ms P95) and deterministic fallback on timeout/429/error
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { execSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const CACHED_KEY_FILE = 'C:\\infra-secrets\\typesafe-key';
const USER_CACHED_KEY = 'C:\\Users\\pauol\\.claude\\cache\\typesafe-key';
const BW_SESSION_FILE = 'C:\\Users\\pauol\\.bw_session';

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..');
const INTEL_DIR = process.env.WEZBRIDGE_INTEL_DIR || path.resolve(REPO_ROOT, '..', '_intel');
const TASKS_DIR = path.join(INTEL_DIR, 'tasks');
const SHADOW_DIR = path.join(INTEL_DIR, 'jev-shadow');
const SHADOW_LOG_FILE = path.join(SHADOW_DIR, 'panes.jsonl');

function redactText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-\.]{15,}/gi, 'Bearer [REDACTED]')
    .replace(/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '$1_[REDACTED]')
    .replace(/sk-[a-zA-Z0-9_\-]{20,}/g, 'sk-[REDACTED]')
    .replace(/typesafe_[a-zA-Z0-9_\-]{20,}/g, 'typesafe_[REDACTED]')
    .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]')
    .replace(/ey[A-Za-z0-9_-]{15,}\.ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g, '[JWT_REDACTED]')
    .replace(/(password|passwd|pwd|secret|token)\s*[:=]\s*["']?[^"'\s,;]{4,}["']?/gi, '$1: [REDACTED]')
    .replace(/[A-Z]:\\Users\\[a-zA-Z0-9_\-]+/gi, 'C:\\Users\\[USER]')
    .replace(/\/home\/[a-zA-Z0-9_\-]+/g, '/home/[USER]');
}

/**
 * Redact secrets, tokens, passwords and host usernames from state
 */
function redactSupervisorState(rawState) {
  if (!rawState || typeof rawState !== 'object') return {};

  const state = { ...rawState };

  if (typeof state.goal === 'string') {
    state.goal = redactText(state.goal).slice(0, 600);
  }
  if (typeof state.pane_tail === 'string') {
    const redacted = redactText(state.pane_tail);
    state.pane_tail = redacted.length > 1200 ? redacted.slice(-1200) : redacted;
  }
  if (typeof state.git_status === 'string') {
    state.git_status = redactText(state.git_status).slice(0, 600);
  }
  if (state.lease && typeof state.lease === 'object') {
    state.lease = {
      owner: typeof state.lease.owner === 'string' ? redactText(state.lease.owner) : state.lease.owner,
      expires_at: state.lease.expires_at
    };
  }

  return state;
}

/**
 * Resolve TypeSafe API Key
 */
function resolveApiKey(overrideKey) {
  if (overrideKey) return overrideKey;
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();

  try {
    if (fs.existsSync(CACHED_KEY_FILE)) {
      const key = fs.readFileSync(CACHED_KEY_FILE, 'utf8').trim();
      if (key) return key;
    }
  } catch (_) {}

  try {
    if (fs.existsSync(USER_CACHED_KEY)) {
      const key = fs.readFileSync(USER_CACHED_KEY, 'utf8').trim();
      if (key) return key;
    }
  } catch (_) {}

  try {
    if (fs.existsSync(BW_SESSION_FILE)) {
      const session = fs.readFileSync(BW_SESSION_FILE, 'utf8').trim();
      if (session) {
        const out = execSync(
          'bw get item "typesafe" --session ' + session,
          { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const item = JSON.parse(out);
        const secret = item?.fields?.find(f => f.name === 'api_key')?.value || item?.login?.password;
        if (secret) {
          try {
            fs.mkdirSync(path.dirname(CACHED_KEY_FILE), { recursive: true });
            fs.writeFileSync(CACHED_KEY_FILE, secret, 'utf8');
          } catch (_) {}
          return secret;
        }
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Build questions payload for TypeSafe System One (4 nouls)
 */
function buildSupervisorPayload(state, options = {}) {
  const model = options.model || DEFAULT_MODEL;
  const redactedState = redactSupervisorState(state);

  return {
    model,
    state: redactedState,
    questions: {
      stuck: {
        type: 'noul',
        instructions: 'Evalúa si el agente está estancado o bloqueado.',
        criteria: {
          true: 'El agente repite el mismo fallo sin progreso, está congelado, o no produce actividad útil.',
          false: 'El agente está progresando normalmente o ya concluyó su trabajo sin bloqueos.'
        }
      },
      drifting: {
        type: 'noul',
        instructions: 'Evalúa si el agente se desvió del objetivo de la tarea asignada.',
        criteria: {
          true: 'El agente está modificando archivos ajenos, ejecutando tareas irrelevantes o ignorando el goal de la tarjeta.',
          false: 'El agente cumplió o se enfoca en el objetivo de la tarjeta.'
        }
      },
      done: {
        type: 'noul',
        instructions: 'Evalúa si el trabajo asignado en la tarjeta está completado.',
        criteria: {
          true: 'Los criterios de aceptación están cumplidos, las pruebas pasan, o el reporte final fue generado y la tarea concluyó.',
          false: 'El trabajo aún está en ejecución o restan tareas pendientes por resolver.'
        }
      },
      needs_operator: {
        type: 'noul',
        instructions: 'Evalúa si el agente requiere intervención del operador humano.',
        criteria: {
          true: 'El agente está pidiendo credenciales, confirmación de despliegue riesgoso o decisión de negocio al operador.',
          false: 'El agente puede continuar autónomamente sin requerir intervención humana.'
        }
      }
    }
  };
}

/**
 * Post JSON payload with AbortController and strict timeout
 */
function postJsonWithTimeout(urlStr, headers, payloadObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const data = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const reqHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': data.length
    };

    let settled = false;
    const req = client.request(url, {
      method: 'POST',
      headers: reqHeaders,
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode, body });
        }
      });
    });

    req.on('timeout', () => {
      if (!settled) {
        settled = true;
        req.destroy(new Error('TIMEOUT'));
        reject(new Error('TIMEOUT'));
      }
    });

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.write(data);
    req.end();
  });
}

/**
 * Query JEV System One with timeout and fallback
 */
async function queryJevSystemOne(state, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.JEV_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const endpoint = options.endpoint || process.env.TYPESAFE_ENDPOINT || DEFAULT_ENDPOINT;
  const apiKey = resolveApiKey(options.apiKey);

  const fallbackProbabilities = {
    stuck: 0,
    drifting: 0,
    done: 0,
    needs_operator: 0
  };

  if (!apiKey) {
    return {
      probabilities: fallbackProbabilities,
      verdict: 'unknown',
      input_tokens: 0,
      elapsed_ms: 0,
      fallback: true,
      error: 'missing_api_key'
    };
  }

  const payload = buildSupervisorPayload(state, options);
  const headers = { Authorization: 'Bearer ' + apiKey };

  const t0 = Date.now();
  try {
    const res = await postJsonWithTimeout(endpoint, headers, payload, timeoutMs);
    const elapsed_ms = Date.now() - t0;

    if (res.statusCode === 429) {
      return {
        probabilities: fallbackProbabilities,
        verdict: 'rate_limited',
        input_tokens: 0,
        elapsed_ms,
        fallback: true,
        error: 'HTTP 429 Rate Limit'
      };
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return {
        probabilities: fallbackProbabilities,
        verdict: 'api_error',
        input_tokens: 0,
        elapsed_ms,
        fallback: true,
        error: `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (_) {
      return {
        probabilities: fallbackProbabilities,
        verdict: 'malformed_json',
        input_tokens: 0,
        elapsed_ms,
        fallback: true,
        error: 'JSON parse failure'
      };
    }

    const answers = parsed?.answers;
    if (!answers || typeof answers !== 'object') {
      return {
        probabilities: fallbackProbabilities,
        verdict: 'missing_answers',
        input_tokens: parsed?.usage?.input_tokens || 0,
        elapsed_ms,
        fallback: true,
        error: 'Missing answers in payload'
      };
    }

    const extractProb = (field) => {
      const q = answers[field];
      if (!q) return 0;
      if (typeof q.noul === 'number') return q.noul;
      if (typeof q.probability === 'number') return q.probability;
      return 0;
    };

    const probabilities = {
      stuck: extractProb('stuck'),
      drifting: extractProb('drifting'),
      done: extractProb('done'),
      needs_operator: extractProb('needs_operator')
    };

    // Synthesize dominant verdict
    let verdict = 'active';
    if (probabilities.done >= 0.70) verdict = 'done';
    else if (probabilities.needs_operator >= 0.60) verdict = 'needs_operator';
    else if (probabilities.stuck >= 0.60) verdict = 'stuck';
    else if (probabilities.drifting >= 0.60) verdict = 'drifting';

    return {
      probabilities,
      verdict,
      input_tokens: parsed?.usage?.input_tokens || 0,
      elapsed_ms,
      fallback: false,
      error: null
    };
  } catch (err) {
    const elapsed_ms = Date.now() - t0;
    const isTimeout = err.message === 'TIMEOUT';
    return {
      probabilities: fallbackProbabilities,
      verdict: isTimeout ? 'timeout' : 'error',
      input_tokens: 0,
      elapsed_ms,
      fallback: true,
      error: err.message
    };
  }
}

/**
 * Capture pane tail from WezTerm if pane is accessible
 */
function capturePaneTail(paneOwner, defaultTail = '') {
  if (!paneOwner) return defaultTail;
  const match = String(paneOwner).match(/pane-(\d+)/i);
  if (!match) return defaultTail;

  const paneId = Number(match[1]);
  try {
    const wez = require('./wezterm.cjs');
    const text = wez.getFullText(paneId, 40);
    if (text && text.trim().length > 0) {
      return text.trim();
    }
  } catch (_) {}

  return defaultTail;
}

/**
 * Capture git status from repo directory
 */
function captureGitStatus(repoName) {
  if (!repoName) return '';
  const repoPath = path.resolve(REPO_ROOT, '..', repoName);
  try {
    if (fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, '.git'))) {
      const out = execSync('git status --short', {
        cwd: repoPath,
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return out.trim();
    }
  } catch (_) {}
  return '';
}

/**
 * Assemble state for a task card
 */
function assembleTaskState(card, options = {}) {
  const taskId = card.id;
  const goal = card.goal || card.title || '';
  const repo = card.repo || '';
  const lease = card.lease || null;

  let paneTail = options.pane_tail;
  if (paneTail === undefined) {
    paneTail = capturePaneTail(lease?.owner);
    const resultPath = path.join(INTEL_DIR, 'results', `${taskId}-result.md`);
    if (fs.existsSync(resultPath)) {
      try {
        const reportContent = fs.readFileSync(resultPath, 'utf8').slice(0, 800);
        if (!paneTail || paneTail.trim().length === 0) {
          paneTail = reportContent;
        } else {
          paneTail = paneTail + '\n\n' + reportContent;
        }
      } catch (_) {}
    }
    if (!paneTail || paneTail.trim().length === 0) {
      paneTail = card.evaluator_evidence || card.next_action || '';
    }
  }

  let gitStatus = options.git_status;
  if (gitStatus === undefined) {
    gitStatus = captureGitStatus(repo);
  }

  return {
    task_id: taskId,
    goal,
    repo,
    lease,
    pane_tail: paneTail,
    git_status: gitStatus
  };
}

/**
 * Log shadow record to _intel/jev-shadow/panes.jsonl
 */
function logShadowRecord(record, shadowFile = SHADOW_LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(shadowFile), { recursive: true });
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(shadowFile, line, 'utf8');
  } catch (err) {
    console.error('Foreman shadow log failed:', err.message);
  }
}

/**
 * Supervise a single task
 */
async function superviseTask(cardOrId, options = {}) {
  let card = cardOrId;
  if (typeof cardOrId === 'string') {
    const cardPath = path.join(TASKS_DIR, `${cardOrId}.json`);
    if (!fs.existsSync(cardPath)) {
      throw new Error(`Task card not found: ${cardPath}`);
    }
    card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  }

  const state = assembleTaskState(card, options);
  const result = await queryJevSystemOne(state, options);

  const shadowRecord = {
    time: new Date().toISOString(),
    task_id: card.id,
    repo: card.repo,
    lease: card.lease,
    probabilities: result.probabilities,
    verdict: result.verdict,
    elapsed_ms: result.elapsed_ms,
    input_tokens: result.input_tokens,
    fallback: result.fallback,
    error: result.error
  };

  if (!options.skipLogging) {
    logShadowRecord(shadowRecord, options.shadowFile);
  }

  return shadowRecord;
}

/**
 * Run fleet supervisor over all running tasks or target task list
 */
async function runFleetSupervisor(options = {}) {
  const targetIds = options.targetIds || null;
  const tasksDir = options.tasksDir || TASKS_DIR;

  if (!fs.existsSync(tasksDir)) {
    return [];
  }

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
  const cards = [];

  for (const f of files) {
    try {
      const card = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
      if (targetIds && targetIds.length > 0) {
        if (targetIds.includes(card.id)) {
          cards.push(card);
        }
      } else if (card.state === 'running') {
        cards.push(card);
      }
    } catch (_) {}
  }

  const results = [];
  for (const card of cards) {
    const res = await superviseTask(card, options);
    results.push(res);
  }

  return results;
}

// Direct CLI execution
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let targetIds = null;
    const taskIdx = args.indexOf('--tasks');
    if (taskIdx !== -1 && args[taskIdx + 1]) {
      targetIds = args[taskIdx + 1].split(',').map(s => s.trim());
    }

    console.log(`[foreman-supervisor-jev] Running fleet supervisor (targets: ${targetIds ? targetIds.join(', ') : 'state=running'})...`);
    const results = await runFleetSupervisor({ targetIds });
    console.log(`[foreman-supervisor-jev] Processed ${results.length} tasks:`);
    for (const r of results) {
      console.log(`  - ${r.task_id} (${r.repo}): verdict=${r.verdict} | prob: done=${r.probabilities.done}, stuck=${r.probabilities.stuck}, drifting=${r.probabilities.drifting}, needs_operator=${r.probabilities.needs_operator} (${r.elapsed_ms}ms, fallback=${r.fallback})`);
    }
  })().catch(err => {
    console.error('[foreman-supervisor-jev] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  redactSupervisorState,
  buildSupervisorPayload,
  queryJevSystemOne,
  assembleTaskState,
  logShadowRecord,
  superviseTask,
  runFleetSupervisor,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_ENDPOINT
};
