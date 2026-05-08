#!/usr/bin/env bash
# OmniClaude supervisor — keeps the session alive 24/7.
#
# This launches TWO things:
#   1. telegram-streamer.cjs as a BACKGROUND process (always-on)
#   2. claude --channels ... as the foreground OmniClaude session
#
# When Claude dies, we kill the streamer and restart both together.
# This way the streamer is always in sync with Claude's lifecycle and
# doesn't depend on Claude's Monitor tool launching it.
#
# Usage:
#   bash scripts/omniclaude-forever.sh        # from the wezbridge repo root
#
# Environment overrides:
#   OMNI_DIR   — directory the OmniClaude session runs from (default: ../omniclaude
#                relative to this repo, override if you keep the omniclaude project
#                somewhere else)

set -e

# Resolve repo root from the script's own location so this works on any clone.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEZBRIDGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OMNI_DIR="${OMNI_DIR:-$(cd "$WEZBRIDGE_DIR/../omniclaude" 2>/dev/null && pwd || echo "$WEZBRIDGE_DIR/../omniclaude")}"
STREAMER_SCRIPT="$WEZBRIDGE_DIR/src/telegram-streamer.cjs"

echo "[omniclaude-forever] Starting supervisor loop..."
echo "[omniclaude-forever] Working dir: $OMNI_DIR"
echo "[omniclaude-forever] Streamer: $STREAMER_SCRIPT"
echo "[omniclaude-forever] Press Ctrl+C to stop permanently."
echo ""

# Cleanup function — kill streamer on any exit
STREAMER_PID=""
cleanup() {
  if [ -n "$STREAMER_PID" ] && kill -0 $STREAMER_PID 2>/dev/null; then
    echo "[omniclaude-forever] Killing streamer (pid $STREAMER_PID)..."
    kill $STREAMER_PID 2>/dev/null || true
    wait $STREAMER_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

while true; do
  echo "[omniclaude-forever] $(date '+%Y-%m-%d %H:%M:%S') — Launching streamer + OmniClaude..."

  cd "$OMNI_DIR"
  export PATH="$APPDATA/npm:$PATH"

  # Launch streamer as background process
  # Ensure logs dir exists
  mkdir -p "$WEZBRIDGE_DIR/logs"
  # Spawn streamer with nohup to fully detach from this shell's job control
  # Redirect both stdout and stderr to the log file
  nohup node "$STREAMER_SCRIPT" >> "$WEZBRIDGE_DIR/logs/streamer.log" 2>&1 &
  STREAMER_PID=$!
  sleep 1
  if kill -0 $STREAMER_PID 2>/dev/null; then
    echo "[omniclaude-forever] Streamer started (pid $STREAMER_PID)"
  else
    echo "[omniclaude-forever] WARNING: Streamer failed to start! Check logs/streamer.log"
    tail -5 "$WEZBRIDGE_DIR/logs/streamer.log" 2>/dev/null || echo "(no log yet)"
  fi

  # ALWAYS use --continue. Previous design did fresh-start after 12h timeout
  # to "clean the slate" but in practice that destroys all OmniClaude context
  # (active tasks, monitor state, learned patterns) — Claude compacts on its
  # own when context fills, no need to force a fresh slate. The active_tasks.md
  # file + MemoryMaster claims provide durable cross-session memory.
  CONTINUE_FLAG="--continue"
  if [ "${LAST_EXIT:-0}" -eq 124 ]; then
    echo "[omniclaude-forever] Resuming previous session (12h timeout last time, but --continue preserves ctx)"
  else
    echo "[omniclaude-forever] Resuming previous session"
  fi

  # Launch Claude in foreground (blocks until it exits)
  timeout 43200 claude \
    --channels plugin:telegram@claude-plugins-official \
    --dangerously-skip-permissions \
    $CONTINUE_FLAG \
    && LAST_EXIT=0 || LAST_EXIT=$?

  echo ""
  if [ "$LAST_EXIT" -eq 124 ]; then
    echo "[omniclaude-forever] Session hit 12h timeout — restart will resume via --continue (preserves context)."
  fi
  echo "[omniclaude-forever] $(date '+%Y-%m-%d %H:%M:%S') — Session exited (code $LAST_EXIT)"

  # Kill the streamer before restarting
  if [ -n "$STREAMER_PID" ] && kill -0 $STREAMER_PID 2>/dev/null; then
    echo "[omniclaude-forever] Killing streamer (pid $STREAMER_PID)..."
    kill $STREAMER_PID 2>/dev/null || true
    wait $STREAMER_PID 2>/dev/null || true
  fi
  STREAMER_PID=""

  echo "[omniclaude-forever] Restarting in 10s..."
  echo "[omniclaude-forever] (Ctrl+C now to stop permanently)"
  sleep 10
done
