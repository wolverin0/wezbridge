@echo off
REM ---------------------------------------------------------------------------
REM start-recorder.cmd - start the wezbridge pane recorder (the :4200 daemon).
REM ASCII ONLY: multi-byte chars in batch comments desync cmd's parser under
REM chcp 65001 (see poke-pane.cmd header).
REM
REM WHY THIS EXISTS: the daemon used to auto-start from the Windows Startup
REM folder at logon. But WezTerm does NOT start with Windows, so the daemon
REM always came up to a machine with no panes, failed its first discovery tick,
REM and on 2026-08-13 died without recording anything for 9 hours. A recorder
REM with nothing to record has no reason to be running, so its lifetime is now
REM tied to WezTerm: wezterm/wezbridge.lua calls this on mux-startup.
REM
REM DESPITE THE LEGACY MODULE NAME (dashboard-server.cjs) THERE IS NO DASHBOARD.
REM The browser UI was removed in v3.2.1. What this runs is the pane recorder:
REM a 60s tick appending each pane's cwd/title/state to
REM vault/_wezbridge/session-snapshot.jsonl (24h retention). That file is the
REM only reason a crash is recoverable.
REM
REM ClawTrol is disabled here permanently (operator decision 2026-08-13): it is
REM unused and its outbound sync loop was the 5GB disk-flood source. Disabling
REM by pointing the loader at a path that does not exist leaves the owner-only
REM secret file untouched; delete the set line below to re-enable.
REM ---------------------------------------------------------------------------
setlocal
set "REPO=%~dp0.."
set "LOG=%REPO%\logs\recorder.log"
if not exist "%REPO%\logs" mkdir "%REPO%\logs"

REM Guard: never start a second daemon. A second WezTerm GUI would otherwise
REM race for :4200, and duplicate wezterm-gui processes are already a known
REM cause of CLI timeouts (2026-08-13: Node calls ETIMEDOUT at 25.7s with two
REM GUIs alive, 240ms with one).
netstat -ano -p TCP | findstr /R /C:"127.0.0.1:4200 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [%DATE% %TIME%] recorder already listening on 4200 - not starting a second >> "%LOG%"
  exit /b 0
)

set "WEZBRIDGE_CLAWTROL_ENV=%REPO%\scripts\clawtrol-DISABLED-does-not-exist.env"

cd /d "%REPO%"
echo [%DATE% %TIME%] starting pane recorder >> "%LOG%"
start /B "" node src\dashboard-server.cjs >> "%REPO%\logs\dashboard.log" 2>&1
exit /b 0
