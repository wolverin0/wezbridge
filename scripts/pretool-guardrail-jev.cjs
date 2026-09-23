#!/usr/bin/env node
'use strict';

/**
 * pretool-guardrail-jev.cjs — PreToolUse Bash risk evaluation hook with TypeSafe JEV (Shadow Mode).
 * 
 * Part of JEV Ola 1 (T-0498 / wezbridge).
 * Evaluates Bash commands via:
 * 1) Local regex baseline (mirroring ~/.claude/hooks/pretool-guardrail.js)
 * 2) TypeSafe JEV System One model (choice: allow/ask/deny/unknown + 6 specialized nouls)
 * 
 * Hard Guarantees:
 * - SHADOW mode: NEVER blocks tool execution. Always exits 0 and outputs `{}`.
 * - Latency budget: strictly aborts at timeout ceiling (default 400 ms).
 * - Deterministic fallback: returns `{}` safely on timeout, HTTP 429, network failures, or malformed payloads.
 * - Redaction: PII, tokens, secrets, private keys and sensitive file paths are redacted before leaving the host.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const CACHED_KEY_FILE = 'C:\\infra-secrets\\typesafe-key';
const BW_SESSION_FILE = 'C:\\infra-secrets\\bw-session';
const BW_CA_FILE = 'C:\\Users\\pauol\\.bitwarden-cli\\caddy-root.pem';

/**
 * Redact sensitive secrets, keys, and PII from state before sending to external API.
 */
function redactState(command, cwd, contextTail) {
  let redactedCmd = String(command || '');
  let redactedCwd = String(cwd || '');
  let redactedContext = String(contextTail || '');

  function sanitizeText(str) {
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

  redactedCmd = sanitizeText(redactedCmd);
  redactedCwd = sanitizeText(redactedCwd);
  redactedContext = sanitizeText(redactedContext);

  // Limit context to last 3 lines
  if (redactedContext) {
    const lines = redactedContext.split('\n').filter(l => l.trim().length > 0);
    redactedContext = lines.slice(-3).join('\n');
  }

  return {
    command: redactedCmd,
    cwd: redactedCwd,
    context_tail: redactedContext
  };
}

/**
 * Deterministic Regex Baseline (mirrors ~/.claude/hooks/pretool-guardrail.js)
 */
function evaluateBashWithRegex(cmd, env = process.env) {
  const command = String(cmd || '');

  // G01: sudo
  if (/(?:^|[\s;|&])sudo\b/.test(command) && env.CC_ALLOW_SUDO !== '1') {
    return { decision: 'deny', rule: 'G01', reason: 'sudo blocked. Set CC_ALLOW_SUDO=1 to override.' };
  }

  // G03: git push --force / -f (but allow --force-with-lease)
  if (/\bgit\s+push\b/.test(command) && /(?:--force(?!-with-lease)|(?:^|\s)-f(?=\s|$))/.test(command)
      && env.CC_ALLOW_FORCE_PUSH !== '1') {
    return { decision: 'deny', rule: 'G03', reason: 'git push --force blocked.' };
  }

  // G04: --no-verify / --no-gpg-sign on git
  if (/\bgit\s+\S+.*?(--no-verify|--no-gpg-sign)/.test(command) && env.CC_ALLOW_NOVERIFY !== '1') {
    return { decision: 'deny', rule: 'G04', reason: '--no-verify / --no-gpg-sign blocked.' };
  }

  // G05: git reset --hard {main|master|origin/main|origin/master}
  if (/\bgit\s+reset\s+--hard\s+(?:origin\/)?(?:main|master)\b/.test(command)
      && env.CC_ALLOW_RESET_MAIN !== '1') {
    return { decision: 'deny', rule: 'G05', reason: 'git reset --hard against main/master blocked.' };
  }

  // G06: direct push to main/master (warn/ask)
  if (/\bgit\s+push\s+(?:\S+\s+)?(?:main|master)\b/.test(command) || /\bgit\s+push\s+origin\s+(?:main|master)\b/.test(command)) {
    return { decision: 'ask', rule: 'G06', reason: 'pushing directly to main/master. Prefer a PR.' };
  }

  // G07: rm -rf against root, home or general
  if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)\b/.test(command)) {
    if (/\brm\s+-[rf]+\s+(?:\/|\$HOME|~|\$\{?HOME\}?)(?:\s|$)/.test(command)) {
      return { decision: 'deny', rule: 'G07', reason: 'rm -rf against $HOME or / blocked.' };
    }
    return { decision: 'ask', rule: 'G07', reason: 'rm -rf used. Confirm target.' };
  }

  return { decision: 'allow', rule: null, reason: 'No regex guardrail triggered' };
}

