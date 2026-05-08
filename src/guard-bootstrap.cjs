'use strict';
/**
 * guard-bootstrap.cjs — Opt-in PATH-prepend for the destructive-op shims.
 *
 * When the environment variable `WEZBRIDGE_GUARD_SHIMS=1` is set, prepend
 * `<repo>/bin/guard-shims/` to PATH so that subsequent `wezterm cli spawn`
 * calls (and any child process started from this Node process) inherit the
 * shim-first PATH and route `git` / `gh` calls through the guard.
 *
 * Required-once at the top of long-lived servers (`src/dashboard-server.cjs`,
 * `src/mcp-server.cjs`). No-op if the env var is unset or the shim dir is
 * missing. Idempotent — re-requiring the module after PATH already contains
 * the shim dir does not double-prepend.
 *
 * Pairs with:
 *   - scripts/command-guard.cjs (the policy)
 *   - bin/guard-shims/{git,gh}.{sh,cmd} (the shims)
 *   - docs/PLAN-managed-agents-backfill.md task #1 slice 4
 */

const fs = require('node:fs');
const path = require('node:path');

if (process.env.WEZBRIDGE_GUARD_SHIMS === '1') {
  const shimDir = path.resolve(__dirname, '..', 'bin', 'guard-shims');
  if (fs.existsSync(shimDir)) {
    const sep = process.platform === 'win32' ? ';' : ':';
    const current = process.env.PATH || '';
    const parts = current.split(sep);
    // Idempotent: only prepend if not already first
    if (parts[0] !== shimDir) {
      // Remove any later occurrences so the shim dir appears exactly once at the front
      const filtered = parts.filter((p) => p && p !== shimDir);
      process.env.PATH = `${shimDir}${sep}${filtered.join(sep)}`;
    }
    // One-time signal so callers know the bootstrap fired
    if (!process.env.WEZBRIDGE_GUARD_BOOTSTRAPPED) {
      process.env.WEZBRIDGE_GUARD_BOOTSTRAPPED = '1';
      try {
        process.stderr.write(`[guard-bootstrap] PATH prepended with ${shimDir}\n`);
      } catch { /* stderr may be closed in some hosts; non-fatal */ }
    }
  }
}

module.exports = {};
