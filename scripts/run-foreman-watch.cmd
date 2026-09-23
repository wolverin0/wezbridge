@echo off
REM ---------------------------------------------------------------------------
REM run-foreman-watch.cmd - durable entry point for foreman_watch.py (T-0524).
REM
REM Task Scheduler "WezBridge-ForemanWatch", every 5 minutes. Foreman
REM (scripts\orchestration\foreman.py) is a child of the session that starts
REM it and dies with that session or with PC sleep. This job:
REM   - resumes orphaned supervisions (state in _intel\foreman\<task>.json)
REM     while the ledger card is still running, keeping the original deadline;
REM   - closes state files whose card is no longer running;
REM   - retries undelivered orchestrator notifications (_intel\foreman\outbox.jsonl),
REM     with ntfy fallback after 3 failed attempts when NTFY_TOPIC is set.
REM It never kills a process. No model in this path.
REM
REM Launched hidden via C:\Users\pauol\scripts\run-hidden.vbs reading
REM scripts\run-foreman-watch.cmdline (same pattern as the other wezbridge tasks).
REM
REM ASCII ONLY IN THIS FILE (multi-byte characters desync cmd's batch parser).
REM ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "REPO=%~dp0.."
set "STATE=%REPO%\..\_intel\foreman"
if not exist "%STATE%" mkdir "%STATE%"

REM One log line on EVERY path: a scheduled job that logs nothing is
REM indistinguishable from one that never ran.
echo [%DATE% %TIME%] start >> "%STATE%\watch.log"
python "%REPO%\scripts\orchestration\foreman_watch.py" >> "%STATE%\watch.log" 2>&1
set "RESULT=%ERRORLEVEL%"
echo [%DATE% %TIME%] exit=%RESULT% >> "%STATE%\watch.log"
endlocal & exit /b %RESULT%