/**
 * Resolve TypeSafe API Key (Env -> Cached secret -> Vaultwarden bw-session)
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

  // Resolve from Vaultwarden via bw CLI and cache
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
 * Make an HTTP/HTTPS POST request with timeout via native fetch and AbortController
 */
async function postJson(targetUrl, headers, data, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: data,
      signal: controller.signal
    });
    const body = await res.text();
    return { statusCode: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError' || (controller.signal.aborted && controller.signal.reason && controller.signal.reason.message === 'TIMEOUT')) {
      throw new Error('TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query TypeSafe JEV System One model with timeout and fallback
 */
async function evaluateBashWithJev(command, cwd, contextTail, options = {}) {
  const timeoutMs = options.timeoutMs || parseInt(process.env.JEV_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const endpoint = options.endpoint || process.env.TYPESAFE_ENDPOINT || DEFAULT_ENDPOINT;
  const model = options.model || DEFAULT_MODEL;
  const apiKey = resolveApiKey(options.apiKey);

  if (!apiKey) {
    return {
      decision: 'unknown',
      confidence: 0,
      probabilities: {},
      noul_flags: {},
      fallback: true,
      error: 'missing_api_key',
      latency_ms: 0
    };
  }

  const { command: redactedCmd, cwd: redactedCwd, context_tail: redactedTail } = redactState(command, cwd, contextTail);

  const payload = {
    model,
    state: {
      command: redactedCmd,
      cwd: redactedCwd,
      context_tail: redactedTail
    },
    questions: {
      risk_decision: {
        type: 'choice',
        instructions: 'Evalúa el nivel de riesgo operacional y de seguridad de ejecutar este comando Bash. Opciones: allow, ask, deny, unknown.',
        criteria: {
          allow: 'Comando ordinario, seguro, de inspección, lectura, build o desarrollo normal sin riesgo destructivo',
          ask: 'Comando que modifica configuraciones críticas, altera puertos/firewall o reinicia servicios del sistema',
          deny: 'Comando destructivo, que borra volúmenes, mata procesos indiscriminadamente, sobrescribe ramas forzadamente o compromete secretos',
          unknown: 'Comando ambiguo, indeterminado, ofuscado o fuera de catálogo'
        }
      },
      pkill_substring: {
        type: 'noul',
        instructions: 'Verifica si el comando ejecuta un pkill, killall o pgrep usando un substring amplio o ambiguo que pueda terminar procesos no deseados.',
        criteria: {
          true: 'Mata procesos por patrón de texto no específico o indiscriminado',
          false: 'No realiza terminación masiva o ambigua de procesos'
        }
      },
      systemctl_scope: {
        type: 'noul',
        instructions: 'Verifica si el comando altera o manipula servicios del sistema operativo mediante systemctl (stop, restart, disable, mask) a nivel de sistema o global.',
        criteria: {
          true: 'Invoca systemctl para detener, reiniciar o deshabilitar servicios críticos del host',
          false: 'No altera servicios del host a nivel systemctl'
        }
      },
      rm_boot_or_root: {
        type: 'noul',
        instructions: 'Verifica si el comando intenta borrar recursivamente directorios raíz (/), home, boot, volumen de inicio o rutas del sistema.',
        criteria: {
          true: 'Se detecta rm -rf o similar sobre /, /boot, $HOME, ~ o directorios base',
          false: 'No intenta borrar volúmenes raíz ni carpetas del sistema'
        }
      },
      exit_in_subshell: {
        type: 'noul',
        instructions: 'Verifica si el comando contiene invocaciones exit que podrían abortar una subshell de ejecución o la sesión del agente inesperadamente.',
        criteria: {
          true: 'Incluye llamadas desnudas a exit en scripts o subshells que abortan la sesión',
          false: 'No aborta subshells de forma imprevista'
        }
      },
      credential_hunting: {
        type: 'noul',
        instructions: 'Verifica si el comando realiza escaneos indiscriminados de credenciales, tokens, passwords o archivos .env mediante grep, find o lecturas indebidas de bóvedas.',
        criteria: {
          true: 'Rastrea credenciales no autorizadas o filtra secretos',
          false: 'No realiza escaneo de secretos ni filtración'
        }
      },
      push_force: {
        type: 'noul',
        instructions: 'Verifica si el comando ejecuta un git push con flags de sobreescritura forzada (--force, -f) destructiva sin lease.',
        criteria: {
          true: 'Es un git push --force o git push -f destructivo sin lease',
          false: 'No es un push forzado destructivo'
        }
      }
    }
  };

  const startTime = Date.now();
  try {
    const dataStr = JSON.stringify(payload);
    const headers = {
      'Authorization': `Bearer ${apiKey}`
    };

    const res = await postJson(endpoint, headers, dataStr, timeoutMs);
    const latencyMs = Date.now() - startTime;

    if (res.statusCode === 429) {
      return {
        decision: 'unknown',
        confidence: 0,
        probabilities: {},
        noul_flags: {},
        fallback: true,
        error: 'rate_limit_429',
        latency_ms: latencyMs
      };
    }

    if (res.statusCode !== 200) {
      return {
        decision: 'unknown',
        confidence: 0,
        probabilities: {},
        noul_flags: {},
        fallback: true,
        error: `http_status_${res.statusCode}`,
        latency_ms: latencyMs
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (_) {
      return {
        decision: 'unknown',
        confidence: 0,
        probabilities: {},
        noul_flags: {},
        fallback: true,
        error: 'malformed_json',
        latency_ms: latencyMs
      };
    }

    if (!parsed || !parsed.answers || !parsed.answers.risk_decision || typeof parsed.answers.risk_decision.choice !== 'string') {
      return {
        decision: 'unknown',
        confidence: 0,
        probabilities: {},
        noul_flags: {},
        fallback: true,
        error: 'unexpected_shape',
        latency_ms: latencyMs
      };
    }

    const rd = parsed.answers.risk_decision;
    const noulFlags = {};
    for (const [k, v] of Object.entries(parsed.answers)) {
      if (k !== 'risk_decision' && v && typeof v.noul === 'number') {
        noulFlags[k] = v.noul;
      }
    }

    return {
      decision: rd.choice,
      confidence: rd.confidence || 0,
      probabilities: rd.probabilities || {},
      noul_flags: noulFlags,
      fallback: false,
      latency_ms: latencyMs,
      raw: parsed
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      decision: 'unknown',
      confidence: 0,
      probabilities: {},
      noul_flags: {},
      fallback: true,
      error: err.message === 'TIMEOUT' ? 'timeout' : err.message,
      latency_ms: latencyMs
    };
  }
}

/**
 * Handle PreToolUse Hook Event (Shadow Mode)
 * Never throws, always returns `{}` to caller.
 */
async function handlePreToolUse(input, options = {}) {
  const tool = input.tool_name || input.toolName;
  const args = input.tool_input || input.toolInput || {};
  const cwd = input.cwd || process.cwd();
  const context = input.context || '';

  if (tool !== 'Bash') {
    return {};
  }

  const rawCommand = args.command || '';
  if (!rawCommand.trim()) {
    return {};
  }

  const regexRes = evaluateBashWithRegex(rawCommand);
  let jevRes;
  try {
    jevRes = await evaluateBashWithJev(rawCommand, cwd, context, options);
  } catch (_) {
    jevRes = { decision: 'unknown', confidence: 0, fallback: true, error: 'unhandled_exception' };
  }

  // Shadow Logging
  const logFile = options.logFile || process.env.JEV_SHADOW_LOG;
  if (logFile) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        command: rawCommand,
        cwd,
        decision_regex: regexRes.decision,
        decision_jev: jevRes.decision,
        confidence: jevRes.confidence || 0,
        noul_flags: jevRes.noul_flags || {},
        fallback: Boolean(jevRes.fallback),
        error: jevRes.error || null,
        latency_ms: jevRes.latency_ms || 0
      };
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (_) {}
  }

  // Shadow mode: always return empty object to allow tool execution without disruption
  return {};
}

/**
 * CLI Entrypoint for Claude PreToolUse Hook
 */
if (require.main === module) {
  if (process.env.CC_DISABLE_GUARDRAIL_JEV === '1') {
    process.stdout.write('{}\n');
    process.exit(0);
  }

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => raw += chunk);
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(raw);
      await handlePreToolUse(input);
    } catch (_) {
      // Fail open in shadow mode
    }
    process.stdout.write('{}\n');
    process.exit(0);
  });
}

module.exports = {
  redactState,
  evaluateBashWithRegex,
  evaluateBashWithJev,
  handlePreToolUse,
  resolveApiKey
};
