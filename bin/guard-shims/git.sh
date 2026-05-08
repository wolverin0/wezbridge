#!/usr/bin/env bash
# guard-shims/git.sh — destructive-op gate around git
#
# Place this dir on PATH BEFORE the real git so callers hit the shim first.
# The shim consults scripts/command-guard.cjs and either blocks (exit 1) or
# transparently exec's the real git. See docs/PLAN-managed-agents-backfill.md
# task #1.
#
# To install for a session:
#   export PATH="<wezbridge-repo>/bin/guard-shims:$PATH"
#
# To bypass once:
#   WEZBRIDGE_GUARD_OVERRIDE=1 git push origin main

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_JS="$SCRIPT_DIR/../../scripts/command-guard.cjs"

if [[ ! -f "$GUARD_JS" ]]; then
  echo "guard-shim: command-guard.cjs not found at $GUARD_JS — aborting for safety" >&2
  exit 127
fi

# 1. Evaluate the call. command-guard.cjs exits 0 (allow) or 1 (block, with
#    stderr message). We piggyback on its exit code.
if ! node "$GUARD_JS" git "$@"; then
  exit 1
fi

# 2. Find the REAL git, skipping our own shim dir. Iterate $PATH, take the
#    first git that lives outside SCRIPT_DIR. Handles Windows .exe suffix.
REAL_GIT=""
OLD_IFS="$IFS"
IFS=':'
for dir in $PATH; do
  IFS="$OLD_IFS"
  # skip our own shim dir (handle trailing slash + case-insensitive on Windows)
  case "$dir" in
    "$SCRIPT_DIR"|"$SCRIPT_DIR/") continue ;;
  esac
  for candidate in "$dir/git" "$dir/git.exe"; do
    if [[ -x "$candidate" ]]; then
      REAL_GIT="$candidate"
      break 2
    fi
  done
done
IFS="$OLD_IFS"

if [[ -z "$REAL_GIT" ]]; then
  echo "guard-shim: real git not found in PATH (excluding $SCRIPT_DIR) — install git or fix PATH" >&2
  exit 127
fi

# 3. Pass through. exec replaces this shell so signals (Ctrl+C) flow naturally.
exec "$REAL_GIT" "$@"
