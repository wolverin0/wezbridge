'use strict';
/**
 * catastrophic-commands.cjs — T-0568: classifies shell commands that can kill processes the
 * caller did not start, or take down the whole machine (mass taskkill/Stop-Process/pkill,
 * `kill -1` fan-out, shutdown/reboot, `wmic process delete`, un-scoped `docker stop|kill|rm`).
 * classifyCatastrophic(command) -> {deny, rule, reason}. Pure, no I/O — safe to `require()`
 * from any hook. Handles chaining (&&, ;, |, newlines) and wrapper shells (`cmd /c "..."`,
 * `powershell -Command "..."`, `bash -c '...'`), denying if ANY segment is catastrophic.
 * A command is only classified by the program it actually invokes (the first token of a
 * segment/pipeline-stage) — text that merely appears as an argument to an unrelated command
 * (e.g. `git commit -m "taskkill /IM"`, `grep taskkill file.txt`) is intentionally ALLOWED.
 * Root cause this guards against: a pedrito worker ran `taskkill /F /IM python.exe /T` to stop
 * its own preview server and killed every Python process on the host, including MemoryMaster
 * MCP. See wezbridge/test/catastrophic-commands.test.cjs and
 * _intel/briefs/2026-09-23-T0568-catastrophic-kill-guard.md.
 */

// Optional prefix before a command name: `sudo `, and/or a path-like prefix ending in / or \.
const PREFIX = String.raw`(?:sudo\s+)?(?:\S*[\\/])?`;

function rx(src, flags) {
  return new RegExp(src, flags || 'i');
}

// --- shell-chain / wrapper unwrapping (quote-aware) -----------------------------------------

const WRAPPERS = [
  rx(String.raw`^cmd(?:\.exe)?\s+/c\s+"([\s\S]*)"$`),
  rx(String.raw`^cmd(?:\.exe)?\s+/c\s+'([\s\S]*)'$`),
  rx(String.raw`^(?:powershell|pwsh)(?:\.exe)?\s+(?:-NoProfile\s+)?(?:-ExecutionPolicy\s+\S+\s+)?(?:-Command|-c)\s+"([\s\S]*)"$`),
  rx(String.raw`^(?:powershell|pwsh)(?:\.exe)?\s+(?:-NoProfile\s+)?(?:-ExecutionPolicy\s+\S+\s+)?(?:-Command|-c)\s+'([\s\S]*)'$`),
  rx(String.raw`^(?:bash|sh)\s+-c\s+"([\s\S]*)"$`),
  rx(String.raw`^(?:bash|sh)\s+-c\s+'([\s\S]*)'$`),
];

