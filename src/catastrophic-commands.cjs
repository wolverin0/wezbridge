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
 *
 * T-0602: classifyCatastrophic(command, context) takes an optional second, pure (no I/O) context
 * arg `{ cwd, sessionId }` — the caller's worktree cwd and Claude Code session id, both of which
 * the PreToolUse hook payload already carries — and additionally denies (a) recursive deletes
 * (`rm -r/-rf/-fr`, PowerShell `Remove-Item -Recurse`/aliases, `rmdir /s`, `rd /s`) that hit the
 * shared scratch root T:/claudecodetemp (any spelling), the shared claude/ session dir and its
 * direct children, another session's own scratchpad subtree, bare `~`, or a filesystem/drive
 * root; and (b) any mutating `git stash` form (push/save/pop/apply/drop/clear/-u), while still
 * allowing `git stash list|show`. Root cause this guards against: a verifier ran
 * `rm -rf /t/claudecodetemp` (root of every session's scratchpad/task-output/ad-hoc worktrees);
 * separately, 5 agents ran bare `git stash` despite prose bans (the stash stack is shared across
 * worktrees/sessions). See _intel/briefs/2026-09-24-T0602-guard.md.
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

/** Quote-aware whitespace tokenizer (argv-like); used by the T-0602 recursive-delete extractor. */
function tokenize(str) {
  return splitTopLevel(str, (s, i) => (/\s/.test(s[i]) ? 1 : 0));
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
  {
    name: 'git_stash_mutating',
    test: (s) => {
      const m = s.match(rx(String.raw`^${PREFIX}git\s+(?:-C\s+\S+\s+)?stash\b(.*)$`, 'is'));
      if (!m) return false;
      const sub = (m[1] || '').trim().split(/\s+/)[0] || '';
      return sub !== 'list' && sub !== 'show';
    },
    reason: 'git stash is a stack SHARED across worktrees/sessions — push/pop/apply/drop/clear '
      + 'can silently consume or discard another session\'s work. Commit a WIP commit instead '
      + '(git add -A && git commit -m wip); revert with git checkout -- <file>.',
  },
];

// --- T-0602: recursive delete of the shared scratch root / claude/ session dir -----------------

const TEMP_ROOT_RE = /^t:\/claudecodetemp$/;
const CLAUDE_DIR_RE = /^t:\/claudecodetemp\/claude$/;
const CLAUDE_DIRECT_CHILD_RE = /^t:\/claudecodetemp\/claude\/[^/]+$/;
const CLAUDE_DEEP_RE = /^t:\/claudecodetemp\/claude\/[^/]+\/[^/]+(\/.*)?$/;
const FS_ROOT_RE = /^\/$|^[a-z]:\/?$/;
const BARE_HOME_RE = /^~[\\/]?$/;
const DEL_PROGRAMS = new Set(['rm', 'remove-item', 'ri', 'del', 'rmdir', 'rd']);

/** Lowercase, slash-normalized, quote-stripped path; WSL/git-bash drive mounts (/t, /mnt/t) -> t:. */
function normalizePath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  if (!p) return '';
  if ((p.startsWith('"') && p.endsWith('"') && p.length > 1) || (p.startsWith("'") && p.endsWith("'") && p.length > 1)) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\*$/, '');
  if (p.length > 1) p = p.replace(/\/$/, '');
  p = p.toLowerCase();
  let m = p.match(/^\/mnt\/([a-z])(\/.*)?$/);
  if (m) return `${m[1]}:${m[2] || ''}`;
  m = p.match(/^\/([a-z])(\/.*)?$/);
  if (m) return `${m[1]}:${m[2] || ''}`;
  return p;
}

function isAbsoluteNorm(p) {
  return /^[a-z]:/.test(p) || p.startsWith('/');
}

