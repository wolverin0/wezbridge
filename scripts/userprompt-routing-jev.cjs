#!/usr/bin/env node
'use strict';

/**
 * userprompt-routing-jev.cjs — UserPromptSubmit skill and model tier routing hook with TypeSafe JEV (Shadow Mode).
 * 
 * Part of JEV Ola 1 (T-0499 / wezbridge).
 * Evaluates user prompts via TypeSafe JEV System One:
 * 1) Suggested Skill (Choice over high-priority curated catalogue + 'none' / 'other')
 * 2) Suggested Model Tier (Choice over {haiku, sonnet, opus, codex, other})
 * 
 * Hard Guarantees:
 * - SHADOW mode: NEVER alters or blocks user prompts. Always exits 0 and outputs `{}`.
 * - Latency budget: strictly aborts at timeout ceiling (default 400 ms).
 * - Deterministic fallback: returns `{}` safely on timeout, HTTP 429, network failures, or malformed payloads.
 * - Redaction: PII, tokens, secrets, private keys and sensitive file paths are redacted before leaving the host.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const CACHED_KEY_FILE = 'C:\\infra-secrets\\typesafe-key';
const BW_SESSION_FILE = 'C:\\infra-secrets\\bw-session';
const BW_CA_FILE = 'C:\\Users\\pauol\\.bitwarden-cli\\caddy-root.pem';

/**
 * High-priority curated skill catalog with escape options
 */
const SKILL_CATALOG = {
  'ui-ux-pro-max': 'Diseño de interfaz de usuario, maquetado web/móvil, CSS/Tailwind, estética, componentes visuales o diseño responsivo',
  'tdd-workflow': 'Metodología TDD, red-green-refactor, creación de tests unitarios/integración, o depuración guiada por pruebas',
  'codebase-investigator': 'Análisis profundo de arquitectura, mapa de dependencias, auditoría de código complejo o exploración de base de código amplia',
  'security-review': 'Auditoría de seguridad, vulnerabilidades CVE, revisión de secretos, permisos, criptografía o autenticación',
  'sparc-methodology': 'Desarrollo estructurado SPARC (Especificación, Pseudocódigo, Arquitectura, Refinamiento, Completitud)',
  'pr-writer': 'Generación de pull requests, notas de release, resúmenes de cambios para Git o resúmenes de PR',
  'none': 'Consultas ordinarias, preguntas generales, operaciones de archivo comunes o tareas que no requieren una skill especializada',
  'other': 'Requiere otra skill especializada que no pertenece a esta lista de alta prioridad'
};

/**
 * Model tier options
 */
const TIER_CATALOG = {
  'haiku': 'Tareas simples, rápidas, transformaciones menores de texto/código, lookups, scripts directos o comandos simples',
  'sonnet': 'Desarrollo de software estándar, refactorización, implementación de funciones, tests y resolución de bugs habituales',
  'opus': 'Razonamiento arquitectónico complejo, diseño de sistemas de gran escala, auditorías de seguridad críticas o planificación multidominio',
  'codex': 'Tareas masivas o de backend automatizado especializado en código',
  'other': 'No clasificable en los tiers estándar'
};

/**
 * Redact sensitive secrets, keys, and PII from state before sending to external API.
 */
function redactPromptState(prompt, cwd) {
  let redactedPrompt = String(prompt || '');
  let redactedCwd = String(cwd || '');

  function sanitize(str) {
    return str
      .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{8,}/gi, '$1[REDACTED]')
      .replace(/([a-zA-Z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|auth)[a-zA-Z0-9_-]*\s*[:=]\s*["']?)[^"'\s;&|]+(["']?)/gi, '$1[REDACTED]$2')
      .replace(/ghp_[A-Za-z0-9_]{20,}/g, '[REDACTED_GH_TOKEN]')
      .replace(/sk-[A-Za-z0-9_\-]{20,}/g, '[REDACTED_APIKEY]')
      .replace(/typesafe_[A-Za-z0-9_]{20,}/g, '[REDACTED_TYPESAFE]')
      .replace(/-----BEGIN[ A-Z0-9_-]+PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED_JWT]')
      .replace(/\b[0-9a-fA-F]{32,64}\b/g, '[REDACTED_HASH]')
      .replace(/C:\\Users\\[a-zA-Z0-9_.-]+/gi, 'C:\\Users\\[USER]');
  }

  return {
    prompt: sanitize(redactedPrompt),
    cwd: sanitize(redactedCwd)
  };
}

