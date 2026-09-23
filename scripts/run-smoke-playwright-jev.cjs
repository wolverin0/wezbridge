#!/usr/bin/env node
'use strict';
/**
 * scripts/run-smoke-playwright-jev.cjs
 *
 * Shadow JEV evaluator for the Playwright validation runner.
 * Evaluates in parallel to the 4 deterministic / regex decision points:
 *   1. isDestructiveLabel (choice: allow, ask, deny)
 *   2. safe button semantics (choice: safe_action, needs_open_state, destructive, unknown)
 *   3. post-click observable change (noul: observable_change)
 *   4. checkRoute health (choice: healthy, degraded, broken, unknown)
 *
 * Emits telemetry and comparison logs to _intel/results/T-0502-shadow-run.jsonl.
 * Strict ceiling <400ms, deterministic fallback on error/timeout, PII/secret redaction.
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
const DEFAULT_SHADOW_LOG = path.join(INTEL_DIR, 'results', 'T-0502-shadow-run.jsonl');

/**
 * Original regex from validation runner line 440
 */
function isDestructiveLabelRegex(label) {
  return /delete|remove|borrar|eliminar|cerrar sesi|logout|sign out|pagar|cobrar|guardar|save|submit|enviar|confirmar|aprobar|rechazar/i.test(label || '');
}

/**
 * Original regex for safe button semantics from line 471
 */
function classifySafeButtonRegex(label, type) {
  const clean = String(label || '').trim();
  if (type === 'a') return { category: 'safe_action', reason: null };
  if (type === 'button' || type === '[role="button"]') {
    if (/^cerrar\b|^close\b|^x$/i.test(clean)) {
      return { category: 'needs_open_state', reason: 'close-control-requires-open-state' };
    }
    if (/\b(open|abrir|view|ver|details?|detalles?|info|more|mas|m[aá]s|expand|expandir|show|mostrar|preview|previsualizar|config|configurar|settings|ajustes|opciones|options|filter|filtro|filtrar|search|buscar|menu|men[uú]|tab|panel|nuevo|nueva|new|add|agregar|a[nñ]adir|create|crear|edit|editar)\b/i.test(clean)) {
      return { category: 'safe_action', reason: null };
    }
    return { category: 'unknown', reason: 'unsupported-safe-button-semantics' };
  }
  return { category: 'unknown', reason: 'form-field-requires-flow-plan' };
}

/**
 * Redact text to protect tokens, passwords and paths
 */