function joinPath(base, rel) {
  if (!base) return null;
  const b = base.replace(/\/$/, '');
  const r = String(rel || '').replace(/^\.\//, '').replace(/^\//, '');
  return r ? `${b}/${r}` : b;
}

/** Resolve a raw shell path token to a normalized absolute-ish path, or null if it can't be
 * resolved (relative path with no known tracked cwd) — callers must not guess in that case. */
function resolveTarget(rawTarget, trackedCwd) {
  const t = normalizePath(rawTarget);
  if (!t) return null;
  if (isAbsoluteNorm(t)) return t;
  if (trackedCwd) return joinPath(trackedCwd, t);
  return null;
}

function isRecursiveFlag(tok) {
  const t = tok.toLowerCase();
  if (t === '/s') return true;
  if (t === '--recursive') return true;
  if (/^-rec[a-z]*$/.test(t)) return true; // PowerShell -Recurse and abbreviations
  if (t.startsWith('--')) return false;
  if (/^-[a-z]*r[a-z]*$/i.test(t)) return true; // -r, -R, -rf, -fr, ...
  return false;
}

/** A "flag-shaped" token: dash-prefixed, or cmd.exe short slash flags (/s, /q, /f, ...). A bare
 * `/` or a longer `/path/like/this` is NOT flag-shaped — it's a delete target. */
function looksLikeFlag(tok) {
  if (tok.startsWith('-')) return true;
  return /^\/[a-zA-Z]{1,2}$/.test(tok);
}

/** Returns the list of delete-target tokens if `stage` is a recursive delete invocation
 * (rm/Remove-Item/ri/del with -r/-rf/-Recurse, or rmdir/rd/del with /s); null otherwise. */
function extractRecursiveDeleteTargets(stage) {
  const toks = tokenize(stage);
  if (!toks.length) return null;
  let idx = 0;
  if (/^sudo$/i.test(toks[0])) idx = 1;
  const progTok = toks[idx];
  if (!progTok) return null;
  const prog = progTok.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (!DEL_PROGRAMS.has(prog)) return null;
  let recursive = false;
  const targets = [];
  for (const t of toks.slice(idx + 1)) {
    if (looksLikeFlag(t)) {
      if (isRecursiveFlag(t)) recursive = true;
      continue;
    }
    targets.push(t);
  }
  return recursive ? targets : null;
}

/** True if `rawTarget` resolves to the shared temp root/claude dir, a foreign session's
 * scratchpad, a filesystem/drive root, or bare `~` — and is NOT inside the caller's own
 * worktree/cwd or own session-scoped scratchpad (per `context = { cwd, sessionId }`). */
function isDangerousTarget(rawTarget, trackedCwd, context) {
  const raw = String(rawTarget || '').trim();
  if (BARE_HOME_RE.test(raw)) return true;
  const resolved = resolveTarget(raw, trackedCwd);
  if (!resolved) return false; // unresolvable relative path (no tracked cwd) — don't guess
  if (FS_ROOT_RE.test(resolved)) return true;
  if (TEMP_ROOT_RE.test(resolved)) return true;
  if (CLAUDE_DIR_RE.test(resolved)) return true;
  if (CLAUDE_DIRECT_CHILD_RE.test(resolved)) return true;
  const ownCwd = context && context.cwd ? normalizePath(context.cwd) : null;
  if (ownCwd && (resolved === ownCwd || resolved.startsWith(`${ownCwd}/`))) return false;
  const sid = context && context.sessionId ? String(context.sessionId).toLowerCase() : null;
  if (sid) {
    const escaped = sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ownScratch = rx(String.raw`^t:/claudecodetemp/claude/[^/]+/${escaped}(/.*)?$`);
    if (ownScratch.test(resolved)) return false;
  }
  // Deeper than a direct child of claude/ (i.e. looks like <slug>/<session-id>/...): only deny as
  // "someone else's session" when we actually KNOW our own session id and it didn't match above —
  // without a sessionId we cannot tell this apart from the caller's own scratchpad, and the brief
  // requires NOT blocking rm -r generally when own-scope can't be determined.
  if (sid && CLAUDE_DEEP_RE.test(resolved)) return true;
  return false;
}

/**
 * classifyCatastrophic(command, context?) -> {deny: boolean, rule: string|null, reason: string|null}
 * Pure function, no I/O. Deny if ANY chained/wrapped segment matches a catastrophic rule.
 * `context = { cwd, sessionId }` (both optional) scopes the T-0602 recursive-delete rule to the
 * caller's own worktree/scratchpad; `cd <dir>` segments update the tracked cwd for later segments
 * in the same chained command (e.g. `cd /t && rm -rf claudecodetemp`).
 */
function classifyCatastrophic(command, context) {
  const ctx = context || {};
  const raw = String(command == null ? '' : command);
  const segments = getAtomicSegments(raw, 0);
  let trackedCwd = ctx.cwd ? normalizePath(ctx.cwd) : null;
  for (const seg of segments) {
    for (const rule of COMPOSITE_RULES) {
      if (rule.test(seg)) return { deny: true, rule: rule.name, reason: rule.reason };
    }
    const stages = splitPipeline(seg);
    for (const stage of stages) {
      for (const rule of ANCHORED_RULES) {
        if (rule.test(stage)) return { deny: true, rule: rule.name, reason: rule.reason };
      }
      const delTargets = extractRecursiveDeleteTargets(stage);
      if (delTargets) {
        for (const target of delTargets) {
          if (isDangerousTarget(target, trackedCwd, ctx)) {
            return {
              deny: true,
              rule: 'recursive_delete_shared_or_foreign_path',
              reason: `Recursive delete of "${target}" resolves outside your own worktree/scratchpad `
                + 'and can hit shared scratch space (T:/claudecodetemp) used by every session/worktree. '
                + 'Delete only inside your own worktree, or your own scratchpad subtree '
                + '(T:/claudecodetemp/claude/<project>/<your-session-id>/scratchpad/...).',
            };
          }
        }
      }
    }
    const cdMatch = seg.match(rx(String.raw`^${PREFIX}cd\s+(.+)$`, 'is'));
    if (cdMatch) {
      const resolved = resolveTarget(cdMatch[1].trim(), trackedCwd);
      if (resolved) trackedCwd = resolved;
    }
  }
  return { deny: false, rule: null, reason: null };
}

module.exports = { classifyCatastrophic };