function unwrapOnce(str) {
  const t = str.trim();
  for (const re of WRAPPERS) {
    const m = t.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Quote-aware top-level splitter: calls isBoundary(str, i) -> 0 (no split) | N (split, skip N chars). */
function splitTopLevel(str, isBoundary) {
  const parts = [];
  let cur = '';
  let quote = null;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < str.length) { cur += str[i + 1]; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; i += 1; continue; }
    const n = isBoundary(str, i);
    if (n) { parts.push(cur); cur = ''; i += n; continue; }
    cur += ch;
    i += 1;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitStatements(str) {
  return splitTopLevel(str, (s, i) => {
    if (s[i] === '\n') return 1;
    if (s[i] === '&' && s[i + 1] === '&') return 2;
    if (s[i] === '|' && s[i + 1] === '|') return 2;
    if (s[i] === ';') return 1;
    if (s[i] === '&') return 1; // background operator
    return 0;
  });
}

function splitPipeline(str) {
  return splitTopLevel(str, (s, i) => (s[i] === '|' && s[i + 1] !== '|' ? 1 : 0));
}

/** Unwrap wrapper shells and flatten chained statements into atomic command strings. */
function getAtomicSegments(command, depth) {
  if (depth > 8) return [String(command)];
  const trimmed = String(command).trim();
  if (!trimmed) return [];
  const unwrapped = unwrapOnce(trimmed);
  if (unwrapped !== null) return getAtomicSegments(unwrapped, depth + 1);
  const statements = splitStatements(trimmed);
  if (statements.length > 1) return statements.flatMap((s) => getAtomicSegments(s, depth + 1));
  return [trimmed];
}

// --- rules ------------------------------------------------------------------------------------

// Composite rules: tested against a whole statement (pipe intact), for patterns that need the pipe.
const COMPOSITE_RULES = [
  {
    name: 'get_process_pipe_stop_process',
    test: (stmt) => rx(String.raw`Get-Process\b[^|]*\|\s*Stop-Process\b`).test(stmt)
      && !rx(String.raw`\|\s*Stop-Process\b[^|]*-Id\b`).test(stmt),
    reason: 'Get-Process <name> | Stop-Process kills every process matching that name via the '
      + 'pipeline. Stop only the PID you started: Stop-Process -Id <pid>.',
  },
  {
    name: 'docker_mass_stop_kill_rm',
    test: (stmt) => {
      const m = stmt.match(rx(String.raw`^${PREFIX}docker\s+(stop|kill|rm)\b(.*)$`, 'is'));
      if (!m) return false;
      const rest = m[2] || '';
      if (rx(String.raw`\$\(.*docker\s+ps.*\)|\`.*docker\s+ps.*\``, 'is').test(rest)) return true;
      if (rx(String.raw`(^|\s)(-a|--all)(\s|$)`).test(rest) && rx(String.raw`(^|\s)(-q|--quiet)(\s|$)`).test(rest)) return true;
      const stripped = rest.replace(rx(String.raw`(^|\s)(-f|--force|-t|--time)(\s+\S+)?`, 'gi'), ' ').trim();
      return stripped.length === 0; // no explicit container name/id left
    },
    reason: 'docker stop|kill|rm without an explicit container name/id can hit every container '
      + 'on the host. Pass the exact container name/id you started (docker stop <name>).',
  },
];

// Anchored rules: tested against a single pipeline stage (first token = the program invoked).
const ANCHORED_RULES = [
  {
    name: 'taskkill_by_image',
    test: (s) => rx(String.raw`^${PREFIX}taskkill(?:\.exe)?\b`).test(s)
      && rx(String.raw`(^|\s)(/im|-im)\b`).test(s),
    reason: 'taskkill /IM kills every process with that image name on the machine, not just the '
      + 'one you started. Kill only your PID: taskkill /PID <pid> /F.',
  },
  {
    name: 'stop_process_by_name',
    test: (s) => rx(String.raw`^${PREFIX}(stop-process|spps|kill)\b`).test(s)
      && rx(String.raw`(^|\s)-name\b`).test(s),
    reason: 'Stop-Process -Name (or its spps/kill alias) kills every process matching that name. '
      + 'Stop only the PID you started: Stop-Process -Id <pid>.',
  },
  {
    name: 'pkill_killall',
    test: (s) => rx(String.raw`^${PREFIX}(pkill|killall)\b`).test(s),
    reason: 'pkill/killall matches processes by name or pattern across the whole machine. Kill '
      + 'only the PID you started, or use the tool\'s own stop command.',
  },
  {
    name: 'kill_mass_signal',
    test: (s) => rx(String.raw`^${PREFIX}kill\b`).test(s) && rx(String.raw`(^|\s)-1(\s|$)`).test(s),
    reason: 'kill ... -1 sends a signal to every process the caller can reach. Kill only the PID '
      + 'you started: kill <pid>.',
  },
  {
    name: 'shutdown_reboot',
    test: (s) => rx(String.raw`^${PREFIX}(shutdown|reboot|poweroff|halt)(?:\.exe)?\b`).test(s)
      || rx(String.raw`^${PREFIX}(restart-computer|stop-computer)\b`).test(s),
    reason: 'This restarts or powers off the whole machine, not just your process. Stop only '
      + 'what you started, or use the tool\'s own stop command.',
  },
  {
    name: 'wmic_process_delete',
    test: (s) => rx(String.raw`^${PREFIX}wmic(?:\.exe)?\b`).test(s)
      && rx(String.raw`\bprocess\b`).test(s)
      && rx(String.raw`(delete\b|call\s+terminate\b)`).test(s),
    reason: 'wmic process ... delete/call terminate kills by name/filter across the machine. '
      + 'Kill only your PID: taskkill /PID <pid> /F.',
  },
];

/**
 * classifyCatastrophic(command) -> {deny: boolean, rule: string|null, reason: string|null}
 * Pure function, no I/O. Deny if ANY chained/wrapped segment matches a catastrophic rule.
 */
function classifyCatastrophic(command) {
  const raw = String(command == null ? '' : command);
  const segments = getAtomicSegments(raw, 0);
  for (const seg of segments) {
    for (const rule of COMPOSITE_RULES) {
      if (rule.test(seg)) return { deny: true, rule: rule.name, reason: rule.reason };
    }
    const stages = splitPipeline(seg);
    for (const stage of stages) {
      for (const rule of ANCHORED_RULES) {
        if (rule.test(stage)) return { deny: true, rule: rule.name, reason: rule.reason };
      }
    }
  }
  return { deny: false, rule: null, reason: null };
}

module.exports = { classifyCatastrophic };