/**
 * Resolve TypeSafe API Key
 */
function resolveApiKey(overrideKey) {
  if (overrideKey) return overrideKey;
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();

  // Check cached secret files
  try {
    if (fs.existsSync(CACHED_KEY_FILE)) {
      const key = fs.readFileSync(CACHED_KEY_FILE, 'utf8').trim();
      if (key) return key;
    }
  } catch (_) {}

  try {
    const userCachedKey = 'C:\\Users\\pauol\\.claude\\cache\\typesafe-key';
    if (fs.existsSync(userCachedKey)) {
      const key = fs.readFileSync(userCachedKey, 'utf8').trim();
      if (key) return key;
    }
  } catch (_) {}

  // Resolve from Vaultwarden via bw CLI
  try {
    if (fs.existsSync(BW_SESSION_FILE)) {
      const session = fs.readFileSync(BW_SESSION_FILE, 'utf8').trim();
      if (session) {
        const env = {
          ...process.env,
          BW_SESSION: session,
          NODE_EXTRA_CA_CERTS: BW_CA_FILE
        };
        const stdout = execSync('bw get item typesafe', { env, encoding: 'utf8', shell: true, timeout: 8000 });
        const item = JSON.parse(stdout);
        const apiKey = (item.login && item.login.password) ? item.login.password.trim() : (item.notes ? item.notes.trim() : null);
        if (apiKey) {
          try {
            fs.writeFileSync(CACHED_KEY_FILE, apiKey, { encoding: 'utf8', mode: 0o600 });
          } catch (_) {}
          return apiKey;
        }
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Query TypeSafe JEV System One model for Skill and Model Tier routing
 */
async function evaluatePromptRoutingWithJev(prompt, cwd, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.JEV_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const endpoint = options.endpoint || process.env.TYPESAFE_ENDPOINT || DEFAULT_ENDPOINT;
  const model = options.model || DEFAULT_MODEL;
  const apiKey = resolveApiKey(options.apiKey);

  if (!apiKey) {
    return {
      suggested_skill: 'none',
      skill_confidence: 0,
      suggested_tier: 'sonnet',
      tier_confidence: 0,
      fallback: true,
      error: 'missing_api_key',
      latency_ms: 0,
      usage: {}
    };
  }

  const { prompt: redactedPrompt, cwd: redactedCwd } = redactPromptState(prompt, cwd);

  const payload = {
    model,
    state: {
      prompt: redactedPrompt,
      cwd: redactedCwd
    },
    questions: {
      suggested_skill: {
        type: 'choice',
        instructions: 'Identifica si el prompt del usuario requiere activar una skill de desarrollo especializada de alta prioridad. Si ninguna de las skills especializadas aplica, elige "none". Si requiere una skill especializada no listada, elige "other".',
        criteria: SKILL_CATALOG
      },
      suggested_tier: {
        type: 'choice',
        instructions: 'Clasifica el nivel de capacidad y razonamiento de modelo (tier) requerido para resolver el prompt del usuario de forma óptima y eficiente.',
        criteria: TIER_CATALOG
      }
    }
  };

  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const latencyMs = Date.now() - startTime;

    if (res.status === 429) {
      return {
        suggested_skill: 'none',
        skill_confidence: 0,
        suggested_tier: 'sonnet',
        tier_confidence: 0,
        fallback: true,
        error: 'rate_limit_429',
        latency_ms: latencyMs,
        usage: {}
      };
    }

    if (res.status !== 200) {
      return {
        suggested_skill: 'none',
        skill_confidence: 0,
        suggested_tier: 'sonnet',
        tier_confidence: 0,
        fallback: true,
        error: `http_status_${res.status}`,
        latency_ms: latencyMs,
        usage: {}
      };
    }

    const bodyText = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch (_) {
      return {
        suggested_skill: 'none',
        skill_confidence: 0,
        suggested_tier: 'sonnet',
        tier_confidence: 0,
        fallback: true,
        error: 'malformed_json',
        latency_ms: latencyMs,
        usage: {}
      };
    }

    if (!parsed || !parsed.answers || !parsed.answers.suggested_skill || !parsed.answers.suggested_tier) {
      return {
        suggested_skill: 'none',
        skill_confidence: 0,
        suggested_tier: 'sonnet',
        tier_confidence: 0,
        fallback: true,
        error: 'unexpected_shape',
        latency_ms: latencyMs,
        usage: {}
      };
    }

    const skillAnswer = parsed.answers.suggested_skill;
    const tierAnswer = parsed.answers.suggested_tier;

    return {
      suggested_skill: skillAnswer.choice,
      skill_confidence: skillAnswer.confidence || 0,
      skill_probabilities: skillAnswer.probabilities || {},
      suggested_tier: tierAnswer.choice,
      tier_confidence: tierAnswer.confidence || 0,
      tier_probabilities: tierAnswer.probabilities || {},
      fallback: false,
      latency_ms: latencyMs,
      usage: parsed.usage || {},
      raw: parsed
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      suggested_skill: 'none',
      skill_confidence: 0,
      suggested_tier: 'sonnet',
      tier_confidence: 0,
      fallback: true,
      error: (err.name === 'AbortError' || controller.signal.aborted) ? 'timeout' : err.message,
      latency_ms: latencyMs,
      usage: {}
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handle UserPromptSubmit Hook Event (Shadow Mode)
 * Never throws, always returns `{}` to caller.
 */
async function handleUserPromptSubmit(input, options = {}) {
  const prompt = input.prompt || input.text || '';
  const cwd = input.cwd || process.cwd();

  if (!prompt.trim()) {
    return {};
  }

  let jevRes;
  try {
    jevRes = await evaluatePromptRoutingWithJev(prompt, cwd, options);
  } catch (_) {
    jevRes = {
      suggested_skill: 'none',
      skill_confidence: 0,
      suggested_tier: 'sonnet',
      tier_confidence: 0,
      fallback: true,
      error: 'unhandled_exception',
      latency_ms: 0
    };
  }

  // Shadow Logging
  const logFile = options.logFile || process.env.JEV_ROUTING_SHADOW_LOG;
  if (logFile) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        prompt: prompt.length > 200 ? prompt.substring(0, 197) + '...' : prompt,
        cwd,
        suggested_skill: jevRes.suggested_skill,
        skill_confidence: jevRes.skill_confidence,
        suggested_tier: jevRes.suggested_tier,
        tier_confidence: jevRes.tier_confidence,
        fallback: Boolean(jevRes.fallback),
        error: jevRes.error || null,
        latency_ms: jevRes.latency_ms || 0,
        tokens: jevRes.usage || {}
      };
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (_) {}
  }

  // Shadow mode: always return empty object so user experience is never modified
  return {};
}

/**
 * CLI Entrypoint for Claude UserPromptSubmit Hook
 */
if (require.main === module) {
  if (process.env.CC_DISABLE_ROUTING_JEV === '1') {
    process.stdout.write('{}\n');
    process.exit(0);
  }

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => raw += chunk);
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(raw);
      await handleUserPromptSubmit(input);
    } catch (_) {
      // Fail open in shadow mode
    }
    process.stdout.write('{}\n');
    process.exit(0);
  });
}

module.exports = {
  SKILL_CATALOG,
  TIER_CATALOG,
  redactPromptState,
  evaluatePromptRoutingWithJev,
  handleUserPromptSubmit,
  resolveApiKey
};