function redactValidationText(text) {
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
        const out = execSync('bw get item "typesafe" --session ' + session, {
          timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        const item = JSON.parse(out);
        const secret = item?.fields?.find(f => f.name === 'api_key')?.value || item?.login?.password;
        if (secret) return secret;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Low-level HTTP POST with timeout
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
 * Query JEV for element classification (Decision 1 & 2)
 */
async function evaluateElementWithJev(element, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.JEV_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const endpoint = options.endpoint || process.env.TYPESAFE_ENDPOINT || DEFAULT_ENDPOINT;
  const apiKey = resolveApiKey(options.apiKey);

  const cleanLabel = redactValidationText(String(element.label || '')).slice(0, 200);
  const cleanType = String(element.type || 'button').slice(0, 50);
  const cleanRoute = String(element.route || '/').slice(0, 100);

  const fallback = {
    destructive_risk: 'allow',
    destructive_confidence: 0,
    button_semantic: 'safe_action',
    semantic_confidence: 0,
    fallback: true,
    error: apiKey ? 'api_unavailable' : 'missing_api_key',
    latency_ms: 0
  };

  if (!apiKey) return fallback;

  const payload = {
    model: options.model || DEFAULT_MODEL,
    state: {
      element_label: cleanLabel,
      element_type: cleanType,
      route: cleanRoute
    },
    questions: {
      destructive_risk: {
        type: 'choice',
        instructions: 'Evalúa si presionar este elemento en un smoke test interactivo representa un riesgo destructivo (borrar datos, pagar o cerrar sesión).',
        criteria: {
          allow: 'Acción ordinaria y segura: navegar, filtrar catálogo, abrir modal, agregar producto o consultar asesor',
          ask: 'Acción sensible pero no irreversible: guardar borrador, cotizar formalmente o enviar formulario preliminar',
          deny: 'Acción destructiva o de sesión: eliminar cuenta, vaciar base de datos, cancelar pedido definitivamente o cerrar sesión forzada'
        }
      },
      button_semantic: {
        type: 'choice',
        instructions: 'Clasifica la semántica de interacción del botón para decidir si debe ser ejecutado en el smoke test.',
        criteria: {
          safe_action: 'Acción segura para explorar: abrir vista, cambiar pestaña, aplicar filtro, ver detalle, abrir modal o interactuar con producto',
          needs_open_state: 'Control de cierre (cerrar, close, x) que requiere que un modal o panel lateral esté abierto previamente',
          destructive: 'Acción destructiva o no deseada en un recorrido exploratorio',
          unknown: 'Elemento ambiguo, campo de entrada de texto no interactuable como botón, o control sin acción clara'
        }
      }
    }
  };

  const t0 = Date.now();
  try {
    const res = await postJsonWithTimeout(endpoint, { Authorization: 'Bearer ' + apiKey }, payload, timeoutMs);
    const latency_ms = Date.now() - t0;

    if (res.statusCode !== 200) {
      return { ...fallback, latency_ms, error: `HTTP ${res.statusCode}` };
    }

    const parsed = JSON.parse(res.body);
    const ans = parsed.answers || {};

    const destQ = ans.destructive_risk || {};
    const semQ = ans.button_semantic || {};

    return {
      destructive_risk: destQ.choice || 'allow',
      destructive_confidence: destQ.confidence || 0,
      destructive_probabilities: destQ.probabilities || {},
      button_semantic: semQ.choice || 'safe_action',
      semantic_confidence: semQ.confidence || 0,
      semantic_probabilities: semQ.probabilities || {},
      input_tokens: parsed.usage?.input_tokens || 0,
      fallback: false,
      error: null,
      latency_ms
    };
  } catch (err) {
    return {
      ...fallback,
      latency_ms: Date.now() - t0,
      error: err.message === 'TIMEOUT' ? 'timeout' : err.message
    };
  }
}

/**
 * Query JEV for post-click observable change (Decision 3)
 */
async function evaluateObservableChangeWithJev(stateDiff, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.JEV_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const endpoint = options.endpoint || process.env.TYPESAFE_ENDPOINT || DEFAULT_ENDPOINT;
  const apiKey = resolveApiKey(options.apiKey);

  const fallback = {
    observable_change: true,
    probability: 0,
    fallback: true,
    error: apiKey ? 'api_unavailable' : 'missing_api_key',
    latency_ms: 0
  };

  if (!apiKey) return fallback;

  const payload = {
    model: options.model || DEFAULT_MODEL,
    state: {
      action_label: redactValidationText(String(stateDiff.label || '')).slice(0, 150),
      url_before: String(stateDiff.url_before || ''),
      url_after: String(stateDiff.url_after || ''),
      url_changed: Boolean(stateDiff.url_changed),
      text_changed: Boolean(stateDiff.text_changed),
      dialog_visible: Boolean(stateDiff.dialog_visible),
      diff_snippet: redactValidationText(String(stateDiff.diff_snippet || '')).slice(0, 400)
    },
    questions: {
      observable_change: {
        type: 'noul',
        instructions: 'Determina si la acción del usuario provocó un cambio observable, útil o intencionado en la interfaz.',
        criteria: {
          true: 'Hubo navegación de URL, actualización de datos visibles, apertura/cierre de modal, o respuesta observable de la UI.',
          false: 'No ocurrió ningún cambio perceptible en la interfaz ni en el estado visual.'
        }
      }
    }
  };

  const t0 = Date.now();
  try {
    const res = await postJsonWithTimeout(endpoint, { Authorization: 'Bearer ' + apiKey }, payload, timeoutMs);
    const latency_ms = Date.now() - t0;

    if (res.statusCode !== 200) {
      return { ...fallback, latency_ms, error: `HTTP ${res.statusCode}` };
    }

    const parsed = JSON.parse(res.body);
    const q = parsed.answers?.observable_change || {};
    const prob = typeof q.noul === 'number' ? q.noul : (typeof q.probability === 'number' ? q.probability : 0);

    return {
      observable_change: prob >= 0.50,
      probability: prob,
      input_tokens: parsed.usage?.input_tokens || 0,
      fallback: false,
      error: null,
      latency_ms
    };
  } catch (err) {
    return {
      ...fallback,
      latency_ms: Date.now() - t0,
      error: err.message === 'TIMEOUT' ? 'timeout' : err.message
    };
  }
}

/**
 * Query JEV for route health check (Decision 4)
 */
async function evaluateRouteHealthWithJev(routeInfo, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.JEV_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const endpoint = options.endpoint || process.env.TYPESAFE_ENDPOINT || DEFAULT_ENDPOINT;
  const apiKey = resolveApiKey(options.apiKey);

  const fallback = {
    route_health: 'healthy',
    confidence: 0,
    probabilities: {},
    fallback: true,
    error: apiKey ? 'api_unavailable' : 'missing_api_key',
    latency_ms: 0
  };

  if (!apiKey) return fallback;

  const payload = {
    model: options.model || DEFAULT_MODEL,
    state: {
      route_path: String(routeInfo.path || '/'),
      route_label: String(routeInfo.label || ''),
      status_code: Number(routeInfo.status_code || 200),
      chars_rendered: Number(routeInfo.chars_rendered || 0),
      console_errors_count: Number(routeInfo.console_errors_count || 0),
      responsive_issues_high: Number(routeInfo.responsive_issues_high || 0),
      summary_text: redactValidationText(String(routeInfo.summary_text || '')).slice(0, 300)
    },
    questions: {
      route_health: {
        type: 'choice',
        instructions: 'Evalúa la salud operativa y visual de esta ruta renderizada de la aplicación.',
        criteria: {
          healthy: 'La ruta carga correctamente, muestra contenido visible relevante y no presenta errores críticos de consola o red',
          degraded: 'La ruta carga pero presenta advertencias de consola o defectos leves de layout responsivo',
          broken: 'Página en blanco, error 404/500, o falla crítica de renderizado que impide la experiencia',
          unknown: 'Estado ambiguo o datos insuficientes'
        }
      }
    }
  };

  const t0 = Date.now();
  try {
    const res = await postJsonWithTimeout(endpoint, { Authorization: 'Bearer ' + apiKey }, payload, timeoutMs);
    const latency_ms = Date.now() - t0;

    if (res.statusCode !== 200) {
      return { ...fallback, latency_ms, error: `HTTP ${res.statusCode}` };
    }

    const parsed = JSON.parse(res.body);
    const q = parsed.answers?.route_health || {};

    return {
      route_health: q.choice || 'healthy',
      confidence: q.confidence || 0,
      probabilities: q.probabilities || {},
      input_tokens: parsed.usage?.input_tokens || 0,
      fallback: false,
      error: null,
      latency_ms
    };
  } catch (err) {
    return {
      ...fallback,
      latency_ms: Date.now() - t0,
      error: err.message === 'TIMEOUT' ? 'timeout' : err.message
    };
  }
}

/**
 * Log shadow comparison entry to JSONL
 */
function logShadowEntry(entry, shadowFilePath = DEFAULT_SHADOW_LOG) {
  try {
    fs.mkdirSync(path.dirname(shadowFilePath), { recursive: true });
    fs.appendFileSync(shadowFilePath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('Shadow log append failed:', err.message);
  }
}

module.exports = {
  isDestructiveLabelRegex,
  classifySafeButtonRegex,
  redactValidationText,
  evaluateElementWithJev,
  evaluateObservableChangeWithJev,
  evaluateRouteHealthWithJev,
  logShadowEntry,
  DEFAULT_SHADOW_LOG,
  DEFAULT_TIMEOUT_MS
};
