@echo off
REM start-omniclaude-pane.cmd
REM Launches the OmniClaude pane (Claude Code with the telegram channel plugin
REM bound for inbound DM routing).
REM
REM Pre-flight: kills any STALE bun.exe channel-plugin daemons left over from
REM previous CC sessions. Without this, multiple bun.exe instances race for
REM `getUpdates` and ~75% of inbound DMs end up in ghost daemons. See:
REM   https://github.com/wolverin0/wezbridge/blob/main/docs/SETUP-omniclaude-telegram.md
REM
REM Usage (from inside any wezterm pane, foreground):
REM   scripts\start-omniclaude-pane.cmd
REM
REM Pair the new session: DM your bot, get a 6-char code, run
REM   /telegram:access pair <code>

setlocal

set "WEZBRIDGE_DIR=%~dp0.."

echo [start-omniclaude-pane] Killing any stale bun.exe channel-plugin daemons...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*claude-plugins-official*telegram*' } | ForEach-Object { Write-Host ('  killing PID ' + $_.ProcessId) ; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [start-omniclaude-pane] Launching Claude Code with --channels...
echo.

claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions --continue

endlocal
