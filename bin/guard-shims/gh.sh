#!/usr/bin/env bash
# guard-shims/gh.sh — destructive-op gate around gh (GitHub CLI)
#
# Mirrors git.sh. See that file for full notes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_JS="$SCRIPT_DIR/../../scripts/command-guard.cjs"

if [[ ! -f "$GUARD_JS" ]]; then
  echo "guard-shim: command-guard.cjs not found at $GUARD_JS — aborting for safety" >&2
  exit 127
fi

if ! node "$GUARD_JS" gh "$@"; then
  exit 1
fi

REAL_GH=""
OLD_IFS="$IFS"
IFS=':'
for dir in $PATH; do
  IFS="$OLD_IFS"
  case "$dir" in
    "$SCRIPT_DIR"|"$SCRIPT_DIR/") continue ;;
  esac
  for candidate in "$dir/gh" "$dir/gh.exe"; do
    if [[ -x "$candidate" ]]; then
      REAL_GH="$candidate"
      break 2
    fi
  done
done
IFS="$OLD_IFS"

if [[ -z "$REAL_GH" ]]; then
  echo "guard-shim: real gh not found in PATH (excluding $SCRIPT_DIR) — install gh or fix PATH" >&2
  exit 127
fi

exec "$REAL_GH" "$@"
